# Railway + SQLite private Quickstart — developer beta

One Railway service with one persistent SQLite volume. No Neon, Upstash,
MySQL, PostgreSQL or Redis services are required.

## Owner-approved new instance

1. Create a NEW Railway project; review compute and volume prices.
2. Use the project IaC in .railway/railway.ts after installing its CLI SDK:
   npm install --prefix .railway
   railway link
   railway config plan
   The plan must create only one application and one volume. Only the
   owner may explicitly approve railway config apply.
3. Ensure one replica, /app/data volume, Dockerfile.railway, and the generated
   Railway volume variables. Build and pre-deploy must not write SQLite.
4. Generate a unique setup key in your password manager or locally with:
   node -p "require('node:crypto').randomBytes(32).toString('base64url')"
   Enter MCP_SETUP_SECRET in your new Railway service. Save it privately.
   Never place the value in a link, source code, logs or chat.
5. Enable Public Networking and generate a Railway public hostname.
   RAILWAY_PUBLIC_DOMAIN is used for HTTPS OAuth and Worker URLs. A custom
   hostname is possible by explicitly setting MCP_PUBLIC_BASE_URL.
6. Visit https://YOUR-NEW-HOST/setup. Enter the private key and a separate
   Admin password of at least 14 characters. Login, create an OAuth Client
   and enroll a signed and checksum-verified Worker.

SQLite data, WAL and SHM files must share the same persistent /app/data volume.
One replica only; redeploy may briefly disconnect Worker WebSockets.
The Railway container starts as root only to adjust the mounted directory,
then runs Node as the unprivileged node user.

## Hard acceptance gates before publication

- Independent cold install and restart tests with SQLite integrity checks.
- Real Railway volume + HTTPS + Admin + session + OAuth/PKCE + Worker WSS/MCP.
- Properly signed and versioned Worker binary downloads for Linux/macOS/Windows.
- Two independent instances demonstrate no session, key, Worker or token leakage.
- Tested consistent SQLite backup/restore and Railway volume recovery.
- Full CI, cost limits and security review; no production migration or merge.

This file defines reviewable Railway resources but is NOT a published
Railway Template. Publishing a template or creating a paid project needs
a separate owner approval after live acceptance.

The Railway beta intentionally returns HTTP 503 WORKER_SIGNED_RELEASE_PENDING
on Worker installer and binary download endpoints until the signed release
pipeline and pinned public-key verification are approved. Do not bypass this
by running unsigned binaries on a new production instance.
