# Contributing

This repository is the V2 source release candidate. Project source is
licensed under MIT (see LICENSE); third-party license and distribution
obligations remain separate. Stable signed releases require owner approval.

Keep changes focused on the 19-tool V2 coding gateway. Do not add V3
business modules, private deployments, operational data or credentials.
Use a feature branch and a small reviewable change. Explain motivation,
compatibility, risks and test evidence; include a regression test for fixes.

Development prerequisites: Node 26.13.0, npm, Go 1.26.10, Docker/Compose
and browser dependencies. In an isolated checkout:

    npm ci
    npm --prefix worker ci
    npm test
    (cd worker-go && go test -race ./... && go vet ./...)
    npx playwright install chromium
    npm run test:e2e

Use disposable databases/Workers only. The full release verification
requires a clean committed checkout and Docker:

    ./scripts/release-verify.sh

See [release engineering](docs/RELEASE_ENGINEERING.md) for the scan gate.
Never run installer tests on an enrolled host Worker or production DB.
Do not commit generated binaries, env files, private keys, backup files,
reports, screenshots containing credentials or local identity metadata.

Before proposing a release, verify the release checklist, document changes
in CHANGELOG.md, and obtain owner approval. Do not publish tags/images,
change licensing or rewrite existing history without authorization.
