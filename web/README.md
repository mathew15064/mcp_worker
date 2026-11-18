# MCP Worker — Unified UI

The browser application is a **single React + shadcn/ui frontend** for Admin,
User and login/registration/OAuth consent. It retains the original MCP Worker
dashboard palette (dark-first), sidebar layout and same-origin deployment.

## Architecture

- `src/components/ui/` — official shadcn-generated, project-owned Radix components.
- `src/components/app-shell.tsx` — shared desktop/mobile sidebar, header, theme,
  account navigation and role-specific menu items.
- `src/pages/` — Admin and User screens, Workers, Clients, Activity, Settings,
  login/registration and OAuth consent.
- `src/app-context.tsx` and `src/lib/api.ts` — read-only view state and POST
  actions with server-issued CSRF tokens.
- `../src/routes/uiApiRoutes.ts` — same-origin JSON view adapter that calls the
  existing Express services and enforces role/ownership checks.

Business logic, SQLite, OAuth/PKCE, WSS and all 15 MCP tools remain in Express
and the existing services. The React frontend has **no direct database access**
and cannot bypass the server's authorization rules.

## Development

From the repository root:

```sh
npm ci
npm --prefix web ci
npm run build
npm start
```

This serves the integrated bundle on the configured MCP Worker port, usually
`http://127.0.0.1:3333` for local development.

For Vite hot reload, keep the Express backend running on port 3333 and start:

```sh
npm --prefix web run dev
```

Open `http://127.0.0.1:5173/login`. The Vite development server proxies
same-origin API requests and form POST actions to Express while serving SPA
documents locally. Set `MCP_WORKER_UI_BACKEND=http://127.0.0.1:PORT` when
running the backend on another local port.

The root `npm run build` builds the Vite UI into `src/public/ui/` (ignored by
Git) before compiling TypeScript into `dist/`. The production Docker builder
installs both lockfiles, builds the frontend and packages it into the **same**
Express gateway image. No second runtime server is needed.

## Verification

```sh
npm run build
npm run lint:typed
npm --prefix web run lint
node --test --test-concurrency=1 dist/tests/*.test.js
npx playwright test --config dist/playwright.config.js
```

Playwright uses disposable SQLite fixtures; it covers Admin/User navigation,
mobile sidebar, dark/light preference, client creation, one-time credential
disclosure, Worker enrollment, audit filters, registration approval, user
isolation and OAuth consent.

`src/http/pages.ts`, `hostedPages.ts` and the older static browser helpers
are still retained for **non-browser compatibility and historical integration
tests**. Normal browser document requests render one React/shadcn UI through
Express, and no separate legacy dashboard is advertised. Remove compatibility
templates only when their supported non-browser contracts are retired.

**Operational boundary:** This migration is development-only. It does not
change production containers, SQLite schema, OAuth configuration or release
approval for the signed standalone Go Worker.
