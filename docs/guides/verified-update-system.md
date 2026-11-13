# SuperAgent Verified Update System — Desktop Tray

Status: **implemented on source `main`; not yet included in released `v1.14.83-rc.2` installers**. Updated 2026-11-13.

## Purpose and boundaries

The native desktop Tray offers an operator-initiated **Updates & Releases** page and a tray menu shortcut. It is a discovery and safe download workflow, **not** an unattended installer, hot runtime migration, or replacement for the existing operator-approved transactional Tray slot upgrader (`src/core/runtime/managedTrayControl.ts`).

All update requests are native Tauri commands; the WebView cannot choose URLs, shell commands, paths or arbitrary files. The process never restarts an active Core, independent MCP owner, tunnel, browser Delegate, daemon or Tray during check/download.

## How it works

1. The user opens **Updates & Releases**, then selects **Check Releases** (the first page visit also checks). The native command `check_release_updates` fetches up to 30 published release records from `https://api.github.com/repos/RudyCity/superagent/releases?per_page=30`.
2. Discovery accepts only **published prereleases** in the immutable unified format `vX.Y.Z-rc.N`; no drafts, arbitrary tags or deleted legacy release pages. Version comparison is numeric, not lexical. The running Tray's own packaged version is read from native Tauri metadata, not from an unrelated Core.
3. For the current system the updater accepts only one pinned filename: Windows x64 `SuperAgent_<version>_x64-setup.exe`, macOS Apple Silicon `SuperAgent_<version>_aarch64.dmg`, or Linux x64 `SuperAgent_<version>_amd64.AppImage`. Other systems are reported as unsupported. Linux DEB and Chrome/LAN/Android companions are listed but do not take part in a hidden install.
4. The exact installer URL must match `https://github.com/RudyCity/superagent/releases/download/<tag>/<filename>`. Native networking allows redirects to known HTTPS GitHub release-download hosts only; no arbitrary redirected host, insecure HTTP, local IP or file scheme.
5. The release must contain `SHA256SUMS.txt`. The native verifier accepts only a single valid SHA-256 row for the selected exact filename, optionally with `./` prefix. Missing/duplicate checksum rows and malformed asset sizes fail closed.
6. On a separately confirmed **Download verified installer**, Tauri re-fetches the authoritative tag, filename and checksum; if anything changed between review and click it refuses and requires a recheck. Files stream to a new random `.partial` file in the user's Downloads/SuperAgent/updates directory. Exact byte size and hash are checked **before** renaming into the final location.
7. Pre-existing downloads must match the current checksum and size or the updater refuses. Incomplete or bad partial files are deleted. After a verified download, the operator receives the final path, with installation and future Tray lifecycle action left entirely manual.

## Release/rollback contract

- **No silent installation**, no background upgrade timer and no side effects from merely opening the page other than HTTPS metadata reads.
- **No running process manipulation**, PID-based adoption, taskkill, OAuth transfer or Core/MCP owner promotion. Tray's operator-approved upgrade/rollback via `planManagedTrayRelease` / `executeManagedTrayRelease` remains a separate, local trusted-build workflow.
- **Checksums prove file integrity relative to the published release manifest, not publisher signing identity**. macOS notarization, Windows code signing, release provenance, R0–R7 and physical-device acceptance remain separate production gates.
- Already-installed/current-version users can explicitly download the same version for manual repair; a newer installed source build is clearly marked, rather than silently downgraded.
- The updater cannot turn a source checkout into an installed desktop binary. It is bundled with future Tauri releases after CI/native packaging verification.

## Verification

```bash
bun --bun x vitest run tests/trayVerifiedUpdateUi.test.ts --maxWorkers=1
cargo test --manifest-path apps/superagent-tray/src-tauri/Cargo.toml --offline release_updates
cargo check --manifest-path apps/superagent-tray/src-tauri/Cargo.toml --offline
bun run build
node --check apps/superagent-tray/ui/updates.js
```

The native code is `apps/superagent-tray/src-tauri/src/release_updates.rs`. Browser UI files are `apps/superagent-tray/ui/updates.js`, `updates.css`, and the existing sidebar/page wiring. The workflow does not contain a live-install integration test; it needs a future explicit, operator-approved installed-desktop test on each supported OS before being promoted to production.
