# SuperAgent Release Incident Playbook (Windows, macOS, Linux, Chrome)

Updated: 2026-11-13. This is an **agent-operational runbook**, not an approval to promote a prerelease, restart Core/MCP owners, change OAuth credentials, or publish without the release gates in `.agents/AGENTS.md`.

## Verified baseline and source of truth

- **Current unified release:** [`v1.14.83-rc.2`](https://github.com/RudyCity/superagent/releases/tag/v1.14.83-rc.2), source tag resolves to `8ef9af60cf241d202912f8c85449e3678b124825`. [Native build run 43347832939](https://github.com/RudyCity/superagent/actions/runs/43347832939) produced six successful independent build jobs; its publish job alone failed because Linux files arrived nested under `deb/` and `appimage/`. [Verified recovery run 43350949841](https://github.com/RudyCity/superagent/actions/runs/43350949841) checked the exact immutable tag, successful build jobs, artifact inventory and SHA-256, then published the release successfully.
- **Published inventory:** Windows x64 standalone NSIS `SuperAgent_1.14.83_x64-setup.exe`; macOS ARM64 `.dmg`; Linux x64 `.deb` and `.AppImage`; Delegate `1.10.1` ZIP+receipt; SidePanel `1.0.0` ZIP+receipt; Windows LAN GUI `0.2.0` preview installer; Android LAN `0.10.0-native-dashboard` debug APK + Gradle metadata; `SHA256SUMS.txt`. **12 GitHub assets** are published and verified. This is an **unsigned/unnotarized prerelease**, not a production runtime deployment.
- **Release cleanup:** Five old published releases were deleted after the replacement passed verification, and an earlier LAN draft was already absent. **Historical Git tags and commits were preserved**; their former `/releases/tag/...` pages are not valid installation links. The canonical user download link is the current unified prerelease above.
- **Do not rely on a static version in this guide for future releases:** inspect the exact tag, `package.json`, Tauri/Cargo metadata, run SHA, and GitHub release asset inventory each time. A green CI run, a tag, a successful local build, and a published release are four different states.

## Non-negotiable agent workflow

1. Run `git status --short --branch`, `git rev-parse HEAD`, `git remote -v`, then read `AGENTS.md` and `.agents/AGENTS.md`. Existing dirty files are another owner's work; do not reset, restore, clean, rebase, overwrite, or bulk-stage them. Never create a branch/worktree unless explicitly authorized by the task owner.
2. Read the failure **at the failing job and step**, not from a summary alone: `gh run view <run-id> --repo RudyCity/superagent`, `gh run view <run-id> --repo RudyCity/superagent --log-failed`; retrieve individual job logs when a wrapper hides the underlying error. Capture the exact first decisive error and code.
3. Reproduce on the matching **disposable OS runner**. Native Windows builds require Windows CI/Rust/MSVC, macOS DMG requires macOS ARM64 CI, and Linux AppImage/DEB require Linux x64 CI. A Windows unit test alone cannot certify Linux ELF packaging.
4. Fix only the identified root cause; add a focused regression test. Run targeted Vitest, typecheck/build for source edits, the platform-native packaging smoke, and GitHub CI. Do not waive the failure or fabricate missing assets.
5. For a release, verify tag-to-commit/version parity and every needed job is green. Build extension ZIPs from the **tagged** manifests; validate receipt hashes and ZIP entries; verify actual downloadable assets and `SHA256SUMS.txt`. Report the run ID, release URL, asset names and limitations. Publishing binaries does not authorize stopping/restarting any user's running Core, Tray, MCP, or Delegate.

## Incidents: symptoms, root causes and proven remediations

| Symptom / error | Actual failure | Agent remediation and mandatory evidence |
| --- | --- | --- |
| Windows `bun install -g` or legacy dependency path attempts `better-sqlite3` / `node-gyp rebuild` and fails without MSVC | A legacy Node-native SQLite dependency/prebuilt mismatch, especially on newer Node; a source clone has Tray **source**, not a compiled installer. Current pinned `r-memory` uses Bun's `bun:sqlite`; `better-sqlite3` is optional and is absent from the main lockfile. | Normal users: download the **published Windows NSIS setup**, verify checksum, then install. For developers in the checkout: `bun install --frozen-lockfile`, `bun run build`, `bun run start`; avoid `bun install -g .`. Do **not** require users to install MSVC, globally delete Bun directories, or imply that a source checkout builds native Tray. |
| Linux Tauri says `failed to run linuxdeploy`; direct log says `Could not find dependency: libc.musl-x86_64.so.1` | Bun's frozen production install carries incompatible optional `@img/sharp-linuxmusl-x64` and `@img/sharp-libvips-linuxmusl-x64` binaries into a **glibc** AppDir; linuxdeploy inspects *all* ELF files, not only imported ones. Installing `musl` via apt alone did **not** resolve the packaging failure. | In `scripts/prepare-standalone-unix.ts`, call `scripts/prune-linux-musl-sharp.ts` **only on Linux x64 staging**. Confirm both GNU `sharp` and GNU `libvips` remain. Do not delete source `node_modules` or remove valid GNU addons. |
| Linux `linuxdeploy` says `Failed to run ldd: exited with code 1`, following the sharp fix | Nested `@napi-rs/canvas-linux-x64-musl` (including under other dependencies) remains in the AppDir and fails `ldd`. | Prune *only* musl canvas variants in generated Linux x64 staging, require `@napi-rs/canvas-linux-x64-gnu` counterparts, and smoke-test the actual GNU canvas native binding. |
| Linux `linuxdeploy` still fails at `tokenizers.linux-x64-musl.node` | `tokenizers@0.23.2` ships N-API binaries for many targets in one package, including non-x64 and non-glibc variants. linuxdeploy scans them despite being unused. | Keep `tokenizers.linux-x64-gnu.node` and remove other `tokenizers.*.node` **only inside Linux x64 standalone staging**. Fail closed if the GNU target binary is absent. Smoke-test loading `Tokenizer`; do not blanket-remove tokenizers or delete package JS. |
| `linuxdeploy` stripping errors or FUSE restrictions | linuxdeploy's bundled strip utility and AppImage runtime can be incompatible with the CI host. | On **Linux-only steps**, append `NO_STRIP=true` and `APPIMAGE_EXTRACT_AND_RUN=1` to `$GITHUB_ENV`. Do not put `runner.os` expressions in job-level `env`: GitHub rejected that workflow before scheduling any jobs. These flags alone do **not** fix incompatible native addons. |
| macOS Tauri gets `--bundles ""` | An empty `SUPERAGENT_UNIX_BUNDLE_OVERRIDE` was forwarded as an actual empty argument. | Use `override || bundles` in `scripts/build-standalone-unix.ts`; default to `dmg` on macOS and `deb,appimage` on Linux. A deliberate Linux DEB-only override is **not** acceptable for a full AppImage release. |
| macOS PDF integration test fails in CI but passes in other environments | Temp paths can be aliased (`/var` vs `/private/var`), causing workspace authorization/fixture mismatch; tests sharing persisted permission state can interfere. | Resolve temporary test fixture roots with `realpath`, retain scoped authorization checks, include the actual MCP error payload in assertions, and use `--maxWorkers=1` for affected prerelease tests. Never disable PDF authorization, YOLO boundaries or a failing test as a shortcut. |
| Artifact publication fails despite successful builds | `actions/download-artifact` can preserve nested `deb/` and `appimage/` directories; old extension artifacts may include stale Delegate versions. In run `43347832939`, all six build jobs passed but exact inventory validation rejected the nested Linux files. | Run `scripts/normalize-unified-release-assets.mjs` (strict version-checked flattening) followed by `scripts/verify-unified-release-assets.mjs` (exact 11 input files, receipts and checksums). Stage extension archives only from tagged manifests using `scripts/stage-release-extensions.mjs`; never publish cached ZIPs. The unified release contains **12 public assets including SHA256SUMS.txt**. |
| All tagged native builds pass but publish fails | Publication is independent of compilation and may fail at file selection/provenance. | Prefer the explicit `.github/workflows/recover-unified-release.yml` recovery workflow: it verifies source run ID, exact tag SHA, six successful build jobs, failed publish gate, exact versioned inventory, and SHA-256 before publishing existing artifacts. Never mix runs. The legacy `publish-verified-unix.yml` workflow is **not** acceptable for a full unified release because it lacks current AppImage, Windows, Android, LAN and extension gates. |

## Ubuntu CI media and browser bootstrap (2026-11-13)

Observed in `.github/workflows/bun-runtime.yml` on an Ubuntu 24.04 regression runner: installing `chromium-browser` via apt invoked its Snap Store post-installation step, which repeatedly failed to contact the store. The command masked apt failures with `|| true`; FFmpeg then exited with `libblas.so.3: cannot open shared object file`. Another pending regression step used a retired Vitest flag `--poolOptions.threads.maxThreads`.

Agent fix: install `ffmpeg libblas3 ripgrep` via apt **without** either `chromium-browser` or error-masking fallback; verify the apt `/usr/bin/ffmpeg` and `/usr/bin/ffprobe`, unresolved `ldd` dependencies and an actual H.264 encode/decode probe. Use `browser-actions/setup-chrome@v2` for Chrome for Testing (no Snap), check the actual executable's version plus headless DOM output, and propagate its `chrome-path` as `STUDIO_CHROMIUM_PATH`. Run the regression with supported `--maxWorkers=2 --reporter=dot` only. Regression guard: `tests/bunRuntimeCiDependencies.test.ts`.

**Verification boundary:** Static workflow/tests on Windows do not prove apt, Chrome download, or media playback on Ubuntu CI. Mark the Ubuntu fix verified only after a new real `Bun Runtime Validation` GitHub Actions run passes the media/browser bootstrap and full regression. A failed later application test is a separate finding, not evidence that Snap was installed.

## Native and extension release gates

### Linux and macOS

```bash
bun install --frozen-lockfile
bun run build
bun --bun x vitest run tests/pruneLinuxMuslSharp.test.ts tests/unixStandaloneInstaller.test.ts tests/linuxAppImageRelease.test.ts tests/releaseUnixAppImage.test.ts --maxWorkers=1
bun run tray:test
# Run the following on the matching native CI runner, never as a cross-OS substitute:
cargo build --release --bin superagent --manifest-path apps/superagent-tray/src-tauri/Cargo.toml
bun run installer:prepare:unix
bun run installer:verify:unix
bun run installer:package:unix
bash scripts/verify-packaged-standalone-unix.sh
```

For the **full** Linux release, the verifier requires both `.deb` and `.AppImage`. It extracts the AppImage and the DEB, checks the bundled native `superagent` and `bun` paths and Core entrypoint, then runs `superagent --version` without globally installed Bun/Node. The macOS verifier mounts the *actual* DMG and checks `.app` resources and the CLI. A local `cargo check` is not a substitute for these packaging checks.

### Chrome extensions

```bash
bun run verify:extension-js
bun scripts/release-delegate.mjs
bun scripts/release-sidepanel.mjs
bun scripts/verify-release-extensions.mjs
bun scripts/stage-release-extensions.mjs
```

Always stage into an **empty, newly prepared release staging directory** and retain both ZIP receipts. Delegate (`chrome-extension-delegate/`) and SidePanel (`chrome-extension/`) are separate Manifest V3 extensions. Publish their ZIP files as *unpacked extension sources*; do not claim Chrome Web Store distribution or automatic installation.

### GitHub release verification

```bash
gh run view <run-id> --repo RudyCity/superagent
gh release view <tag> --repo RudyCity/superagent --json tagName,isDraft,isPrerelease,assets,url
gh release download <tag> --repo RudyCity/superagent --pattern SHA256SUMS.txt --dir <safe-temp-folder>
git ls-remote origin refs/tags/<tag>
```

For an ordinary new release require a successful tagged pipeline. For the **verified recovery path**, the original tagged pipeline may show `failure` only at its publish job, while all six immutable build jobs must be `success` and the recovery run must be `completed/success`. Require **12 published assets** (11 expected packages/archives/receipts/metadata + SHA256SUMS.txt), matching tag/source versions and downloaded SHA-256 hashes. Publication is **not** a production cutover or proof of signed/notarized binaries. Windows clean-install, Android physical-device tests, runtime ownership/recovery, R0–R7 and operator-approved deployment remain separate gates.

## Evidence links and code anchors

- Verified [unified v1.14.83-rc.2 release](https://github.com/RudyCity/superagent/releases/tag/v1.14.83-rc.2), [six native/extension build gates](https://github.com/RudyCity/superagent/actions/runs/43347832939), and [successful verified recovery/publish](https://github.com/RudyCity/superagent/actions/runs/43350949841).
- `scripts/prune-linux-musl-sharp.ts` (includes sharp/libvips/canvas/tokenizers), `tests/pruneLinuxMuslSharp.test.ts`.
- `scripts/prepare-standalone-unix.ts` (native import smoke), `scripts/build-standalone-unix.ts` (bundle fallback), `scripts/verify-packaged-standalone-unix.sh` (extracted package checks).
- `.github/workflows/release-windows-standalone.yml`, `.github/workflows/recover-unified-release.yml`, `scripts/normalize-unified-release-assets.mjs`, `scripts/verify-unified-release-assets.mjs` (current unified release and strict recovery gates); legacy Unix workflow paths remain as historical reference only.
- `docs/guides/windows-standalone-installer.md`, `README.md` (user-facing installation and published asset links).

**Agent completion rule:** Report exactly what was tested locally vs on actual GitHub runners, what was published vs merely tagged/queued, unresolved signing/production gates, and which files were modified. Never claim a fix/release/installation occurred merely because a command was planned, or because a previous tag succeeded.
