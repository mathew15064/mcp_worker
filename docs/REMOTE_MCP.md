# Remote MCP and ChatGPT connector

The default standalone endpoint is loopback HTTP; a cloud connector cannot
reach it. Do not forward the standalone HTTP port or expose MySQL. Remote
configuration is an advanced deployment, not an automatically enabled
feature. The external HTTPS flow is not yet end-to-end release-certified.

Use a controlled HTTPS hostname with a valid trusted certificate and an
explicit reverse proxy. See [advanced deployment](../DOCKER_DEPLOYMENT.md).
The proxy must forward Host and X-Forwarded-Proto, support WebSocket
upgrades, and permit MCP streaming responses. Restrict direct backend
access to the trusted proxy; set TRUST_PROXY to the actual trusted hop
configuration (not arbitrary Internet clients), COOKIE_SECURE=true, and
configure the public base URL in Admin Settings > MCP. The public base URL
is the HTTPS origin without /mcp; the resource URL includes /mcp. Verify
external reachability and the certificate from an independent network.

Check discovery from a remote machine (replace the example hostname):

    curl -fsS https://bot-report.example.com/.well-known/oauth-protected-resource/mcp
    curl -fsS https://bot-report.example.com/.well-known/oauth-authorization-server

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
runtime_info with empty arguments, and confirm the expected commit and 19
tools in Audit Log. Then verify terminal_list and only the intended Worker
profiles; test a harmless workspace operation before allowing writes or
shell execution. Disable/revoke the client if the configuration is wrong.
For a remote Worker use HTTPS/WSS, not --insecure-http. Local testing does
not establish the remote connector or TLS flow is ready for public use.
