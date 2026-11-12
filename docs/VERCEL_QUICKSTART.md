# Vercel two-screen Quickstart (BETA)

> DEVELOPMENT PREVIEW ONLY — not ready for production. Real Worker WebSocket, OAuth, provider integration and signed installer tests remain required.

## 1. Deploy with Vercel

[**Deploy private mcp_worker (beta)**](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fmathew15064%2Fmcp_worker%2Ftree%2Ffeature%2Fvercel-selfhost-20261112&project-name=mcp-worker-private&repository-name=mcp-worker-private&env=MCP_SETUP_SECRET&envDescription=Enter+one+freshly+generated+private+43-character+base64url+key.+Keep+it+in+your+password+manager%3B+it+protects+your+independent+instance.&envLink=https%3A%2F%2Fgithub.com%2Fmathew15064%2Fmcp_worker%2Fblob%2Ffeature%2Fvercel-selfhost-20261112%2Fdocs%2FVERCEL_QUICKSTART.md&products=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22neon%22%2C%22integrationSlug%22%3A%22neon%22%7D%2C%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22upstash-kv%22%2C%22integrationSlug%22%3A%22upstash%22%7D%5D)

This button clones the Vercel feature branch (not main). The deploy screen requests:

- Neon PostgreSQL, owned by the new Vercel user.
- Upstash Redis, owned by the new Vercel user.
- One private `MCP_SETUP_SECRET` value typed **in the Deploy form**, not later in Project Settings.

The providers inject Postgres/Redis credentials; do not manually copy database URLs.
Review and approve provider pricing/terms. Resource provisioning requires user
consent and cannot be done anonymously or for free on every plan.

Generate your own 43+ character **random base64url** setup secret with a trusted
password manager (alphabet A-Z, a-z, 0-9, underscore, dash). If you already
have Node.js, use `node -p "require('node:crypto').randomBytes(32).toString('base64url')"`.
Save the generated value in your password manager before continuing.
Never commit the value or place it in a link, URL or chat.

## 2. Secure Setup

Open your new deployment at `/setup` and enter **the same private setup key**
plus an Admin password (minimum 14 characters). The service verifies ownership,
migrates the new Neon database, saves a salted bcrypt Admin hash, and locks
future owner claims. Afterwards log in at `/login`, add an OAuth Client and
enroll a Worker.

The same key derives independent session and encryption keys for your clone.
**Do not rotate or lose it without a deliberate key migration.** Existing
Vercel Project secrets must never be copied from the original author's server.

### If a provider is not connected

The app displays a locked prerequisite page, not a public Admin. Check
Vercel Project → Integrations / Storage. Confirm Neon and Upstash were
approved for **your** new project and redeploy if Vercel injected new variables.
If the Vercel URL is missing, verify the project exposes system environment
variables. No database URL needs to be typed into the app.

### Verify the new instance

After approving the Marketplace resources and completing owner setup, run the
read-only acceptance probe from the checked-out repository:

```sh
node scripts/check-vercel-quickstart.mjs https://YOUR-NEW-PROJECT.vercel.app
```

The probe intentionally does not create resources, submit secrets or install a
Worker. It reports which acceptance prerequisites are missing. Follow
[the full Quickstart acceptance checklist](VERCEL_QUICKSTART_ACCEPTANCE.md)
before declaring the two-screen workflow production-ready.

### Release boundary

This is a beta template to validate deploy ergonomics, not a supported
production release. The live Vercel Worker reconnect/relay path, OAuth
client flow and versioned, signed Worker binaries still need acceptance
before users should run sensitive workloads.

References: [Vercel Deploy Button](https://vercel.com/docs/deploy-button),
[Deploy Button environment keys](https://vercel.com/docs/deploy-button/environment-variables),
[Marketplace storage](https://vercel.com/docs/marketplace-storage).
