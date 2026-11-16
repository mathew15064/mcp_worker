#!/bin/sh
# All host-like mutations happen inside a disposable, networkless Docker container.
set -eu
root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
docker image inspect node:22 >/dev/null 2>&1 || { echo 'SKIP: node:22 Docker image is not locally cached'; exit 2; }
docker run --rm --pull=never --network=none \
  --mount "type=bind,src=$root/scripts/provision-host-https.sh,dst=/fixture/provision.sh,readonly" \
  --mount "type=bind,src=$root/quick-setup.sh,dst=/fixture/quick-setup.sh,readonly" \
  --entrypoint sh node:22 -ec '
mkdir -p /tmp/fakebin /etc/nginx/sites-available /etc/nginx/sites-enabled \
  /opt/mcp-worker-certbot/venv/bin /etc/systemd/system \
  /var/www/certbot /usr/local/sbin
cat >/tmp/fakebin/nginx <<"MOCK"
#!/bin/sh
case "$1" in
  -t|-s) exit 0 ;;
  -T) printf "include /etc/nginx/sites-enabled/*;\n"; exit 0 ;;
esac
exit 9
MOCK
cat >/tmp/fakebin/ss <<"MOCK"
#!/bin/sh
exit 0
MOCK
cat >/tmp/fakebin/systemctl <<"MOCK"
#!/bin/sh
exit 0
MOCK
cat >/tmp/fakebin/systemd-analyze <<"MOCK"
#!/bin/sh
exit 0
MOCK
cat >/tmp/fakebin/curl <<"MOCK"
#!/bin/sh
out=""
source_script=0
for arg; do
 case "$arg" in
  https://raw.githubusercontent.com/mathew15064/mcp_worker/main/scripts/provision-host-https.sh) source_script=1 ;;
 esac
done
if [ "$source_script" -eq 1 ]; then
  last=""
  for arg; do
    if [ "$last" = -o ]; then out="$arg"; break; fi
    last="$arg"
  done
  [ -n "$out" ] || exit 8
  if [ "${MCPW_TAMPER_HELPER:-}" = 1 ]; then
    printf malicious >"$out"
  else
    cp /fixture/provision.sh "$out"
  fi
  exit 0
fi
for arg; do
 case "$arg" in
  http://*/.well-known/acme-challenge/mcpw-acme-probe-*)
    suffix="${arg##*mcpw-acme-probe-}"
    for dir in /var/www/certbot /var/www/certbot/.well-known /var/www/certbot/.well-known/acme-challenge; do
      [ "$(stat -c %a "$dir")" = 755 ] || exit 7
    done
    [ "$(stat -c %a "/var/www/certbot/.well-known/acme-challenge/mcpw-acme-probe-$suffix")" = 644 ] || exit 7
    printf "mcp-worker-acme-%s\n" "$suffix"
    exit 0 ;;
  https://*) exit 0 ;;
 esac
done
exit 8
MOCK
cat >/tmp/fakebin/openssl <<"MOCK"
#!/bin/sh
printf "X509v3 Subject Alternative Name:\n    IP Address:36.50.27.45, DNS:mcp.example.com, DNS:fresh.example.com\n"
MOCK
cat >/tmp/fakebin/docker <<"MOCK"
#!/bin/sh
case "$1" in
 info|pull) exit 0 ;;
 container|volume) exit 1 ;;
 run) exit 77 ;;
esac
exit 8
MOCK
cat >/opt/mcp-worker-certbot/venv/bin/certbot <<"MOCK"
#!/bin/sh
if [ "$1" = --version ]; then echo "certbot 5.4.0"; exit 0; fi
printf "%s\n" "$*" >>/tmp/mock-certbot-calls
case " $* " in
  *" --staging "*) ;;
  *) [ "${MCPW_FAIL_CERTBOT:-}" != 1 ] || exit 9 ;;
esac
action="$1"; shift
name=""; cfg=""
while [ "$#" -gt 0 ]; do
 case "$1" in
  --cert-name) name="$2"; shift 2 ;;
  --config-dir) cfg="$2"; shift 2 ;;
  *) shift ;;
 esac
done
case "$action" in
 certonly)
  [ -n "$name" ] && [ -n "$cfg" ] || exit 8
  mkdir -p "$cfg/live/$name"
  printf test-cert >"$cfg/live/$name/fullchain.pem"
  printf test-key >"$cfg/live/$name/privkey.pem"
  exit 0 ;;
 delete) exit 0 ;;
esac
exit 9
MOCK
chmod 755 /tmp/fakebin/* /opt/mcp-worker-certbot/venv/bin/certbot
export PATH="/tmp/fakebin:$PATH"
sh /fixture/provision.sh https://36.50.27.45:3443 3333
test -f /etc/nginx/sites-enabled/mcp-worker-*/placeholder 2>/dev/null && exit 3 || :
grep -l "listen 3443 ssl;" /etc/nginx/sites-available/*-https >/dev/null
grep -q -- "--staging" /tmp/mock-certbot-calls
grep -q -- "--preferred-profile shortlived --ip-address 36.50.27.45" /tmp/mock-certbot-calls
grep -q -- "--no-random-sleep-on-renew" /etc/systemd/system/mcp-worker-certbot-renew.service
grep -l "server_name 36.50.27.45;" /etc/nginx/sites-available/*-acme >/dev/null
grep -Fq "shortlived" /etc/mcp-worker/letsencrypt/renewal/*.conf 2>/dev/null || :
test -f /etc/systemd/system/mcp-worker-certbot-renew.service
test -f /etc/systemd/system/mcp-worker-certbot-renew.timer
echo MOCK_IP_ACME_TLS_AND_RENEWAL=PASS
sh /fixture/provision.sh https://mcp.example.com 3334
grep -l "listen 443 ssl;" /etc/nginx/sites-available/*-https >/dev/null
grep -q -- "-d mcp.example.com" /tmp/mock-certbot-calls
grep -l "server_name mcp.example.com;" /etc/nginx/sites-available/*-acme >/dev/null
echo MOCK_HOSTNAME_ACME_TLS=PASS
if sh /fixture/provision.sh https://36.50.27.45:3443 3333 >/tmp/deny.out 2>&1; then exit 5; fi
grep -Eq "already serves|existing Nginx config" /tmp/deny.out
echo EXISTING_SITE_REFUSED=PASS
if sh /fixture/provision.sh https://bad/evil 3333 >/tmp/deny.out 2>&1; then exit 6; fi
grep -q "Invalid host" /tmp/deny.out
echo MALFORMED_ORIGIN_REFUSED=PASS
if MCPW_FAIL_CERTBOT=1 sh /fixture/provision.sh https://failed.example.com:3448 3335 >/tmp/failed-acme.out 2>&1; then exit 10; fi
grep -q "Production ACME issuance failed" /tmp/failed-acme.out
if grep -lr "server_name failed.example.com;" /etc/nginx/sites-available >/dev/null 2>&1; then exit 11; fi
grep -l "server_name mcp.example.com;" /etc/nginx/sites-available/*-https >/dev/null
echo FAILED_ACME_ROLLBACK_PRESERVES_OTHER_SITES=PASS
mkdir /tmp/mcpw-fresh-setup
cd /tmp/mcpw-fresh-setup
if MCP_WORKER_PUBLIC_URL=https://fresh.example.com:3445 MCP_WORKER_SETUP_PORT=3335 \
  MCP_WORKER_IMAGE=fixture-image MCP_WORKER_PULL=always \
  sh /fixture/quick-setup.sh --init >/tmp/quick-auto.out 2>&1; then exit 7; fi
grep -q "Trusted HTTPS provisioned" /tmp/quick-auto.out || { cat /tmp/quick-auto.out; exit 11; }
grep -l "server_name fresh.example.com;" /etc/nginx/sites-available/*-https >/dev/null
test ! -e /tmp/mcpw-fresh-setup/.env.setup
echo QUICK_SETUP_PINNED_HELPER_AUTO_EXECUTION=PASS
mkdir /tmp/mcpw-blocked-setup
cd /tmp/mcpw-blocked-setup
if MCPW_TAMPER_HELPER=1 MCP_WORKER_PUBLIC_URL=https://blocked.example.com:3446 \
  MCP_WORKER_SETUP_PORT=3336 MCP_WORKER_IMAGE=fixture-image MCP_WORKER_PULL=always \
  sh /fixture/quick-setup.sh --init >/tmp/quick-tamper.out 2>&1; then exit 8; fi
grep -q "SHA-256 mismatch" /tmp/quick-tamper.out
if grep -lr "server_name blocked.example.com;" /etc/nginx/sites-available >/dev/null 2>&1; then exit 9; fi
echo TAMPERED_HELPER_REFUSED_BEFORE_EXECUTION=PASS
'
