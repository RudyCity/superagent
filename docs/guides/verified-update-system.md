# SuperAgent Unified Update Manager — Tray, Chrome, Android and LAN

Status: **implemented on source `main`; not included in released `v1.14.83-rc.2` installers**. Updated 2026-11-13.

## Scope and trust boundaries

The native Tauri Tray **Updates & Releases** page provides **independent, operator-confirmed downloads** for the main application and every component in the unified GitHub Release. The WebView never chooses URLs, file paths or commands. Rust performs all selection, network access and SHA-256 validation.

The updater is intentionally **not** an unattended install engine. Native installers are never executed; unpacked Chrome extensions cannot be silently reloaded from another app; Android's package installer requires approval on the device. A download does not restart an existing Core, independent MCP owner, tunnel, browser Delegate, Tray, or LAN session. Operator-controlled transactional Tray upgrade and rollback continue to use the existing, separate owner-verified lifecycle system.

## Component matrix

| ID | Published version source | Download/target | Manual installation after download |
| --- | --- | --- | --- |
| `superagent` | Unified tag; compares installed Tray native version | Current OS: Windows x64 EXE / macOS ARM64 DMG / Linux x64 AppImage | Run the local installer only when the operator is ready; never adopt or restart Core/MCP implicitly |
| `windows-installer` | Unified tag | Windows x64 NSIS, transferable from another OS | Run on target Windows machine; Bun/CLI included; no MSVC required |
| `macos-dmg` | Unified tag | Apple Silicon DMG | Open manually on macOS; unsigned, unnotarized prerelease |
| `linux-appimage` | Unified tag | Linux x64 AppImage | Set executable bit and launch on Linux after verifying workloads |
| `linux-deb` | Unified tag | Linux x64 DEB | OS package manager, with target machine operator permission |
| `chrome-delegate` | `superagent-delegate-<version>.zip` | Independent MV3 source archive | Unzip, visit `chrome://extensions`, enable Developer mode, Load unpacked / reload after active delegated tasks complete |
| `chrome-sidepanel` | `superagent-sidepanel-<version>.zip` | Independent MV3 source archive | Unzip and load/reload separately; Chrome Web Store versions follow their own store update process |
| `android-lan` | `SuperAgent-LAN-Android-<version>-debug.apk` | Debug-signed APK transferable from desktop | Copy to phone, approve installation in Android. An incompatible signature may prevent an in-place update; preserve local data |
| `windows-lan` | `SuperAgent-LAN-Client-<version>-Windows-x64-setup.exe` | Separate Windows receiver installer | Install on target standard-user Windows session when no file transfer is active; owner pairing remains required |

The current-host package is shown once (the host-specific entry is not duplicated among transferable installer rows). The UI does **not** infer the installed version of Chrome extensions, Android apps, or LAN Client from the running Tray version. Until a separately authenticated on-device version source is available, these rows display **Installed version unknown**. Unknown does **not** mean a newer version is definitely available.

## Secure check and independent download flow

1. The user opens Updates & Releases and selects **Check Releases**. The native command `check_release_updates` reads official GitHub releases from `https://api.github.com/repos/RudyCity/superagent/releases?per_page=30`. Drafts, unrelated tags and unsigned-downloaded arbitrary metadata are not accepted as selectable update channels.
2. A published unified prerelease must match `vX.Y.Z-rc.N`. Package filenames are selected only from fixed, component-specific patterns; ambiguous versions or duplicate assets fail closed. The published `SHA256SUMS.txt` is downloaded once for the check and each available component's exact SHA-256 row is validated.
3. The UI renders independent cards showing the published version, the installed-version status (known for Tray only), the exact artifact, size, target OS, installation notes, and a **Download verified package** button for each eligible component. All display text uses `textContent`, never injected HTML.
4. A button click prompts for explicit user consent. The native `download_release_component` command accepts only a fixed component ID, the reviewed release tag, and its SHA-256. It **refetches** release metadata and checksum and rejects any changed tag, asset or hash. There is no arbitrary URL, filename, destination, shell command or sudo path in its API.
5. The official HTTPS asset may redirect only to permitted GitHub release CDN hosts. File transfers stream into a newly created random `.partial` file under `Downloads/SuperAgent/updates`, bounded by the exact published size and a maximum total size. SHA-256 and byte count are checked before the complete file is atomically linked into a **new**, non-overwriting final path.
6. A pre-existing final file must be a regular, non-symlink file of matching size and SHA-256 or the download is rejected. Unexpected partial files are deleted. No installer is executed. The UI shows the verified file path and each component's device-specific installation guidance.

Checksums prove integrity relative to the publisher's release manifest, **not code-signing identity**. Windows signing, Apple notarization, release provenance, R0–R7 approval gates, APK signing key compatibility, and real-device upgrade/downgrade remain independent acceptance criteria.

## Verification

```bash
node --check apps/superagent-tray/ui/updates.js
bun --bun x vitest run tests/trayVerifiedUpdateUi.test.ts tests/prebuiltWindowsInstaller.test.ts --maxWorkers=1
cargo test --manifest-path apps/superagent-tray/src-tauri/Cargo.toml --offline release_updates
cargo check --manifest-path apps/superagent-tray/src-tauri/Cargo.toml --offline
bun run build
```

Security regression cases include per-component version parsing, duplicate extension versions, missing/malformed checksums, host installer vs cross-device installer mapping, unsupported component IDs, corrupted existing downloads, no-overwrite destination behavior, explicit confirmation, and independent Chrome/Android UI actions. Native CI and a future installed-desktop E2E are required before shipping the new Tray UI. **The already published v1.14.83-rc.2 binary does not contain this feature.**
