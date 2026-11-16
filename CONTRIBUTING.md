# Contributing

This repository is the V2 source release candidate. Project source is
licensed under MIT (see LICENSE); third-party license and distribution
obligations remain separate. Stable signed releases require owner approval.

Keep changes focused on the 15-tool V2 coding gateway. Do not add V3
business modules, private deployments, operational data or credentials.
Use a feature branch and a small reviewable change. Explain motivation,
compatibility, risks and test evidence; include a regression test for fixes.

Development prerequisites: Node 22, npm, Go 1.26.10, Docker/Compose
and browser dependencies. In an isolated checkout:

    npm ci
    npm test
    (cd worker-go && go test -race ./... && go vet ./...)
    npx playwright install chromium
    npm run test:e2e

Use disposable databases/Workers only. For additional local release
verification, run:

    bash scripts/local-verify-quickstart.sh --targeted

The [release engineering guide](docs/RELEASE_ENGINEERING.md) describes the
opt-in Docker, MySQL, security scan and full PC test gates.
Never run installer tests on an enrolled host Worker or production DB.
Do not commit generated binaries, env files, private keys, backup files,
reports, screenshots containing credentials or local identity metadata.

Before proposing a release, verify the release checklist, document changes
in CHANGELOG.md, and obtain owner approval. Do not publish tags/images,
change licensing or rewrite existing history without authorization.
