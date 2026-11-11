# Third-party dependency review — V2 public preparation

This is an inventory and provenance review, not a license grant for Bot Report.
The new source repository uses its owner-provided MIT LICENSE; package
metadata is aligned. Third-party distribution notices still require review.

## Node.js

The root npm lock contains 160 non-root entries, all with integrity hashes and
tarball URLs at registry.npmjs.org. The legacy Worker lock contains three MIT
entries with integrity hashes and the same registry origin.

Root lock license declarations: MIT 131, Apache-2.0 6, BSD-3-Clause 5, ISC 10,
BSD-2-Clause 2, MIT OR WTFPL 1, BSD-2-Clause OR MIT OR Apache-2.0 1,
Unlicense 1, missing declaration 3. Installed LICENSE files for the three
undeclared entries (ssh2 1.16.0, buildcheck 0.0.7 and cpu-features 0.0.10)
contain MIT permission terms. expand-template 2.0.3 ships an MIT LICENSE;
tweetnacl 0.14.5 ships the Unlicense. Preserve the original copyright and
license texts when distributing dependencies.

## Go Worker

| Module | Version | License family |
| --- | --- | --- |
| github.com/creack/pty | v1.1.24 | MIT |
| github.com/gorilla/websocket | v1.5.3 | BSD-2-Clause |
| golang.org/x/term | v0.36.0 | BSD-3-Clause |
| golang.org/x/sys | v0.37.0 | BSD-3-Clause |

The module source LICENSE files were reviewed; go mod verify passed.
Go binaries incorporate Go runtime and module code: retain applicable notices
when publishing binaries. Docker base images (Node, Alpine, Go builder, MySQL)
also have their own terms and component notices; this lockfile inventory is not
a full image SBOM or distribution-compliance determination.

## Publication gates still outstanding

- Owner review of copyright attribution and third-party
  notice bundle (including binary/image distributions).
- Independent secret scanner and review of the new source-only history.
  The original development history is not imported.
- Release-time dependency and image vulnerability scans and SBOM.

Dependency license terms are unchanged.

## Bundled MySQL security derivative

The standalone database image retains the pinned MySQL Community Server 8.4
base and entrypoint. The optional mysql-shell RPM is removed. gosu 1.19 is
built from upstream commit 6456aaa0f3c854d199d0f037f068eb97515b7513 with verified
Go module checksums; its upstream LICENSE is copied into the database image.
The Node runtime npm CLI is upgraded to 11.21.2 from an integrity-verified
registry tarball. Image distribution and corresponding license/source notice
obligations remain subject to the owner release review.
