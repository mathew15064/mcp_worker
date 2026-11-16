# Remote MCP and ChatGPT connector

The default standalone endpoint is loopback HTTP; a cloud connector cannot
reach it. Do not forward the standalone HTTP port or expose the SQLite database volume. Remote
configuration is an advanced deployment, not an automatically enabled
feature. The external HTTPS flow is not yet end-to-end release-certified.

Use a trusted HTTPS origin: either an operator-controlled hostname
(`https://mcp.example.com`) or a public IP with an IP-address certificate
(`https://PUBLIC_IP:3443`). The hostname is optional. Certbot 5.4+ supports
IP-address certificate issuance through HTTP-01 webroot with
`--preferred-profile shortlived --ip-address PUBLIC_IP`. An actual
HTTP-01 challenge must be reachable on port 80. Verify with staging first,
then a production certificate, and configure automatic renewal and Nginx
reload; the short-lived IP certificate expires after about six days.
Certbot's nginx installer does not handle IP certificate provisioning.
Quick Setup can now install Nginx, a dedicated IP/hostname TLS virtual
host and an isolated automatic renewal timer on Debian/Ubuntu by default.
It refuses to overwrite existing virtual hosts and requires root for
automatic provisioning. `MCP_WORKER_TLS_MODE=external` keeps operator-managed
Nginx/Certbot/other proxies untouched.
The proxy must forward Host and X-Forwarded-Proto, support WebSocket
upgrades, and permit MCP streaming responses. Restrict direct backend
access to the trusted proxy; set TRUST_PROXY to the actual trusted hop
configuration (not arbitrary Internet clients), COOKIE_SECURE=true, and
configure the public base URL in Admin Settings > MCP. The public base URL
is the HTTPS origin without /mcp; the resource URL includes /mcp. Verify
external reachability and the certificate from an independent network.

### Optional manual IP certificate and reverse proxy (advanced)

The steps below are only required for existing, operator-managed proxies
or unsupported distros; the Debian/Ubuntu standalone Quick Setup script
automates this process when `MCP_WORKER_TLS_MODE=auto` (the default).

After the host has a dedicated HTTP server block for the exact public IP
serving `/.well-known/acme-challenge/` from `/var/www/certbot`, request a
short-lived certificate with an isolated Certbot 5.4+ installation:

```sh
certbot certonly --staging --non-interactive --agree-tos \
  --preferred-profile shortlived --webroot -w /var/www/certbot \
  --ip-address YOUR_PUBLIC_IP
# Confirm the HTTP-01 challenge works; issue production without --staging.
certbot certonly --non-interactive --agree-tos \
  --preferred-profile shortlived --webroot -w /var/www/certbot \
  --ip-address YOUR_PUBLIC_IP
```

The real deployment must configure a dedicated Nginx TLS listener (for
example `:3443`) with this certificate and proxy to
`http://127.0.0.1:3333`. Forward `Host`, `X-Forwarded-Proto: https`,
`X-Forwarded-For` from the real client IP, and WebSocket Upgrade headers;
disable proxy buffering for MCP streaming. Do not replace the catch-all
port 443 virtual host of an unrelated website. The HTTPS proxy must already
answer the expected `/healthz` before cutover of an existing Quick Setup
instance:

```sh
MCP_WORKER_PUBLIC_URL=https://YOUR_PUBLIC_IP:3443 sh quick-setup.sh --https
```

For automatic IP certificate renewal, use a **separate** Certbot renewal
timer/configuration if the host's system Certbot is too old; ensure its
successful-renewal deploy hook tests and reloads Nginx. Confirm certificate
expiry and renewals periodically. Do not mix staging certificates into a
production proxy.

For a hostname, use the same reverse-proxy setup with a hostname SAN
certificate and `MCP_WORKER_PUBLIC_URL=https://mcp.example.com`.
No hostname is required for an IP SAN certificate. The public Worker
signed-release gate is independent and must remain closed until explicitly
approved.

Check discovery from a remote machine (replace the example HTTPS origin;
a hostname or public IP works):

    curl -fsS https://mcp-worker.example.com/.well-known/oauth-protected-resource/mcp
    curl -fsS https://mcp-worker.example.com/.well-known/oauth-authorization-server

Verify that resource, issuer, authorization and token endpoint URLs all
match the intended HTTPS origin. An unauthenticated POST to /mcp must not
execute tools (401 when ready). Keep Admin and user authentication,
rate limits, OAuth consent and CSRF protection intact.

In an MCP-capable client that supports OAuth authorization code with PKCE,
configure the HTTPS /mcp resource URL. For ChatGPT, use the custom MCP
connector/app configuration available in your account/workspace; availability
and interface labels may differ. Obtain the exact OAuth callback URI from
that client configuration. Create an OAuth client in Admin (global) or
the owning user's workspace; register that exact URI, not a guessed
callback and not the local quickstart callback. Give the client the ID and
one-time secret through its private configuration. Select read-only access
initially; use terminal and offline_access only when required. Do not paste
secrets into chat or issue reports.

Approve consent as the correct owner. Refresh the client's tool list, call
runtime_info with empty arguments, and confirm the expected commit and 15
tools in Audit Log. Then verify terminal_list and only the intended Worker
profiles; test a harmless workspace operation before allowing writes or
shell execution. Disable/revoke the client if the configuration is wrong.
For a remote Worker use HTTPS/WSS, not --insecure-http. Local testing does
not establish the remote connector or TLS flow is ready for public use.
