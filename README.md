# SuperAgent

**A terminal-native AI assistant for research, writing, automation, software development, and supervised workflows.**

<p align="center">
  <a href="https://github.com/RudyCity/superagent/releases"><img alt="GitHub releases" src="https://img.shields.io/github/v/release/RudyCity/superagent?style=flat-square"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/RudyCity/superagent?style=flat-square"></a>
  <a href="https://ko-fi.com/rudycity"><img alt="Support on Ko-fi" src="https://img.shields.io/badge/Support-Ko--fi-ff5e5b?style=flat-square"></a>
  <a href="https://bun.sh"><img alt="Bun runtime" src="https://img.shields.io/badge/runtime-Bun%201.4.2-black?style=flat-square"></a>
  <a href="https://github.com/RudyCity/t-line"><img alt="Desktop companion" src="https://img.shields.io/badge/desktop-t--line-00D1B2?style=flat-square"></a>
</p>

<p align="center">
  <img src="assets/Video_SuperAgent.gif" alt="SuperAgent terminal interface demonstration">
</p>

SuperAgent combines a local CLI/Core runtime with authorized tools, multi-project MCP integration, Chrome CDP/Delegate coordination, optional desktop companions, and consent-based local-network support. Some features are experimental, available only in source, and not yet included in published installers.

**Development snapshot (12 November 2026):** The source is at package version **1.14.83**, with a published macOS ARM64/Linux x64 standalone prerelease and a separately published Windows x64 prerelease. These releases do not imply deployment to an active Core or Delegate session. The source includes multi-agent cursor presence, local Tray supervision, consented visual previews, qualified iframe commands, and approval-gated replay. **Installing these builds does not automatically deploy or restart an existing Core/Delegate session.**

**Navigate:** [Downloads](#downloads-and-release-status) · [Quick start](#quick-start-from-source) · [Capabilities](#capabilities) · [Managed Chrome CDP](#managed-chrome-cdp-and-human-supervision) · [Security](#security-model) · [Development](#development-and-verification) · [Documentation](#documentation)

## Downloads and release status

GitHub's **Latest**, prereleases, tags, and development drafts are separate states. A newer source version or tag does **not** automatically mean a newer working installer. The following channels distinguish published installers from source-only candidates as of **12 November 2026**.

| Release channel | Status | What is available |
| --- | --- | --- |
| **Source on `main` (newer development builds)** | **Development only** | Source, tests, Windows debug Tray build evidence; not a published or installed production update. |
| **Windows 1.14.78** | **[Published prerelease](https://github.com/RudyCity/superagent/releases/tag/v1.14.78-windows.1)** | Verified Windows x64 standalone installer, SHA-256 checksum, self-contained Core/Bun/Tray/CLI; no MSVC needed on target PC. |
| **v1.2.615** | [Historical GitHub “Latest” release](https://github.com/RudyCity/superagent/releases/tag/v1.2.615) | No attached downloadable installer assets. |
| **macOS ARM64 / Linux x64 1.14.83** | **[Published prerelease](https://github.com/RudyCity/superagent/releases/tag/v1.14.83-unix.1)** | Verified macOS ARM64 DMG, Linux x64 DEB and AppImage, both Chrome extension source ZIPs and SHA-256 checksums. Linux AppImage is built without musl-only native addons; source dependencies remain intact. |
| **LAN v0.6.0 — Windows + Android** | **Draft prerelease (not public)** | Four preview binaries and three verification documents are staged. Physical Android testing and release-source reproducibility are pending. |

**[Browse published GitHub Releases](https://github.com/RudyCity/superagent/releases)**. Generated files under `artifacts/` are intentionally Git-ignored; build output alone is not a published release.

### Windows installer: verify before running

Download `SuperAgent_1.14.78_x64-setup.exe` and `SHA256SUMS.txt` from [Windows v1.14.78 prerelease](https://github.com/RudyCity/superagent/releases/tag/v1.14.78-windows.1). Verify the downloaded installer:

```powershell
Get-FileHash .\SuperAgent_1.14.78_x64-setup.exe -Algorithm SHA256
```

Expected SHA-256 for the published 1.14.78 Windows installer:

```text
b488d9a7d31a5b1427b421a45abc45c33781da6ddfe14edf23587a96d8fcd08b
```

Run the installer on **Windows 10/11 x64**, then launch SuperAgent from the Start menu or a new terminal. The standalone installer bundles Core, the CLI, Bun, and its production packages; users do not need global Bun or Node.js for this package. Optional tools/models may require separate dependencies.

This is an unsigned release candidate: Windows SmartScreen may warn. **Verify the source and checksum; do not blindly bypass security warnings.** See the [Windows standalone guide](docs/guides/windows-standalone-installer.md).

### macOS ARM64 and Linux x64: verified standalone prerelease

Download the DMG, DEB or AppImage and `SHA256SUMS.txt` from [v1.14.83-unix.1](https://github.com/RudyCity/superagent/releases/tag/v1.14.83-unix.1). Verify the downloaded file against its exact row in `SHA256SUMS.txt`. On macOS use `shasum -a 256 SuperAgent_1.14.83_aarch64.dmg`; on Linux use `sha256sum SuperAgent_1.14.83_amd64.AppImage` or `sha256sum SuperAgent_1.14.83_amd64.deb`. Do not install files with mismatched checksums.

The Linux DEB is for Debian/Ubuntu-compatible x64 distributions; the AppImage is a portable x64 alternative (make it executable before running). The macOS DMG is for Apple Silicon only. macOS is not notarized, so Gatekeeper may warn. Both Chrome extension ZIPs are separate Developer-mode packages, not Chrome Web Store publications. These are **prereleases**, not a production runtime cutover.

### LAN preview: not part of the Windows installer

LAN v0.6.0 introduces owner-approved Windows/Android file and folder transfer with a **mandatory network-segment name** for discovery. The segment name is only a discovery filter, **not authentication**; full TLS fingerprint comparison, short-lived pairing, and device-owner approval still apply.

The binaries are in a **maintainer-only GitHub draft**. They are not public, not production-certified, and **not bundled in Windows RC1**. The APK is debug-signed, Android-to-Windows physical-device testing remains pending, and the LAN source has not yet been committed under a matching release tag. Maintainers should follow the [LAN client guide](docs/guides/superagent-lan-client.md) rather than distributing this draft.

## Quick start from source

Requirements: [Bun](https://bun.sh) **1.4.2 or newer**, Git, and a supported operating system.

```bash
git clone https://github.com/RudyCity/superagent.git
cd superagent
bun install --frozen-lockfile
bun run build
bun run runtime:smoke
bun run start
```

**Tray source is included in a fresh clone**, but the compiled Windows Tray executable is not tracked in Git. Installing Bun dependencies or building the TypeScript Core does **not** compile the Tauri desktop app. Normal Windows users need **neither Rust nor MSVC**: install a prebuilt standalone release from [GitHub Releases](https://github.com/RudyCity/superagent/releases), which includes Tray, Core, Bun and the CLI.

On a Windows PC that has already cloned the source and installed Bun, the verified prebuilt-install workflow is:

```powershell
bun run tray:prebuilt:check
bun run tray:prebuilt:download
# Or, to explicitly launch the verified installer:
bun run tray:prebuilt:install
```

The commands select an official published Windows release, read its SHA256SUMS.txt and check the installer hash/size. They do **not** compile native code. The check command never downloads or installs anything; download alone does not execute the installer. If the published release is older than the checked-out source, download/install **refuses** instead of silently downgrading. You can intentionally use that older release with `bun scripts/install-prebuilt-windows.ts --install --allow-version-mismatch` after reviewing the version shown by the check. A clean clone cannot produce an unpublished latest Tray build without a builder: fresh standalone binaries are produced on GitHub Actions runners and published only after the relevant release gates pass.

For development or running the CLI from a source checkout:

```powershell
# In the SuperAgent repository root:
git pull --ff-only origin main
bun install --frozen-lockfile
bun run build
bun dist/cli.js --version
bun run start
# Or, during active development:
bun run dev
```

These commands run from the source directory without installing a global package or compiling SQLite through MSVC. If you need `superagent` available **from any directory on Windows**, use the **verified standalone installer** above; it includes the Tray, Core, Bun runtime and launcher. Avoid `bun install -g .` for this local checkout: Bun versions can treat `.` as an invalid global package name or resolve dependencies independently of the checked-in lockfile. Use `bun run start` for source development rather than relying on a global package registration. Docker is **not required**. If a legacy launcher invokes Node unexpectedly, check `bun run doctor:launcher`.

**Windows / `better-sqlite3` troubleshooting:** On older checkouts, the `r-memory` dependency could pull native `better-sqlite3` and run `node-gyp rebuild`, which fails if a matching prebuilt binary or MSVC is absent (especially on newer Node versions). Current SuperAgent pins the Bun-native `r-memory` SQLite adapter; `better-sqlite3` is an **optional Node-only peer** and is absent from the root `bun.lock`. First update the checkout safely with `git pull --ff-only origin main` (do not overwrite local changes), then run `bun install --frozen-lockfile` and the source commands above. You should not need to install Visual Studio C++ Build Tools or delete the global Bun directory. For ordinary Windows usage, install the published `.exe` instead.

**Native dependency setup on first interactive startup:** SuperAgent's existing startup checker prepares ripgrep, Python, uv, Android/Office tools and optional services. It now also checks **FFmpeg + ffprobe**, needed for managed Chrome CDP video archives. If missing, interactive startup (including `superagent setup`) offers to install via the available OS package manager **only after your explicit confirmation**; normal server/MCP startup, headless workflows and `--quick` never silently install system packages. On Windows the installer uses `winget` with the reviewed FFmpeg package, on macOS `brew`, and on Linux an already-root apt/dnf session. If unsupported, SuperAgent shows manual steps and continues without video capture. It does not auto-download unverified binaries or elevate privileges.

```bash
superagent deps check             # Read-only FFmpeg/ffprobe verification
superagent deps install           # Ask before installing missing native tools
superagent deps install --yes     # Explicit approval for scripts/non-interactive use
```

When a system package manager changes `PATH`, open a fresh terminal and rerun `superagent deps check`.

## Capabilities

| Area | What SuperAgent does | Important boundary |
| --- | --- | --- |
| **General AI assistant** | Research, writing, planning, coding and authorized tool execution | Provider setup and tool approvals are required. |
| **CLI / automation** | Interactive prompts, background daemon and cron jobs | A running owner process and permissions are required. |
| **MCP / projects** | Authenticated tools, registered local or SSH projects, independent workspace scopes | Grants and admin/write operations are permission-gated. |
| **Chrome automation** | Managed CDP multi-agent browser control, agent cursor presence, explicit iframe operations, and separate paired Delegate transport | Per-tab ownership is enforced; managed-only features are not automatically available through Delegate. |
| **Browser supervision (source)** | Native Tray activity feed, Follow Agent filter, owner pause/resume, local human hold, and consented tab preview | Requires authenticated Core, registered target, and matching session identity; not remote VNC by default. |
| **Replay (source)** | Opt-in redacted action recording; ordered cursor steps and one-time recorded clicks with local operator approval | No unattended replay of typing, navigation, drag, payment, or uncertain side effects. |
| **Desktop** | [T-Line](https://github.com/RudyCity/t-line) integration and SuperAgent Tray | Some native controls depend on platform and installed build. |
| **Muse / channels** | Remote AI task coordination via supported transports and tunnels | Remote exposure and side effects require explicit configuration. |
| **Media / documents** | Conversion, image/media processing and document operations | Some formats need local binaries, models or optional packages. |
| **LAN preview** | Consented diagnostics, device pairing and file/folder exchange | v0.6.0 is a development draft, not a shipped feature. |

These describe the evolving source project, **not a promise that every capability appears in a specific published installer**. Check release notes and runtime tool availability.

**Chrome extension cleanup (11 November 2026):** `chrome-extension-delegate/` is the maintained paired ChatGPT/opt-in CDP extension. The old standalone Remote Bridge and ChatGPT Optimizer extension packages have been retired from the source tree. The separate full sidepanel extension (`chrome-extension/`) is preserved. Legacy port 9223 bridge backend code remains for compatibility, but is not the Delegate transport and no retired extension should be installed from this repository.

## Managed Chrome CDP and human supervision

The following capabilities are implemented in the **development source**. They require an authorized, running Core and the relevant managed Chrome and native Tray setup; they do not establish feature parity for a separately connected Delegate Chrome profile.

- **Multi-agent cursor presence:** independently labeled and colored overlays with avatar initials, cursor position tracking, and navigation continuity. Each agent cursor **fades out after 4 seconds of inactivity**, reappears on new agent input, and remains hidden after document navigation until activity resumes. The overlay mirrors native CSS pointer/text/crosshair shapes and never intercepts real input. Chrome has one effective CDP pointer per tab even when several agent overlays exist.
- **Genuine browser hover and native click:** `control_chrome_cdp` supports `hover_cursor` with `selector` or `x/y` and optional `dwell_ms` (default 450 ms), `click_cursor` for one trusted native mouse press/release, and `show_cursor` that synchronizes Chrome's hit-test position. These fire browser mouse/pointer handlers and CSS `:hover` rather than only moving an overlay. The older `click` command still supports DOM-click mode for backward compatibility; use `click_cursor` (or `click` with `nativeClick:true`) when real mouse events are required. **CDP does not move the Windows/macOS hardware cursor.**
- **Live activity:** authenticated native Tray display of claimed tabs, participants, queue/paused state, latest sanitized actions and per-agent cursor positions. Updates use bounded **long-polling**, not a video/WebSocket stream. The **Follow Agent** filter is read-only.
- **Owner coordination and local takeover:** owner-token pause/resume uses the existing serialized target queue and requires fresh revision/document verification. For a registered managed tab, the operator can explicitly **Take over locally** or **Return control to agent** in Tray. Human hold blocks agent writes; returning control does **not** automatically resume an owner-paused agent.
- **Private tab preview:** clicking **Watch private preview** requests operator consent for the exact registered tab. Core returns bounded JPEG frames at **at most one frame per second**, without writing screenshots to disk. Preview stops on disconnect/hidden Tray, and navigation requires a fresh consent ID. This is local viewing, **not** open remote screen sharing.
- **Qualified frames and target checks:** explicit frame IDs support read, highlight, click, snapshot, field update and frame-local scroll, including supported out-of-process cross-origin iframes. Optional pre-click highlighting rejects covered, disabled, or moved targets. Open Shadow DOM is supported where accessible; inaccessible frames/closed roots fail closed rather than falling back to the parent page.
- **Consent-gated replay:** short-lived, opt-in action metadata supports **ordered workflows**. Cursor movement can be replayed explicitly; a recorded click additionally needs a one-time local operator approval tied to the original selector/URL hashes, target, generation and revision. Approval is consumed before dispatch; ambiguous actions are never retried. Typing, navigation, drag and transactions remain manual-only.
- **Project-local session recording:** `record_session_start` starts an owner-authorized, explicitly consented MP4 recording of the exact managed Chrome tab plus structured action transcript, redacted console/errors and network metadata. Video is included by default when `confirmSensitiveVideo:true` is provided. `record_session_status` and `record_session_stop` inspect/finalize the archive under **`<active-project>/.superagent/recordings/cdp/<uuid>/`**, never the SuperAgent installation or global config. Requires local FFmpeg; 5 FPS, 960×540, no audio, 10-minute maximum. See the [recording guide](docs/guides/cdp-session-recording.md).

**Current deployment limits:** source and focused Windows/Chrome tests have passed, but the installed native Tray and primary Core have not been verified running this build. The previously checked Core lifecycle lacked an authenticated supervisor, and the GPT-5.6 High Delegate forwarding bridge reported `DELEGATE_FORWARD_BRIDGE_NOT_PROVISIONED`. Do not assume live Delegate forwarding, cross-device takeover, signed installers, or full streaming is available. See the [1.14.70 implementation evidence](docs/reports/2026-11-11-cdp-visual-preview-workflow-release-evidence.md) and [1.14.69 CDP security/e2e evidence](docs/reports/2026-11-11-cdp-live-iframe-human-approved-replay-evidence.md).

## Security model

- **Consent and authorization:** privileged tools and device sessions require appropriate identity, workspace permission and owner approval. Dangerous-tool mode is not an operating-system sandbox.
- **Browser control:** CDP/Delegate operations must respect claimed tab ownership, session tokens, and other active agent sessions. Native operator control is limited to registered, verified targets; returning control does not bypass a paused agent's owner lease.
- **Browser privacy and replay:** private JPEG preview requires per-tab consent and never persists image frames; document changes revoke existing preview consent. The new *explicit session recorder* is separate: only after owner authorization and video consent does it save MP4 and redacted logs **inside the active project**, with auto-ignored recordings. MP4 pixels can still expose sensitive text, so review before sharing. Replay metadata omits typed values and raw URLs/selectors, while a recorded click requires fresh verification and a one-time operator approval. These controls do not authorize irreversible transactions.
- **Network boundaries:** API/MCP tunnels are opt-in. LAN segment names do not replace TLS verification or pairing.
- **Secrets:** keep tokens out of commits, screenshots, logs and public issues. GitHub Secret Scanning and Push Protection are enabled for this repository.
- **Distribution:** generated APKs, EXEs and ZIPs belong in verified GitHub Releases, not the Git tree. Release promotion requires matching source, checksums, tests and platform acceptance.

Report vulnerabilities without publishing credentials or private logs.

## Development and verification

Run the relevant checks from the repository root:

```bash
bun install --frozen-lockfile
bun run build                # Build/type-check Core
bun run verify:extension-js  # Validate Chrome extension scripts
bun run test                 # Full Vitest test suite
bun run verify:delegate      # Delegate source/extension and forwarding checks
bun run tray:check           # Rust/Tauri type-check (requires Rust toolchain)
bun run tray:test            # Rust/Tauri tests (requires Rust toolchain)
```

For focused managed-CDP changes, run the cursor, control, frame, replay and operator-endpoint suites as appropriate—for example: `bun --bun x vitest run tests/chromeCdpCursor.test.ts tests/chromeCdpTools.test.ts tests/chromeCdpVisualPreview.test.ts tests/chromeCdpWorkflowReplay.test.ts`. A headed Chrome smoke test validates overlays and cross-navigation behavior more directly than unit tests alone.

On Windows with the native build toolchain, `bun run installer:build` stages, verifies and packages the standalone installer. A **debug Tray executable** can also be built from `apps/superagent-tray` using `cargo tauri build --no-bundle --debug --ci`; that does not install or activate it. Release workflows must pass their platform-specific gates before publishing; local success does not replace CI approval.

## Documentation

| Guide | Contents |
| --- | --- |
| [Detailed technical README (preserved)](README_FULL.md) | Full pre-cleanup README: commands, architecture, experimental features, and historical evidence. This is a reference snapshot, **not** a release guarantee. |
| [Windows standalone installer](docs/guides/windows-standalone-installer.md) | Windows build, install, verification and caveats |
| [SuperAgent Tray](apps/superagent-tray/README.md) | Tray UX, scheduler, service lifecycle and LAN Devices |
| [Chrome CDP Delegate](docs/guides/delegate-cdp.md) | Paired Chrome/browser tooling |
| [Multi-orchestrator Delegate](docs/guides/superagent-delegate-multitab-orchestrator.md) | Shared session ownership and coordination |
| [Managed CDP 1.14.70 evidence](docs/reports/2026-11-11-cdp-visual-preview-workflow-release-evidence.md) | Private preview, navigation consent, replay workflow, Windows build and release gates |
| [Managed CDP 1.14.69 evidence](docs/reports/2026-11-11-cdp-live-iframe-human-approved-replay-evidence.md) | Live state, local hold, iframe/OOPIF, operator approval and E2E boundaries |
| [Independent MCP projects](docs/mcp/independent-projects.md) | Project registry, scopes and owner grants |
| [LAN client development preview](docs/guides/superagent-lan-client.md) | Windows/Android pairing, transfers and limitations |
| [Android LAN companion](apps/superagent-lan-android/README.md) | Android permissions and physical-device release gates |
| [Project documentation](docs/) | Design plans, audits and implementation notes |

## Support development

SuperAgent is developed and maintained as an open-source project. If it helps your workflow, you can [support independent development on Ko-fi](https://ko-fi.com/rudycity). Contributions help with maintenance, testing and infrastructure.

**Donations are completely optional.** No SuperAgent feature, security update or support access is conditional on donating.

## License

Developed by [RudyCity](https://github.com/RudyCity) and released under the [MIT License](LICENSE).
