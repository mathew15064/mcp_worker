# T1 — Railway One-Click Quickstart: kiểm thử thủ công trên PC

**Phạm vi:** chỉ task T1, commit gốc `9a817baabdaeb6a019083252dac6ca5077257474` (PR tích hợp #30). **Không phải bằng chứng nghiệm thu từ CI.** Mọi thao tác xác minh, build và log phải đến từ Bot Report 2, profile **PC**, Linux x86_64; không dùng VPS staging, Railway production hay GitHub Actions.

## Chạy lại bằng một lệnh

Tại worktree của nhánh `work/quickstart-local-t01`:

```bash
bash scripts/local-verify-quickstart.sh
```

Script từ chối chạy trên branch khác hoặc khi HEAD không xuất phát từ pinned SHA. Script chỉ dùng kho nguồn hiện có, không fetch/push/merge/deploy/publish, không cài toolchain hoặc phần mềm toàn cục. Các bước kiểm tra chạy **tuần tự nhưng độc lập về trạng thái**, thất bại được ghi lại mà không giả vờ rằng các gate sau đã chạy.

Lựa chọn cho môi trường **không có Internet** (cần cache npm đã được chuẩn bị trước):

```bash
LOCAL_VERIFY_NPM_OFFLINE=1 bash scripts/local-verify-quickstart.sh
```

Mặc định, `npm ci` và `npm ci --prefix .railway --ignore-scripts` **có thể truy cập registry để lấy dependencies**. Đây chỉ là tải dependencies về PC, không phải test/deploy lên dịch vụ ngoài PC. Test Railway SDK graph, SQLite, WSS và signing được thiết kế chạy với fixture/loopback local. Khi yêu cầu tuyệt đối không kết nối mạng, bật `LOCAL_VERIFY_NPM_OFFLINE=1`; nếu cache thiếu, ghi FAIL/NOT_TESTED chứ không bỏ qua một cách im lặng.

## Preconditions / quyền hạn

- Node.js **22.x** (theo `package.json`), npm và git; `timeout` từ coreutils. Version các công cụ được ghi trước khi chạy.
- Go **>= 1.24** cho `go test`, `go test -race`, `go vet`, Go build và WSS/Go isolation E2E. Đặt `GOTOOLCHAIN=local`, `GOPROXY=off` để không tự tải toolchain/module. Go 1.22.2 trên PC tại thời điểm kiểm kê **không đạt**; các gate phụ thuộc Go sẽ SKIP nếu không có toolchain hợp lệ. Không tự sửa host, không cài Go globally.
- Docker CLI + daemon chạy được. Offline Docker build sử dụng `--network=none --pull=false` và chỉ thử khi đã cache đủ hai pinned base image của `Dockerfile.railway`. Dockerfile còn có bước `apk`/`npm pack` cần dependency cache; nếu không chạy được offline, ghi FAIL và các Docker runtime gates SKIP. Không build image trên VPS.
- OpenSSL cho E2E WSS và ký số thử nghiệm; Chromium Playwright phải có sẵn đúng revision, không tự chạy `playwright install`.
- Script có thể tạo `node_modules`, `.railway/node_modules`, `dist` và fixture tạm trong **worktree riêng**; Docker gates (nếu đủ điều kiện) dùng image, container và volume thử nghiệm trên PC. Không sử dụng tài nguyên production.
- Không cung cấp secrets, private keys thật, tokens hoặc cấu hình production. Script truyền môi trường tối giản qua `env -i`, không ghi `env`. Signing tests tạo RSA key thử nghiệm trong memory/fixture; **không gọi** `scripts/sign-worker-manifest.sh` để ký bản phát hành.

## Bằng chứng nghiệm thu PC

Mỗi lần chạy tạo thư mục private (quyền `0700`) nằm **ngoài source worktree**:

```text
../mcp_worker_t01_evidence/<UTC>-<HEAD-short>-<PID>/
  metadata.txt           # task, pinned/base SHA, HEAD, nhánh, tool versions, timestamps
  results.tsv            # gate, PASS/FAIL/SKIP/NOT_TESTED, exit code, duration, TAP skip count
  logs/<gate>.log        # tối đa 500 dòng cuối, đã lọc những dòng giống thông tin nhạy cảm
```

Raw log tạm bị xóa sau từng gate; không thu thập môi trường, trace trình duyệt, binaries, signer keys, database, Docker logs chứa secrets, hoặc secrets của người dùng vào bundle nghiệm thu. Bộ lọc chỉ là biện pháp phòng ngừa, **vẫn phải review log trước khi chia sẻ**. `metadata.txt` lưu SHA HEAD thực tế và pinned SHA; nếu commit T1 mới được tạo, HEAD khác pinned base là dự kiến.

Định nghĩa trạng thái:

| Trạng thái | Ý nghĩa |
|---|---|
| **PASS** | Gate thực sự chạy trên PC và exit 0. Nếu TAP có test skipped, `test_skips` ghi rõ; không xem đó là full coverage. |
| **FAIL** | Gate thực sự được gọi nhưng exit khác 0 (kể cả timeout, build thiếu dependency, assertion). |
| **SKIP** | Gate có prerequisite rõ ràng chưa đáp ứng (Go, OpenSSL, Docker image), nên không chạy. |
| **NOT_TESTED** | Chưa chạy do gate nền tảng fail, hoặc ngoài phạm vi offline/PC; không được diễn giải thành PASS. |

Script exit **0** chỉ khi tất cả gate PASS, **1** nếu có FAIL, **3** nếu không FAIL nhưng có SKIP/NOT_TESTED, **2** cho điều kiện bảo vệ không đáp ứng. Tập trạng thái đầy đủ xem `results.tsv`.

## Các gate tương ứng

1. Local repository/workflow-removal guard; `npm ci`; `npm run typecheck`, `lint`, `lint:typed`, `format:check`, `quality:check`, `build`; `npm test`; `npm run test:e2e`.
2. Railway shell syntax; synthetic PR stack checker; SQLite quickstart, platform config, instance isolation và disaster recovery; SDK pinned graph validation (`.railway/validate.ts`, **không** Railway plan/apply); WSS/Go Worker + OAuth PKCE/MCP khi có Go đủ version.
3. Offline signed-installer/checksum/version/rollback unit tests (không tạo release signature); Go test/race/vet/native build (nếu đủ Go); disposable Docker image, Railway Docker config và volume recovery/read-only denial nếu build được image hoàn toàn offline.

Các kiểm tra lịch sử **không** thay bằng giả định: npm audit trực tuyến, live PR ancestry fetch, release/SBOM scan, nền tảng macOS/Windows, upload CI artifact, unsigned cross-platform Worker artifact/publish không phải gate offline đã chạy; chúng được ghi **NOT_TESTED**. MySQL CI service cũng không được tự ý tạo hoặc kết nối production: nếu các bài test phụ thuộc MySQL tự skip, giữ nguyên `test_skips` trong log, không công nhận là nghiệm thu MySQL đầy đủ.

## Kiểm kê và vô hiệu hóa GitHub Actions

Trên pinned base có đúng **7** workflow dưới `.github/workflows/`, tất cả được **xóa trên worktree/branch local để review**, không sửa bất cứ remote branch nào:

| Workflow tại pinned base | Trigger gốc | Hành động tự động quan trọng |
|---|---|---|
| `test.yml` | push, pull_request | Node lint/typecheck/quality/test, npm audit, MySQL service, Playwright browser, Go Linux/macOS/Windows |
| `railway-sqlite-preview.yml` | push, pull_request, workflow_dispatch | Railway SDK/SQLite, Docker image và volume backup/restore |
| `railway-pr-stack-review.yml` | push, pull_request, workflow_dispatch | synthetic ancestry test; live network fetch comparison refs |
| `railway-worker-e2e.yml` | push, pull_request, workflow_dispatch | Go WSS/OAuth/MCP local integration |
| `railway-isolation-recovery.yml` | push, pull_request, workflow_dispatch | Node/Go recovery, Docker isolation, upload TAP |
| `worker-artifact-build.yml` | push, pull_request, workflow_dispatch | Go cross-platform binaries, installer/signing tests |
| `release-verify.yml` | push, pull_request, workflow_dispatch | release verify, SBOM/image scan, artifact upload |

Không có `dependabot.yml` hay cấu hình GitHub automation khác trong `.github/` tại pinned base (chỉ còn issue templates sau khi xóa workflows). Lệnh kiểm kê read-only tại base: `git ls-tree -r --name-only 9a817baabdaeb6a019083252dac6ca5077257474 .github/workflows`. Kiểm chứng tại nhánh T1: `git ls-files .github/workflows` sau commit và `find .github/workflows -type f` (nếu folder đã bị xóa, không có file).

**Ranh giới thay đổi:** thao tác xóa workflow trên branch local không làm dừng GitHub Actions đã/đang cấu hình trên remote base và **không phải bằng chứng chúng đã tắt ở GitHub**. Không push hay tạo/merge PR để tránh tự kích hoạt lại workflow. Trước mọi quyết định tích hợp, chủ dự án cần review cách tắt Actions ở GitHub repository settings bằng quyền phù hợp, ngoài phạm vi T1.

## Chạy từ Bot Report 2 / báo cáo

Trong Bot Report 2 chọn đúng profile **PC** và chạy `bash scripts/local-verify-quickstart.sh` tại worktree T1. Khi chạy xong, thu từ PC `metadata.txt`, `results.tsv`, các `logs/*.log` đã được review và đối chiếu với SHA thực tế. Không sử dụng GitHub Checks, CI cũ hay VPS staging làm bằng chứng.

Ghi report: `Task ID | Status | Changes | Local branch/commit/patch | PC environment | Local tests/evidence | Risks/blockers`. T1 không sửa file T2–T5; không deploy, merge hoặc publish.
