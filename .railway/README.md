# T3 — Railway PREBUILT Docker Image template readiness (REVIEW ONLY)

This branch contains an **offline** configuration and local tests, not a
published Railway template. **GitHub repository source is forbidden** because
Railway would remotely build it. The manual Template Composer must select
**Docker Image** and use an independently approved, PC-built immutable
registry **manifest digest** after an expressly authorized future registry
push. There is no existing registry digest or public template URL.

## Code and safety gates

- `railway.ts`: real `railway@3.12.0` offline graph, **one image service**,
  **one 512 MB SQLite volume** at `/app/data`, **one instance**, `/healthz`.
  Image source is deliberately invalid
  `OWNER_APPROVAL_REQUIRED_PREBUILT_IMAGE_DIGEST`; only offline `plan` works.
  Apply, deploy, template and unknown commands fail closed.
- `template-candidate.json`: version 2 *operator checklist*, not import
  schema. Explicit `null` registry manifest, image reference, source
  release approval and template URL. Image auto-updates disabled.
- `verify-release-pin.sh`: prior GitHub-source verifier retired; always
  rejects GitHub as a source. No bypass to a remote Railway build.
- `verify-image-pin.sh`: *read-only* immutable reference format and local
  provenance preflight, **not** live registry digest equivalence or approval.
- `scripts/verify-oci-image-local.sh`: after committed source and PC build,
  verifies Docker local image ID, source SHA/tree OCI labels, platform,
  healthcheck and entrypoint. A Docker local image ID or RepoDigests entry is **not proof of a
  remotely published** registry manifest digest. Runtime UID 1000 and volume safety are tested with Docker.
- `Dockerfile.railway`: locally built with pinned base stages; short
  root volume initializer, then `su-exec node` runs server PID1 UID 1000.
  `MCP_SETUP_SECRET` is required, never has a default; mountinfo guard
  prevents accidental ephemeral SQLite.
- `docs/RAILWAY_QUICKSTART.md`: exact PC test commands, future *manual*
  approved registry publication/verification, Template Composer fields,
  private pilot and public publication procedure.

**No** GitHub push/CI, Docker registry push, Railway CLI apply/deploy/project,
paid resources, template creation/publication or production secrets were used.

Railway docs:
[Create](https://docs.railway.com/templates/create),
[Services](https://docs.railway.com/services),
[Volumes](https://docs.railway.com/volumes/reference),
[Private Registries](https://docs.railway.com/builds/private-registries),
[Publish](https://docs.railway.com/templates/publish-and-share).

## Go/no-go

**REVIEW_ONLY / NOT PUBLISHED** until the owner approves exact release
source+image, registry upload and immutable manifest digest, Railway plan
and spend, private deployment, HTTPS domain, live acceptance, and public
publication **as distinct actions**. Reviewer alone can assign PASS.
