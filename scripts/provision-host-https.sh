#!/bin/sh
# Host-only TLS provisioning for Quick Setup; downloaded with a pinned SHA-256.
set -eu
umask 077
deny() { echo "Quick Setup HTTPS: $*" >&2; exit 1; }
[ "$#" -eq 2 ] || deny 'Usage: provision-host-https.sh https://HOST[:PORT] BACKEND_PORT'
origin="$1"
backend_port="$2"
[ "$(id -u)" -eq 0 ] || deny 'Auto TLS needs root; run with sudo or choose MCP_WORKER_TLS_MODE=external.'
case "$origin" in https://*) ;; *) deny 'Only HTTPS origins can be provisioned.' ;; esac
authority="${origin#https://}"
case "$authority" in ''|*/*|*'@'*|*'?'*|*'#'*|*'['*|*']'*) deny 'Invalid host or port.' ;; esac
case "$authority" in
  *:*) tls_host="${authority%%:*}"; tls_port="${authority#*:}" ;;
  *) tls_host="$authority"; tls_port=443 ;;
esac
case "$tls_port" in ''|*[!0-9]*) deny 'Invalid HTTPS port.' ;; esac
[ "$tls_port" -ge 1 ] && [ "$tls_port" -le 65535 ] || deny 'Invalid HTTPS port.'
case "$backend_port" in ''|*[!0-9]*) deny 'Invalid backend port.' ;; esac
[ "$backend_port" -ge 1 ] && [ "$backend_port" -le 65535 ] || deny 'Invalid backend port.'
[ "$tls_port" -ne "$backend_port" ] || deny 'TLS listener and backend cannot share a port.'
case "$tls_host" in ''|.*|*..*|-*|*.-*|*-.|*'_'*|*[!a-zA-Z0-9.-]*) deny 'Invalid public host.' ;; esac
printf '%s' "$tls_host" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$' ||
  deny 'Invalid public host.'
is_ipv4=0
if printf '%s\n' "$tls_host" | awk -F. 'NF!=4{exit 1}{for(i=1;i<=4;i++){if($i!~/^[0-9]+$/||$i>255||$i<0)exit 1}}'; then
  is_ipv4=1
  case "$tls_host" in
    0.*|10.*|127.*|169.254.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|192.168.*|224.*|225.*|226.*|227.*|228.*|229.*|23[0-9].*|24[0-9].*|25[0-5].*)
      deny 'IP certificates require a public IPv4 address.' ;;
  esac
elif printf '%s' "$tls_host" | grep -Eq '^[0-9.]+$'; then
  deny 'Malformed IPv4 address.'
fi
for program in curl openssl sha256sum systemctl; do
  command -v "$program" >/dev/null 2>&1 || deny "$program is required."
done
if ! command -v nginx >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 || deny 'Install Nginx manually or use MCP_WORKER_TLS_MODE=external.'
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq nginx python3 python3-venv ca-certificates ||
    deny 'Could not install Nginx/Python on this host.'
fi
nginx -t >/dev/null 2>&1 || deny 'Existing Nginx config is invalid; refusing changes.'
nginx -T 2>&1 | grep -Fq 'include /etc/nginx/sites-enabled/' ||
  deny 'Nginx does not include sites-enabled; use an external proxy.'
if [ "$is_ipv4" -eq 1 ] && [ "$tls_port" -eq 443 ] &&
  command -v ss >/dev/null 2>&1 && ss -ltn | grep -Eq ':443[[:space:]]'; then
  deny 'IP TLS port 443 is already occupied; select MCP_WORKER_HTTPS_PORT=3443.'
fi
if command -v ss >/dev/null 2>&1 && ss -ltn | grep -Eq ":$tls_port[[:space:]]" &&
  ! ss -ltnp | grep -E ":$tls_port[[:space:]]" | grep -q '"nginx"'; then
  deny 'Requested TLS port belongs to a different process.'
fi
if nginx -T 2>&1 | grep -E '^[[:space:]]*server_name[[:space:]]' | grep -Fq "$tls_host"; then
  deny "Nginx already serves $tls_host; use MCP_WORKER_TLS_MODE=external."
fi

id="$(printf '%s' "$tls_host" | sha256sum | cut -c1-12)"
site="mcp-worker-$id"
available=/etc/nginx/sites-available
enabled=/etc/nginx/sites-enabled
http_file="$available/$site-acme"
https_file="$available/$site-https"
http_link="$enabled/$site-acme"
https_link="$enabled/$site-https"
for item in "$http_file" "$https_file" "$http_link" "$https_link"; do
  [ ! -e "$item" ] && [ ! -L "$item" ] ||
    deny "Refusing to overwrite existing Nginx config: $item"
done
cb=/opt/mcp-worker-certbot/venv/bin/certbot
cfg=/etc/mcp-worker/letsencrypt
work=/var/lib/mcp-worker/letsencrypt
logs=/var/log/mcp-worker-letsencrypt
cert_name="mcp-worker-$id"
cert_dir="$cfg/live/$cert_name"
if [ ! -x "$cb" ]; then
  command -v python3 >/dev/null 2>&1 || deny 'Python 3 required.'
  mkdir -p -m 0700 /opt/mcp-worker-certbot
  python3 -m venv /opt/mcp-worker-certbot/venv || deny 'Install python3-venv.'
  /opt/mcp-worker-certbot/venv/bin/pip install --quiet --no-input --retries 2 --timeout 20 'certbot==5.4.0' ||
    deny 'Could not install isolated Certbot.'
fi
"$cb" --version | grep -Eq '^certbot (5[.][4-9][.]|[6-9][.])' ||
  deny 'Certbot 5.4 or newer required.'
for dir in "$cfg" "$work" "$logs"; do mkdir -p -m 0700 "$dir"; done
# ACME challenge directories must be traversable by unprivileged Nginx workers.
for dir in /var/www/certbot /var/www/certbot/.well-known /var/www/certbot/.well-known/acme-challenge; do
  [ ! -L "$dir" ] || deny "Symlinked ACME webroot refused: $dir"
  install -d -m 0755 "$dir"
done
systemctl is-active --quiet nginx || systemctl start nginx || deny 'Nginx cannot start.'

created_http=0
created_https=0
finished=0
cleanup() {
  status=$?
  trap - EXIT
  if [ "$finished" -ne 1 ]; then
    [ "$created_https" -eq 0 ] || rm -f "$https_link" "$https_file"
    [ "$created_http" -eq 0 ] || rm -f "$http_link" "$http_file"
    nginx -t >/dev/null 2>&1 && nginx -s reload >/dev/null 2>&1 || :
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

cat > "$http_file" <<EOF
# mcp_worker managed ACME challenge; no other host is changed.
server {
    listen 80;
    server_name $tls_host;
    server_tokens off;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type text/plain;
        try_files \$uri =404;
    }
    location / { return 404; }
}
EOF
ln -s "$http_file" "$http_link"
created_http=1
nginx -t >/dev/null 2>&1 || deny 'Invalid Nginx HTTP challenge configuration.'
nginx -s reload >/dev/null 2>&1 || deny 'Nginx HTTP challenge reload failed.'
probe_name="mcpw-acme-probe-$id"
probe_path="/var/www/certbot/.well-known/acme-challenge/$probe_name"
printf 'mcp-worker-acme-%s\n' "$id" > "$probe_path"
chmod 0644 "$probe_path"
if ! curl -fsS --noproxy '*' --max-time 8 --resolve "$tls_host:80:127.0.0.1" \
  "http://$tls_host/.well-known/acme-challenge/$probe_name" |
  grep -qx "mcp-worker-acme-$id"; then
  rm -f "$probe_path"
  deny 'HTTP-01 challenge routing failed.'
fi
rm -f "$probe_path"

if [ "$is_ipv4" -eq 1 ]; then
  set -- --preferred-profile shortlived --ip-address "$tls_host"
else
  set -- -d "$tls_host"
fi
# Staging validates incoming port 80 and DNS/IP ownership without production rate limits.
"$cb" certonly --staging --non-interactive --agree-tos --register-unsafely-without-email \
  --webroot -w /var/www/certbot --cert-name "$cert_name-staging" \
  --config-dir "$cfg" --work-dir "$work" --logs-dir "$logs" "$@" ||
  deny 'Staging ACME issuance failed: check DNS and inbound port 80.'
"$cb" certonly --non-interactive --agree-tos --register-unsafely-without-email \
  --webroot -w /var/www/certbot --cert-name "$cert_name" \
  --config-dir "$cfg" --work-dir "$work" --logs-dir "$logs" "$@" ||
  deny 'Production ACME issuance failed.'
"$cb" delete --non-interactive --cert-name "$cert_name-staging" \
  --config-dir "$cfg" --work-dir "$work" --logs-dir "$logs" >/dev/null || :
[ -s "$cert_dir/fullchain.pem" ] && [ -s "$cert_dir/privkey.pem" ] ||
  deny 'Production TLS certificate missing.'
if [ "$is_ipv4" -eq 1 ]; then
  openssl x509 -in "$cert_dir/fullchain.pem" -noout -ext subjectAltName |
    grep -Fq "IP Address:$tls_host" || deny 'TLS certificate IP SAN mismatch.'
else
  openssl x509 -in "$cert_dir/fullchain.pem" -noout -ext subjectAltName |
    grep -Fq "DNS:$tls_host" || deny 'TLS certificate hostname SAN mismatch.'
fi

cat > "$https_file" <<EOF
# mcp_worker HTTPS reverse proxy; preserves other Nginx sites.
server {
    listen $tls_port ssl;
    server_name $tls_host;
    server_tokens off;
    ssl_certificate $cert_dir/fullchain.pem;
    ssl_certificate_key $cert_dir/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    location / {
        proxy_pass http://127.0.0.1:$backend_port;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Forwarded-Host \$http_host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
EOF
ln -s "$https_file" "$https_link"
created_https=1
nginx -t >/dev/null 2>&1 || deny 'Invalid Nginx HTTPS configuration.'
nginx -s reload >/dev/null 2>&1 || deny 'Nginx HTTPS reload failed.'
# TLS peer must match the origin even before the HTTP backend starts (may return 502).
# Nginx reload is asynchronous; do not mistake a brief startup race for bad TLS.
tries=0
until curl -sS --noproxy '*' --proto '=https' --max-redirs 0 --max-time 8 \
  --resolve "$tls_host:$tls_port:127.0.0.1" -o /dev/null "$origin/" 2>/dev/null; do
  tries=$((tries + 1))
  [ "$tries" -lt 8 ] || deny 'HTTPS certificate/port verification failed.'
  sleep 1
done

hook=/usr/local/sbin/mcp-worker-certbot-reload-nginx
service=/etc/systemd/system/mcp-worker-certbot-renew.service
timer=/etc/systemd/system/mcp-worker-certbot-renew.timer
if [ -e "$service" ] || [ -e "$timer" ] || [ -e "$hook" ]; then
  [ -f "$service" ] && [ -f "$timer" ] && [ -x "$hook" ] &&
    grep -Fq "$cfg" "$service" ||
    deny 'Unrelated renewal unit exists; refusing to overwrite it.'
else
  cat > "$hook" <<'HOOK'
#!/bin/sh
set -eu
/usr/sbin/nginx -t >/dev/null
/bin/systemctl reload nginx
HOOK
  chmod 0755 "$hook"
  cat > "$service" <<SERVICE
[Unit]
Description=Renew mcp_worker managed IP/hostname TLS certificates
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
ExecStart=$cb renew --no-random-sleep-on-renew --non-interactive --quiet --config-dir $cfg --work-dir $work --logs-dir $logs --deploy-hook $hook
SERVICE
  cat > "$timer" <<'TIMER'
[Unit]
Description=Check mcp_worker TLS certificates every four hours

[Timer]
OnCalendar=*-*-* 00,04,08,12,16,20:20:00
RandomizedDelaySec=10m
Persistent=true

[Install]
WantedBy=timers.target
TIMER
  systemd-analyze verify "$service" "$timer" >/dev/null ||
    deny 'Invalid systemd renewal units.'
fi
systemctl daemon-reload
systemctl enable --now mcp-worker-certbot-renew.timer >/dev/null ||
  deny 'Cannot enable certificate renewal timer.'
systemctl is-active --quiet mcp-worker-certbot-renew.timer ||
  deny 'Certificate renewal timer is inactive.'
finished=1
trap - EXIT HUP INT TERM
echo "Trusted HTTPS provisioned: $origin (ACME staging/production and renewal timer)."
