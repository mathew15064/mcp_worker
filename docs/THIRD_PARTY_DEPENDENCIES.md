# Third-party dependency review — SQLite-only candidate

This is a **source dependency inventory**, not license approval, distribution authorization or proof of up-to-date vulnerability scanning. The project LICENSE covers its code, not automatically the dependency notices.

The root `package-lock.json` is authoritative for version and tarball integrity metadata. Regenerate the checked-in runtime inventory after dependency changes:

```sh
node scripts/generate-third-party-inventory.cjs > docs/THIRD_PARTY_RUNTIME_INVENTORY.md
```

The standalone server runtime uses Node 22, Express, `better-sqlite3`, the MCP SDK and the other packages listed in `package.json`. **No MySQL driver or database image is distributed by this source.** Build-time npm, TypeScript and native C++ tooling are not present as application runtime CLIs in the final image. The final image also bundles the Go Worker binaries built from `worker-go/go.mod`.

Relevant Go modules include `github.com/creack/pty` (MIT), `github.com/gorilla/websocket` (BSD-2-Clause), `golang.org/x/term` (BSD-3-Clause) and `golang.org/x/sys` (BSD-3-Clause). Version details and actual license files must be checked against the final artifact.

**Release review still needed:** produce and review a complete license/notice bundle for the single app image and bundled Worker binaries, generate a fresh SBOM, run offline or approved online vulnerability scans with a dated advisory database, and confirm signing/distribution approval. Historical reports about separate MySQL images do not apply to this candidate.
