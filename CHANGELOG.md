# Changelog

## Unreleased — V2 public preparation

Source is prepared for the new MIT repository; no stable release tag or image has been published.

- V2 retains exactly 19 MCP tools, outbound Go Worker, OAuth ownership,
  MySQL and the Admin UI; obsolete game/observer runtime removed.
- Standalone Linux Docker quickstart with a private bundled database,
  loopback web listener, generated secrets and explicit fresh initialization.
- Getting Started checklist and local read-only OAuth/PKCE smoke helper.
- User-mode Worker installer by default; checksum/signature verification,
  previous-binary rollback and identity-preserving Linux lifecycle.
- Release verification, pinned bases, CI runtime alignment, SBOM and
  HIGH/CRITICAL scan gate.
- Go 1.26.10 Worker/gosu builds, npm 11.21.2 with Node 26.13.0, and
  bundled MySQL 8.4.13 derivative without optional MySQL Shell.
- Public quickstart, remote MCP, security, recovery and contribution docs.

Known gates: third-party notices and source obligations, sanitized source audit,
private security contact, native macOS/Windows lifecycle, systemd recovery,
external HTTPS MCP, remote CI and official release signing/publication.
