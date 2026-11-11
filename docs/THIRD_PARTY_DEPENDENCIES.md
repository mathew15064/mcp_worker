# Third-party dependency review — V2 public preparation

This is a **candidate inventory and provenance review**, not a license grant
or sign-off for distribution. The repository's owner-provided MIT LICENSE
covers this project's code, not third-party dependencies. Original copyright
and license notices still need to accompany applicable binaries and images.

## Node.js (verified against TS6.3 lockfile on 2026-11-11)

The root `package-lock.json` lists **262 non-root entries**: **156 runtime/non-dev**
and **106 dev-only**. All 262 declare an `integrity` hash and a
`registry.npmjs.org` resolved tarball URL. For the reproducible runtime
package/version/license metadata, regenerate
[the candidate inventory](THIRD_PARTY_RUNTIME_INVENTORY.md) with
`node scripts/generate-third-party-inventory.cjs > docs/THIRD_PARTY_RUNTIME_INVENTORY.md`.

Runtime license declarations (156 entries):

| Declared license family | Runtime count |
| --- | ---: |
| MIT | 130 |
| Apache-2.0 | 3 |
| BSD-3-Clause | 5 |
| BSD-2-Clause | 2 |
| ISC | 10 |
| MIT OR WTFPL | 1 |
| BSD-2-Clause OR MIT OR Apache-2.0 | 1 |
| Unlicense | 1 |
| Missing lockfile license field | 3 |

For all 262 entries including dev-only dependencies the counts are MIT 210,
Apache-2.0 19, BSD-3-Clause 6, BSD-2-Clause 8, ISC 12, MIT OR WTFPL 1,
BSD-2-Clause OR MIT OR Apache-2.0 1, Unlicense 1, BlueOak-1.0.0 1
(`minimatch` 10.2.6; dev-only), and missing metadata 3.

The three missing lockfile license declarations are `ssh2` 1.16.0,
`buildcheck` 0.0.7 and `cpu-features` 0.0.10. Their installed runtime
package directories include LICENSE files containing MIT permission terms.
`expand-template` 2.0.3 has an MIT LICENSE; `tweetnacl` 0.14.5 includes
the Unlicense. A declared SPDX value does not substitute for the
corresponding actual license/copyright text or manual review.

Runtime image spot-check on 2026-11-11: **155 of 156** installed
runtime/non-dev packages have a recognizable LICENSE/NOTICE-like file.
The nested `express-session/node_modules/cookie-signature` 1.0.7 declares
MIT in its package metadata but contains **no LICENSE file**. Retrieve and
verify the matching version's attribution/license terms before publishing
complete notices; do not assume the license file of a different version
applies without verification.

The legacy Node Worker lockfile has three MIT entries; native Go Worker is
the supported default. Audit both when distributing either implementation.

## Go Worker

| Module | Version | License family |
| --- | --- | --- |
| github.com/creack/pty | v1.1.24 | MIT |
| github.com/gorilla/websocket | v1.5.3 | BSD-2-Clause |
| golang.org/x/term | v0.36.0 | BSD-3-Clause |
| golang.org/x/sys | v0.37.0 | BSD-3-Clause |

Module LICENSE files and `go mod verify` were checked in prior preparation.
Final distributed Go binaries must include notices applicable to these
modules and to incorporated Go runtime code.

## Images and database derivative

Docker base images, Node/npm, Alpine and the Go builder have their own terms
and components; the npm lockfile does **not** inventory the full image.
The standalone database image retains MySQL Community Server 8.4 base and
entrypoint, removes optional mysql-shell and builds gosu 1.19 from pinned
upstream commit `6456aaa0f3c854d199d0f037f068eb97515b7513`. The gosu
LICENSE is copied into the image. The Node npm CLI is upgraded to 11.21.2
from an integrity-verified registry tarball.

**Unresolved release blockers:** owner/legal review of required attribution,
the complete license/notice bundle for both images and eight Worker binaries,
and any MySQL derivative distribution/corresponding-source obligations.
Keep final artifact SBOM and vulnerability checks, independent source/history
audit, signing, and distribution approval as separate mandatory gates.
