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

SuperAgent combines a local CLI/Core runtime with authorized tools, multi-project MCP integration, Chrome CDP/Delegate coordination, optional desktop companions, and consent-based local-network support. Some features are still experimental and may not be present in published installers.

**Navigate:** [Downloads](#downloads-and-release-status) · [Quick start](#quick-start-from-source) · [Capabilities](#capabilities) · [Security](#security-model) · [Development](#development-and-verification) · [Documentation](#documentation)

## Downloads and release status

GitHub's **Latest**, prereleases, tags, and development drafts are separate states. A newer tag does **not** automatically mean a newer working installer.

| Release channel | Status | What is available |
| --- | --- | --- |
| **Windows 1.14.64 RC1** | **[Published prerelease](https://github.com/RudyCity/superagent/releases/tag/v1.14.64-rc.1)** | Windows x64 standalone installer and SHA-256 checksums. Test as a release candidate, not production-certified. |
| **v1.2.615** | [Historical GitHub “Latest” release](https://github.com/RudyCity/superagent/releases/tag/v1.2.615) | No attached downloadable installer assets. |
| **Windows/macOS/Linux 1.14.64 RC2** | **Not released** | Tag exists, but macOS regression and Linux packaging CI gates failed. No verified multi-OS release. |
| **LAN v0.6.0 — Windows + Android** | **Draft prerelease (not public)** | Four preview binaries and three verification documents are staged. Physical Android testing and release-source reproducibility are pending. |

**[Browse published GitHub Releases](https://github.com/RudyCity/superagent/releases)**. Generated files under `artifacts/` are intentionally Git-ignored; build output alone is not a published release.

### Windows installer: verify before running

Download `SuperAgent_1.14.64_x64-setup.exe` and `SHA256SUMS.txt` from [Windows RC1](https://github.com/RudyCity/superagent/releases/tag/v1.14.64-rc.1). Verify the downloaded installer:

```powershell
Get-FileHash .\SuperAgent_1.14.64_x64-setup.exe -Algorithm SHA256
```

Expected SHA-256 for the published RC1 installer:

```text
72321f6c3e66541e2b50e73cf60e96d91f00b9cde9dd62fda6e6788e6c2f2c33
```

Run the installer on **Windows 10/11 x64**, then launch SuperAgent from the Start menu or a new terminal. The standalone installer bundles Core, the CLI, Bun, and its production packages; users do not need global Bun or Node.js for this package. Optional tools/models may require separate dependencies.

This is an unsigned release candidate: Windows SmartScreen may warn. **Verify the source and checksum; do not blindly bypass security warnings.** See the [Windows standalone guide](docs/guides/windows-standalone-installer.md).

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

For development or global CLI registration:

```bash
bun run dev
# Or install from this checkout and use the command globally:
bun install -g .
superagent
superagent -q "Summarize the security risks of this design"
```

Source development uses Bun; Docker is **not required** for this CLI workflow. Optional integrations may have additional prerequisites. If a legacy launcher invokes Node unexpectedly, check `bun run doctor:launcher` before repairing it.

## Capabilities

| Area | What SuperAgent does | Important boundary |
| --- | --- | --- |
| **General AI assistant** | Research, writing, planning, coding and authorized tool execution | Provider setup and tool approvals are required. |
| **CLI / automation** | Interactive prompts, background daemon and cron jobs | A running owner process and permissions are required. |
| **MCP / projects** | Authenticated tools, registered local or SSH projects, independent workspace scopes | Grants and admin/write operations are permission-gated. |
| **Chrome automation** | CDP browser interaction and paired Delegate multi-tab/session coordination | Session ownership and per-profile authorization are enforced. |
| **Desktop** | [T-Line](https://github.com/RudyCity/t-line) integration and SuperAgent Tray | Some native controls depend on platform and installed build. |
| **Muse / channels** | Remote AI task coordination via supported transports and tunnels | Remote exposure and side effects require explicit configuration. |
| **Media / documents** | Conversion, image/media processing and document operations | Some formats need local binaries, models or optional packages. |
| **LAN preview** | Consented diagnostics, device pairing and file/folder exchange | v0.6.0 is a development draft, not a shipped feature. |

These describe the evolving source project, **not a promise that every capability appears in a specific published installer**. Check release notes and runtime tool availability.

## Security model

- **Consent and authorization:** privileged tools and device sessions require appropriate identity, workspace permission and owner approval. Dangerous-tool mode is not an operating-system sandbox.
- **Browser control:** CDP/Delegate operations must respect claimed tab ownership, session tokens, and other active agent sessions.
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
bun run tray:test            # Rust/Tauri tests (requires Rust toolchain)
```

On Windows with the native build toolchain, `bun run installer:build` stages, verifies and packages the standalone installer. Release workflows must pass their platform-specific gates before publishing; local success does not replace CI approval.

## Documentation

| Guide | Contents |
| --- | --- |
| [Detailed technical README (preserved)](README_FULL.md) | Full pre-cleanup README: commands, architecture, experimental features, and historical evidence. This is a reference snapshot, **not** a release guarantee. |
| [Windows standalone installer](docs/guides/windows-standalone-installer.md) | Windows build, install, verification and caveats |
| [SuperAgent Tray](apps/superagent-tray/README.md) | Tray UX, scheduler, service lifecycle and LAN Devices |
| [Chrome CDP Delegate](docs/guides/delegate-cdp.md) | Paired Chrome/browser tooling |
| [Multi-orchestrator Delegate](docs/guides/superagent-delegate-multitab-orchestrator.md) | Shared session ownership and coordination |
| [Independent MCP projects](docs/mcp/independent-projects.md) | Project registry, scopes and owner grants |
| [LAN client development preview](docs/guides/superagent-lan-client.md) | Windows/Android pairing, transfers and limitations |
| [Android LAN companion](apps/superagent-lan-android/README.md) | Android permissions and physical-device release gates |
| [Project documentation](docs/) | Design plans, audits and implementation notes |

## Support development

SuperAgent is developed and maintained as an open-source project. If it helps your workflow, you can [support independent development on Ko-fi](https://ko-fi.com/rudycity). Contributions help with maintenance, testing and infrastructure.

**Donations are completely optional.** No SuperAgent feature, security update or support access is conditional on donating.

## License

Developed by [RudyCity](https://github.com/RudyCity) and released under the [MIT License](LICENSE).
