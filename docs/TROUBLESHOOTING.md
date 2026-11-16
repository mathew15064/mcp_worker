# Troubleshooting

Use the saved installer environment and project. The examples below use
the default .env.setup and mcp_worker project; substitute the exact values
for an isolated/custom installation.

| Symptom | Check / safe action |
|---|---|
| Missing prerequisite | Install Docker Engine/Compose v2, Git, OpenSSL, flock on the Linux host; verify Docker is running. |
| Port in use | Choose MCP_WORKER_SETUP_PORT before first setup; do not overwrite an existing installation or change its public URL accidentally. |
| Web alive, MCP 503 | Check /readyz and Admin Database state. Initialize only a fresh SQLite volume; do not overwrite a nonempty database. |
| UNCONFIGURED | For a truly fresh installation use ./setup.sh --init on a new project and empty volume. |
| Obsolete bootstrap detected | Fresh installs require a clean SQLite data directory; never reuse an older database configuration or existing project volume implicitly. |
| DEGRADED | Check SQLite file integrity, local disk/volume permissions and schema version; preserve APP_ENCRYPTION_KEY. |
| Login fails | Use the original installer env privately; check cookies, HTTPS/proxy settings and rate limits. |
| MCP 401 / 403 | Check token expiry, client enabled state, consent owner, scopes and profile ownership. Reauthorize; do not bypass auth. |
| Worker offline | Check worker_mcp status, worker_mcp logs, Admin online state, DNS/TLS and outbound WSS. Use explicit loopback HTTP only for local testing. |
| Install checksum/signature failure | Stop; obtain matching artifacts and trusted key from an approved source. Never bypass integrity checks. |
| Worker upgrade failure | Preserve identity/config; check previous runtime and connection. Follow Worker rollback instructions. |
| Lost installer env | Restore the matching env and volumes from backup; do not regenerate secrets. |

Useful local diagnostics (review/redact output before sharing):

    docker compose --env-file .env.setup -p mcp_worker ps
    docker compose --env-file .env.setup -p mcp_worker logs --tail=100 mcp_worker
    curl -fsS http://127.0.0.1:3333/healthz
    curl -fsS http://127.0.0.1:3333/readyz
    worker_mcp version
    worker_mcp status

A process-health success is not database readiness or Worker authentication.
Audit Log and runtime_info provide evidence for authenticated calls. If a
remote connector fails, verify the exact HTTPS origin and callback,
discovery endpoints, proxy WebSocket upgrade and streaming behavior.
Never expose Docker inspect, raw env files, bearer tokens, private keys
or unredacted logs to public issue trackers.

For recovery see [backup and restore](BACKUP_RESTORE.md). For safe shutdown
run setup.sh --down; it retains volumes. Never use down -v, reset database files, or delete data as a generic troubleshooting step.
