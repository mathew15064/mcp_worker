# TypeScript migration

The refactor/typescript branch preserves the V2 protocol and Go Worker. The
first phase enables strict TypeScript with an incremental, mixed-language
build. Only TypeScript files are typechecked; existing JavaScript is copied
unchanged. This is not yet a fully typed codebase.

## Development

Use Node.js 26.13.0 and npm with the committed lockfile.

    npm ci
    npm run typecheck
    npm run build
    npm test
    npm run test:e2e

For a local server, configure the usual environment, run npm run build, then
npm start. npm CLI database/script commands use dist and require a build first.
The Docker build compiles TypeScript in the builder, prunes development
dependencies and runs the compiled server. dist is generated, never committed.
The Go Worker remains unchanged; the Docker Worker downloads retain their
historical identifiers.

## Gates

- TS1: strict compiler, mixed build, typed principal/context/environment,
  compiled regression and browser tests, Docker and GitHub CI.
- TS2: database contracts, adapters, all 13 migrations, all seven repositories, database manager/bootstrap, authentication, session stores, CSRF/session middleware and runtime settings.
- TS3: MCP server/transport and all 19 Zod-typed tools, OAuth token issuance/refresh/revoke, audit capture, Ed25519 Worker authentication, WebSocket broker and execution services.
- TS4: HTTP entrypoints and routes, browser UI scripts, legacy Node Worker agent/CLI/lifecycle and Node administrative scripts (source TypeScript, build emits JavaScript).
- TS5: all tests typed, lint, strict build, full regression, security scans
  and release candidate validation.

No blanket any, ts-nocheck or weakening strict mode for migrated modules.
Keep the 19 tool names, schema contract, OAuth scopes, migration names, Worker
protocol and installer persistence intact. Move one bounded component at a
time, with behavior tests before and after. Main remains unchanged until review.

TS2 keeps the OAuth token formats and scopes, SQL migration identities,
AES-GCM envelope and session cookie name unchanged. The OAuth issuance
service, HTTP routes and other execution/transport services remain JS for TS3/TS4.
The release harness compiles typed tests using the Docker builder and copies
only the test output into an isolated test container.

TS3 keeps the historical tool-schema fingerprint and all 19 tool names,
`bot_report.*` OAuth scopes, Worker Ed25519 signature payload, job/stream wire
fields, lifecycle rollback and revocation semantics. A typed bridge remains for
the legacy SSH transport until TS4; it does not change the Go Worker.

The TypeScript compiler uses `skipLibCheck: true` to work around upstream
MCP SDK declaration-resolution errors under Node16 module mode. This does not
disable `strict` checks for project TypeScript. Do not weaken `strict`, add
`ts-nocheck` or use blanket `any` in newly migrated code.

## TS4 browser and distribution build

The strict TS compiler typechecks browser scripts and the build pipeline emits
plain ES2022 JavaScript assets without CommonJS wrappers for direct browser
script tags. Native Go Worker binaries are built separately and unchanged.
Node Worker legacy agent, CLI and lifecycle sources are TypeScript; the
installer still distributes the compiled agent.js, cli.js and lifecycle.js
at their historical URLs. New local source checkouts should first run
`npm ci` then `npm run build`; the first MCP call helper is
`node dist/scripts/first-mcp-call.js` and the legacy Node Worker entrypoint
is `npm run worker`. Existing Worker settings and persistent state paths stay
unchanged. Never run the legacy Node installer or CLI lifecycle commands on
a production machine during tests.
