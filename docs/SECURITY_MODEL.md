# Security model and operating boundaries

mcp_worker exposes execution authority, not a general security sandbox.
Keep the MCP gateway, OAuth client credentials, Admin account and enrolled
Worker identities within a trust boundary you control.

- The default web listener is loopback-only, with a dedicated MySQL private
  network and no MySQL host port. External access requires an explicit TLS
  proxy configuration, secure cookies and an accurate public origin.
- Admin is infrastructure authority. Database users own separate OAuth
  clients and Worker profiles. The server checks client ownership, scopes,
  profile ownership, token state and disabled accounts on protected calls.
  Do not give untrusted parties an Admin/global client.
- OAuth uses authorization code with PKCE, exact redirect URIs, consent,
  expiring tokens and revocation. The read scope is a starting point, not
  a guarantee that all returned information is nonsensitive. Terminal scope
  permits execution through authorized profiles. Store secrets privately.
- A Worker initiates outbound WSS (loopback HTTP/WS only for explicit local
  development). Its local Ed25519 key signs authentication challenges;
  enrollment tokens are short-lived and one-use. Do not share Worker state.
- Allowed roots constrain path-bearing operations, not arbitrary shell
  commands. Shell opt-in grants the OS user's command authority. Use a
  dedicated unprivileged account, restricted filesystem/network access
  and an independently configured OS/container sandbox when needed.
  Do not run untrusted commands as root. No claim of complete isolation.
- Audit records and logs may include workspace data; restrict access,
  review retention and redact before sharing. Database bootstrap secrets
  are encrypted at rest; the separate application key must be protected.
- Disable/revoke compromised clients and disable affected Workers; isolate
  the host and rotate affected credentials. Preserve evidence privately.
  Local uninstall removes installer-managed state; server-side force removal
  does not prove local runtime deletion. Never use force removal as a
  substitute for securing a compromised host.

Checksums detect corruption; independently trusted manifest signatures
verify artifact authenticity. Official release keys have not been
approved. Do not treat an unsigned local artifact as an authenticated
public release. See [Worker lifecycle](../worker/README.md) and
[release engineering](RELEASE_ENGINEERING.md).

The current release candidate has passed isolated Linux tests and a
HIGH/CRITICAL image scan at the recorded database timestamp. This is
not a security certification, and does not establish native macOS/Windows
installer safety, systemd rollback, or an external HTTPS deployment.
