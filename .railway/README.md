# Railway T02: review-only IaC, NOT a published one-click template

The authoring entrypoint is `.railway/railway.ts`. It describes precisely **one
Node application service + one persistent SQLite volume** at `/app/data`, with
one replica, no managed databases, Redis, Neon or Upstash.

## SDK and read-only verification

- Pinned authoring package: `railway@3.12.0`; CLI must be >= 5.42.1
  (upgrade to the current compatible CLI before use).
- Offline structure tests (no Railway credentials or resources):
  `npm run build && node --test dist/tests/railway-platform-config*.test.js`.
  These tests model the IaC graph with a deliberately small local stub; **they
  are not an SDK/compiler validation or a live Railway plan**.
- Optional isolated Docker integration gate (requires local Docker daemon):
  `RAILWAY_DOCKER_INTEGRATION=1 npm run test`. Tests use disposable Docker
  volumes/containers and remove them at exit. Do not run on production hosts.
- In a separately owner-approved **new linked sandbox Railway environment**,
  install the pinned SDK with `npm install --prefix .railway` and run
  `railway config plan --json`; inspect service, volume and variables before
  approval. The plan is read-only but needs a linked Railway environment.
- **Never use `railway config apply` in CI or this T02 task.** The config
  source branch is T02-only and must be replaced by a reviewed immutable
  release ref before template publication.

## First-time owner UX

1. Owner reviews Railway compute/storage charges and approves a **new** project
   and volume. Neither a live project nor a public Template has been created.
2. Owner supplies a unique, high-entropy `MCP_SETUP_SECRET` service variable
   (43+ base64url characters), keeps it in a password manager, and never
   exposes it in a URL, commit, log, or chat. `preserve()` does **not**
   generate a secret on first deploy. Without one, the app fails closed.
3. Enable Railway Public Networking, generate the HTTPS Railway hostname, and
   let Railway inject `RAILWAY_PUBLIC_DOMAIN`. For a custom verified HTTPS
   hostname, set `MCP_PUBLIC_BASE_URL=https://your-host.example` explicitly.
   A custom domain requires DNS/TLS configuration and may take time to verify.
4. Visit `https://YOUR-HOST/setup` and enter the private setup key and a
   separate Admin password. Login -> Dashboard -> create OAuth Client.
5. Signed Worker enrollment/WSS/MCP remain a distinct release gate:
   installer endpoints currently return 503 pending signed Worker artifacts.

The Dockerfile path is selected through the documented Railway service variable
`RAILWAY_DOCKERFILE_PATH=Dockerfile.railway`; it is not a service `build`
command. `PORT=80` matches both Node and the healthcheck. The script checks
the actual Linux mount table, symlinks and the node user's write access before
starting; a plain ephemeral `/app/data` or forged volume environment variables
cannot satisfy the mount guard.

Railway mounts volumes only at runtime, not at build/pre-deploy. Do not migrate
existing production SQLite files. Volume-backed services have single-instance
availability and potential redeploy downtime. Back up off-volume, test restore
and confirm pricing and Railway's template-composer settings separately.

## Template packaging (not performed)

The IaC file is **not** a Railway Template artifact. In Railway's template
composer, configure one GitHub-sourced app (approved release ref), its
`Dockerfile.railway`, one attached `/app/data` volume, required variables,
public HTTP networking and `/healthz`. The composer supports a generated
secret via template variable functions, but the secret's value must be
recoverable by the owner for private setup; avoid a template that generates an
unrecoverable setup key. Validate a real isolated deploy, signed Worker and
OAuth flows, backup/restore, cost limits and isolation of two fresh instances
**before** publishing. Do not generate or publish a template in T02.

Official references:
- https://docs.railway.com/infrastructure-as-code/reference
- https://docs.railway.com/builds/dockerfiles
- https://docs.railway.com/volumes
- https://docs.railway.com/templates/create
