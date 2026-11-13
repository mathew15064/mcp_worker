# Railway one-click: prebuilt PC image — T3 operator guide (REVIEW ONLY)

**No deployable image reference, Railway project, public template, registry push, or
live URL exists as part of this task.** The checked-in `.railway/template-candidate.json`
is an audited *manual Template Composer checklist*, **not** a Railway import
format. `.railway/railway.ts` uses an intentionally unusable Docker Image
sentinel and rejects every context except offline `plan`.

## Hard source rule

Choose **Docker Image** in Railway Template Composer, **NEVER GitHub Repository**.
A GitHub source causes Railway to perform a remote build, prohibited by the
owner's PC-only build policy. Do **not** enter `RAILWAY_DOCKERFILE_PATH` in the
Railway variables; Dockerfile.railway is for building the prebuilt image on PC
only. Do not run Railway `up`, apply, deploy, CLI template creation or publication
from this checklist.

## 1. Local PC-only source, build and quality gate

On the **PC**, in an isolated clean committed T3 worktree:

```bash
npm ci --offline --prefix .railway
npm ci --offline
.railway/node_modules/.bin/tsx .railway/validate.ts
npm run build
node --test dist/tests/railway-platform-config.test.js
# Set the local tag AFTER committing source; no owner registry destination here.
SOURCE_SHA="$(git rev-parse HEAD)"
SOURCE_TREE="$(git rev-parse HEAD^{tree})"
LOCAL_IMAGE="mcp-worker-t3-local:${SOURCE_SHA:0:12}"
docker build --progress=plain -f Dockerfile.railway \
  --build-arg "BOT_REPORT_GIT_SHA=$SOURCE_SHA" \
  --build-arg "BOT_REPORT_TREE_SHA=$SOURCE_TREE" \
  --build-arg "BOT_REPORT_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -t "$LOCAL_IMAGE" .
bash scripts/verify-oci-image-local.sh "$LOCAL_IMAGE"
bash scripts/test-railway-local.sh "$LOCAL_IMAGE"
RAILWAY_DOCKER_INTEGRATION=1 RAILWAY_TEST_IMAGE="$LOCAL_IMAGE" \
  node --test dist/tests/railway-platform-config-docker.test.js
```

Capture the full source commit SHA, tree SHA, PC Docker image `Id` (config
digest, e.g., `sha256:<64 hex>`), OS/architecture, pinned base images, OCI
labels, test exit codes and `RepoDigests`. **An image config ID, Docker
archive checksum, base-image digest, or a locally minted tag is NOT the
pushed registry manifest digest.** If the registry has not been published
under separate owner authorization, record
`REGISTRY_MANIFEST_DIGEST=NOT_AVAILABLE`; never guess one.

Runtime checks: one service process with PID 1 UID 1000, root-owned volume
initialization followed by `su-exec node`, only /app/data SQLite,
`/healthz=200`, `/readyz=503` before claim, `/setup=200`, Docker
health=healthy, restart persistence and SQLite `quick_check=ok`,
two-volume cross-owner isolation, and refusal on missing/fake/read-only
volume, missing/weak secret, unsafe DB symlinks and wrong path.

## 2. Separate owner-approved image publication (NOT executed in T3)

Approval gate A: owner confirms exact reviewed release source commit/PC image
ID, image contents contain no embedded secrets, registry policy (public
distribution vs private), ownership, image retention, supply-chain audit,
permitted budget, who may push, and authorizes **a single manual upload**.
Confirm GitHub Actions remain disabled; no GitHub source push or CI is needed.
Current T3 worktree SHA alone does not constitute release approval.

With approval only, the operator on the **same PC** signs into an approved
registry, tags the already tested PC image for the approved namespace/version,
then manually runs `docker push`. These are future instructions, **not**
commands to run during REVIEW_ONLY:

```bash
# Placeholder names below must be filled from explicit approval.
# APPROVED_REGISTRY_REPOSITORY is a real registry/repository, not an example.
docker tag "$LOCAL_IMAGE" "$APPROVED_REGISTRY_REPOSITORY:$APPROVED_VERSION"
docker push "$APPROVED_REGISTRY_REPOSITORY:$APPROVED_VERSION"
# Read the real registry manifest/index digest from push and registry API.
docker buildx imagetools inspect "$APPROVED_REGISTRY_REPOSITORY:$APPROVED_VERSION"
```

Approval gate B: record the **actual** full immutable
`registry.example/org/image@sha256:<64 lower-case hex>` from the registry
(the syntax here is demonstrative, **not** an existing image reference);
verify the digest with registry inspection, then **pull that digest on PC**
read-only and compare the pulled Linux amd64 image ID, source revision/tree
OCI labels, entrypoint, healthcheck and dependency provenance to the tested
local image. If any difference, missing platform, unexpected multi-arch
index/manifest, or pull failure occurs, STOP. A mutable tag, `:latest`,
local config digest, unverified repository string or image with unknown
provenance is forbidden. `bash .railway/verify-image-pin.sh
"$IMMUTABLE_REF" "$SOURCE_SHA" "$LOCAL_IMAGE"` checks only *format plus
local source*, not registry equivalence, owner permission or publication.

## 3. Future Railway Template Composer setup — manual, not yet performed

After approval gates A+B and a separate Railway billing/project authorization,
owner/operator navigates **Workspace settings → Templates → New Template**,
adds exactly one service `mcp-worker`, chooses **Docker Image**, and enters
the approved immutable **repository@sha256:digest**, with automatic image
updates disabled. No GitHub repo, branch, source builds, Dockerfile path or
second service. See Railway [Create a Template](https://docs.railway.com/templates/create).

| Field | Actual required configuration |
|---|---|
| Service | `mcp-worker`, Docker Image source by verified manifest digest |
| Replica / deployment | One instance **only**; disable multi-replica scaling; one SQLite writer |
| SQLite volume | Exactly one `sqlite-data` persistent volume, `/app/data`; target 512 MB, owner-selected supported region (candidate `us-west2`) |
| Health | `/healthz`, timeout 120 seconds; HTTP on internal `0.0.0.0:80` |
| Required owner secret | `MCP_SETUP_SECRET` — no default, 32 cryptographically random bytes encoded *canonical base64url*, 43 chars, privately retained |
| Fixed app variables | `NODE_ENV=production`, `MCP_PLATFORM=railway`, `DATABASE_PATH=/app/data/bot_report.sqlite`, `HOST=0.0.0.0`, `PORT=80`, `ADMIN_USERNAME=admin` |
| Volume initializer | `RAILWAY_RUN_UID=0` and `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS=0`; image entrypoint must drop PID1 to UID 1000 |
| Platform supplied | Do **not** manually fake `RAILWAY_VOLUME_NAME`, `RAILWAY_VOLUME_MOUNT_PATH`, or `RAILWAY_PUBLIC_DOMAIN` |
| Networking | HTTP Public Networking with owner-generated **real** HTTPS domain/TLS, verified in pilot |
| Extra services | None: no MySQL, Redis, Postgres, hosted DB or proxy service |

The volume is mounted by Railway as root, which necessitates the short root
entrypoint chown phase. Verify PID1 runs as UID 1000 once started; image
`Config.User=root` is deliberate and **not proof of a non-root application**.
Do not disable entrypoint or set a non-root initializer in Railway. The app
rejects ephemeral storage. Railway documents that volume services **cannot
use replicas** (no horizontal scaling) and may incur brief downtime on
redeploy, even with a healthcheck. Single-instance topology avoids a second
SQLite writer but does **not** promise zero downtime.

For a **public** image registry, verify public image distribution is explicitly
approved and no secrets are inside. For a **private** registry, Railway's
[private-registry credentials](https://docs.railway.com/builds/private-registries)
currently require a **Pro** plan; review paid-plan and hidden credential
implications, do not purchase or supply secrets without owner authorization.
For private-image templates, Railway can store encrypted registry credentials,
but their correct access scope and absence of leaks need a separate check.
Compute/volume/egress/billing plan, spend caps, selected region and service
availability require explicit owner confirmation, not assumed prices.

## 4. Private pilot acceptance — ONLY after separate live approval

The operator may stage the composer draft **without publishing only after
authorization**; creating the draft is not part of this task. Then:

- Verify registry digest pin, image/source identity and permissions; inspect
  that Railway **pulled** the prebuilt image, and did **not build** code.
- Confirm one image service, one volume mounted at `/app/data`, one running
  instance, no external DB, exact region and billing. Check PID1 UID 1000 and
  writable SQLite/WAL/SHM. Stop on any unexpected resource.
- In an **approved private disposable deployment**, confirm actual HTTPS
  certificate/hostname and `/healthz 200`, pre-claim `/readyz 503`,
  `/setup 200`. Generate a unique CSPRNG setup secret; never include it
  in template defaults or reports. Complete claim and verify readiness.
- Inspect canonical OAuth PKCE redirects and first authorized read-only MCP
  `runtime_info`. Signed Worker/WSS remains blocked until T2 owner approval.
- Verify persistent DB data after real Railway restart/redeploy and document
  expected single-volume deployment downtime. Test invalid secret/volume
  controls only in throwaway pilot services, **never production**.
- Require separate owner-authorized encrypted offsite backup, independent
  restoration and key custody before claiming recovery readiness (T4 scope).
  Capture *redacted* evidence and actual template/project URLs only if real.

Owner must explicitly approve registry publishing, billed Railway test use,
domain/HTTPS, and all externally exposed endpoints. No live acceptance result
can be inferred from the PC tests.

## 5. Separate public publication procedure — NOT authorized in T3

After a private pilot passes and the owner signs off on immutable digest,
billing, security, setup/backup/restore documentation and support ownership,
open **Workspace settings → Templates**, inspect the saved draft, click
**Publish**, complete Railway's publication form, and independently verify
the actual generated public template URL, metadata and first-time-owner
deployment behavior. Add a genuine "Deploy on Railway" link only after the
platform returns the real code. No URL, badge target or public template code
has been fabricated here. See [Publish and Share](https://docs.railway.com/templates/publish-and-share).

## Current release gates

**REVIEW_ONLY / NO-GO**: no approved source release SHA or push, no registry
upload or manifest digest, no approved Railway account/billing, no real
HTTPS/domain, no published template, no private pilot, no signed T2 production
worker, no offsite restore, no live OAuth/ChatGPT MCP acceptance. A reviewer,
not the T3 worker, decides PASS.
