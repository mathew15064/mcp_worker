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
- TS2: database contracts, adapters, migrations, repositories, authentication.
- TS3: MCP tools, OAuth, execution services and Worker message protocol.
- TS4: routes, browser scripts, legacy Node Worker and scripts.
- TS5: all tests typed, lint, strict build, full regression, security scans
  and release candidate validation.

No blanket any, ts-nocheck or weakening strict mode for migrated modules.
Keep the 19 tool names, schema contract, OAuth scopes, migration names, Worker
protocol and installer persistence intact. Move one bounded component at a
time, with behavior tests before and after. Main remains unchanged until review.
