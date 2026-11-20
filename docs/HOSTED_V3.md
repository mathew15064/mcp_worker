# Hosted v3 — operator notes

Hosted v3 runs the existing MCP gateway plus an outbound Go Worker in a **separate
Docker container for each approved user**. The gateway never receives the Docker
socket. A user does not need a VPS, Docker installation, or a personal MCP URL.

## User journey

1. Open `/register`. New accounts remain `pending` until approved in
   `/admin/users`; the administrator can close public registration.
2. After approval, sign in at `/login` and open `/account/connect`. Configure
   ChatGPT with the canonical MCP URL `https://36.50.27.45:3443/mcp`.
3. Dynamic OAuth registration creates a **public, read-only client**, using
   authorization-code + PKCE. Shared public client registrations never share
   user tokens or activity.
4. To use terminal tools, the account must additionally have an **isolated,
   attested Worker**, and use a user-owned OAuth client with
   `mcp_worker.terminal` scope. Manual credentials are managed in
   `/account/clients` (advanced). Public DCR clients do not receive
   terminal scope.

## Personal Workers — user-operated machines

An approved account can open `/account/workers?tab=install`, generate its own
one-use token (default TTL 600 seconds), and install the **independently signed
GitHub v2.0.0 Worker** on a machine it controls. The token is shown only once;
the Worker CLI prompts for it without echoing. Do not paste it into command-line
arguments, URLs, shared screenshots or support logs.

`workers.personal_enrollment.enabled` (Admin → Users → Personal Worker enrollment)
controls **future issuance only**; it defaults to on for approved accounts.
Creation is rate limited to five requests per account per hour, with at most
three unexpired tokens and ten Personal Workers per owner. The owner identity
is taken from the authenticated session, and each token is stored as a hash.
Enrollment class is persisted server-side; clients cannot designate a Worker
as Hosted/attested, and pre-existing Workers retain `legacy` mode. Different
accounts can choose the same Worker display name; identities are still distinct.

Personal Worker execution requires an owned OAuth client with
`mcp_worker.terminal` scope and an owned, enabled Personal Worker. Personal
Workers run with the **local OS account's permissions** and are not treated as
isolated containers. Administrative Hosted execution remains a separate global
policy, and no Personal token authorizes a VPS container, Docker socket or
cross-account tool call. Disabling the owning user revokes Worker connections
and blocks outstanding token redemption.

The Gateway-hosted `/worker/install*` and `/worker/dist/*` endpoints remain
HTTP 503; enabling account enrollment is **not** approval to publish an
unsigned binary or change a release signing trust root.

## Operator provisioning

Build the dedicated image on the Docker host:

```sh
docker build -f Dockerfile.hosted-worker -t mcpw-hosted-worker:v3 .
```

After approving the user, obtain their `usr_<UUID>` identity from the Admin
Users action URLs and run the host-only script:

```sh
bash scripts/provision-hosted-worker.sh mcp_worker-server 'usr_<UUID>' mcpw-hosted-worker:v3
```

The script issues a short-lived enrollment token inside the gateway, creates
a dedicated internal Docker network and two named volumes, starts the Worker
as UID 10001 with no Linux capabilities or Docker socket, checks Docker
isolation properties, and attests the broker's live Worker connection.
It refuses to overwrite an already existing Worker identity.

After attestation, enable **Hosted execution** in `/admin/users`.
Execution defaults to off, and only attested profiles under the authenticated
user's ownership are executable. Worker and user status checks remain active.

The tenant network has no external internet access by default. A worker may
execute code within its own `/workspace` volume, but cannot access another
tenant's network or workspace. No hosted app runs Docker-in-Docker.

## Verification and operations

```sh
curl -fsS https://36.50.27.45:3443/readyz
curl -fsS https://36.50.27.45:3443/.well-known/oauth-authorization-server
docker ps --filter label=mcp_worker.hosted=true
```

Disabling a user revokes their OAuth access/refresh tokens and disconnects
their Worker session. The host operator can stop or remove that user's
container explicitly if it should no longer consume resources.

**Limitations:** Per-user provisioning is operator-triggered, not automatic
on approval. Public DCR access is read-only; terminal authorization requires
an advanced user-owned client. Internal-only networks also block package
downloads from the internet until a deliberately reviewed egress policy is
introduced. The independent signed standalone Worker v2.0.0 distribution is
unchanged; hosted containers do not bypass its public release gate.
