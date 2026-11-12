# Vercel Quickstart acceptance — development only

**Never merge PR #14, publish Worker binaries or connect the production service before the full acceptance gate.** This plan does not target alive.locallhost.shop.

## Owner-approved fresh clone

1. Use the beta Deploy Button from the reviewed feature branch. The owner must approve Neon and Upstash products, plans and any costs. Do not provision through automated CI.
2. Check that the new project has its **own** Neon PostgreSQL, Upstash Redis and randomly generated private MCP_SETUP_SECRET. Never reuse source-project tokens or storage.
3. Confirm Vercel injected PostgreSQL and Redis connection variables for the production environment. Redeploy if a new Marketplace resource was just connected.
4. Visit /setup on the new Vercel production URL, enter the same private setup key and a separate Admin password, then verify /setup redirects to /login. Preview setup is intentionally forbidden.

## Read-only acceptance smoke

From the feature-branch checkout:

    node scripts/check-vercel-quickstart.mjs https://YOUR-NEW-PROJECT.vercel.app

This tool only accepts HTTPS root URLs on .vercel.app. It sends unauthenticated GET and HEAD requests. It does **not** claim ownership, submit passwords, run migrations, enroll Workers or provision resources. Protected preview deployments may require Vercel SSO, so use the approved newly cloned instance.

A successful build or a successful read-only probe alone is **not** release acceptance. The Vercel /readyz currently reports 503 until distributed Worker transport acceptance is completed.

## Mandatory end-to-end gates

- Confirm both Marketplace products are selected by the **actual** Deploy Button UI and stored only under the new owner's project; record pricing and environment scope without exposing credentials.
- Secure Setup must accept exactly one valid owner claim, reject wrong keys and repeat claims, allow Admin login, and allow another warm Function to discover the same owner without manual redeployment.
- Create an OAuth Client, test S256 PKCE challenge/verifier, single-use code and refresh token behavior, replay rejection, canonical HTTPS issuer and MCP request.
- Install a verified Linux, macOS and Windows Worker, enroll it with a single-use token, establish outbound WSS, execute a benign MCP command, and test reconnect/lease turnover, timeout, capability denial and queue bounds.
- Version, sign and publish **reviewed** Worker binaries and SHA256SUMS manifest only after explicit release approval. Existing private CI artifacts are checksum-verified, but are **not** a signed public release, so fresh clones cannot yet download an approved executable.
- Deploy a second independent project with distinct Neon, Redis and owner keys; verify no Admin session, OAuth token, Worker identity, queue message or decryption key can cross owners.
- Audit WebSocket Function duration, database limits, Upstash request count, cost caps and secret exposure. No unknown paid resources.

Keep the pull request Draft until every live test above has evidence. This document does not authorize any paid provisioning or release.
