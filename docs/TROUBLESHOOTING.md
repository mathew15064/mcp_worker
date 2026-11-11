# Troubleshooting

Use the saved installer environment and project. The examples below use
the default .env.setup and bot-report project; substitute the exact values
for an isolated/custom installation.

| Symptom | Check / safe action |
|---|---|
| Missing prerequisite | Install Docker Engine/Compose v2, Git, OpenSSL, flock on the Linux host; verify Docker is running. |
| Port in use | Choose BOT_REPORT_SETUP_PORT before first setup; do not overwrite an existing installation or change its public URL accidentally. |
| Web alive, MCP 503 | Check /readyz and Admin Database state. Test the saved connection; do not reset a nonempty source. |
| UNCONFIGURED | For a fresh bundled DB use setup.sh --init; for external DB use Test/Save/Initialize explicitly. |
| CONFIGURED / MIGRATION_REQUIRED | Use Admin database workflow, after a backup; never delete the legacy source to bypass migration. |
| DEGRADED | Check MySQL connectivity, credentials and storage; preserve the original encryption key. |
| Login fails | Use the original installer env privately; check cookies, HTTPS/proxy settings and rate limits. |
| MCP 401 / 403 | Check token expiry, client enabled state, consent owner, scopes and profile ownership. Reauthorize; do not bypass auth. |
| Worker offline | Check systemtd status, systemtd logs, Admin online state, DNS/TLS and outbound WSS. Use explicit loopback HTTP only for local testing. |
| Install checksum/signature failure | Stop; obtain matching artifacts and trusted key from an approved source. Never bypass integrity checks. |
| Worker upgrade failure | Preserve identity/config; check previous runtime and connection. Follow Worker rollback instructions. |
| Lost installer env | Restore the matching env and volumes from backup; do not regenerate secrets. |

Useful local diagnostics (review/redact output before sharing):

    docker compose --env-file .env.setup -p bot-report ps
    docker compose --env-file .env.setup -p bot-report logs --tail=100 bot-report mysql
    curl -fsS http://127.0.0.1:3333/healthz
    curl -fsS http://127.0.0.1:3333/readyz
    systemtd version
    systemtd status

A process-health success is not database readiness or Worker authentication.
Audit Log and runtime_info provide evidence for authenticated calls. If a
remote connector fails, verify the exact HTTPS origin and callback,
discovery endpoints, proxy WebSocket upgrade and streaming behavior.
Never expose Docker inspect, raw env files, bearer tokens, private keys
or unredacted logs to public issue trackers.

For recovery see [backup and restore](BACKUP_RESTORE.md). For safe shutdown
run setup.sh --down; it retains volumes. Never use down -v, migrate reset,
migrate fresh or delete data as a generic troubleshooting step.
