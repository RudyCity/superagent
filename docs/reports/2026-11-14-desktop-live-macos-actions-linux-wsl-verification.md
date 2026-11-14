# Desktop Live — macOS GitHub Actions and Linux WSL2 verification

Date: 2026-11-14 (WIB)
Repository: `RudyCity/superagent`, branch `main`
Verified CI commit: `5f25aebb17ad17dc015112efd589a49d8b91f918`
GitHub Actions: https://github.com/RudyCity/superagent/actions/runs/43566453599

## CI results

Workflow `SuperAgent Installer and Tray CI` — **SUCCESS**, all three jobs completed successfully:

| Job | Result | Relevant evidence |
| --- | --- | --- |
| `Standalone / macos-arm64` | PASS | ARM64 macOS runner, SDK validation, ScreenCaptureKit helper native Swift build, helper artifact tests, Tauri build, DMG packaging, extracted DMG/payload checksum audit, DMG artifact upload |
| `Standalone / linux-x64` | PASS | Linux X11 worker Python build/receipt, Core & Rust checks, DEB/AppImage package and extracted-payload audits, artifact upload |
| `Standalone / windows-x64` | PASS | C++20 WGC native build, Rust/Core tests, NSIS archive WGC verification, disposable installed Windows bundle test, artifact upload |

Uploaded CI artifact names: `superagent-standalone-macos-arm64`, `superagent-standalone-linux-x64`, and `superagent-standalone-windows-x64`. These are **CI artifacts, not a published release**. No installed primary Core/Tray/MCP/Cloudflare tunnel was restarted or cut over.

A prior macOS ARM64 build using Xcode SDK 15.5 produced `SCK_MACOS_ARM64_BUILD_PASS` (130,240-byte executable) and six focused native helper tests passed. The final run also passed helper build, package audit and upload.

## Linux WSL2 physical X11 worker check

Host: Ubuntu 24.04 on WSL2 x86_64, using an **ephemeral Xvfb** display, a disposable undecorated GTK3 test window, Openbox, AT-SPI, `wmctrl`, `xprop`, and ImageMagick `import`. The environment's fixture tooling was installed inside the Ubuntu WSL distro only; it did not change production SuperAgent runtime ownership.

Reproduce from repository root:

```bash
dbus-run-session -- env XDG_SESSION_TYPE=x11 GDK_BACKEND=x11 \
  SUPERAGENT_X11_E2E_ISOLATED=xvfb \
  xvfb-run -a -s "-screen 0 1024x768x24" \
  python3 scripts/verify-desktop-live-x11-wsl.py
```

Observed output:

```text
WSL_X11_REAL_FRAME_PASS 320x200 png_bytes=162
WSL_X11_RENAME_REVOKE_PASS
```

The worker verified the same PID, window title, native identity, active state, and geometry through X11 and AT-SPI; it captured a real 320×200 PNG from the **disposable test window**. After renaming the exact X11 window the next capture returned a denied result, proving target-change revocation. The fixture and window manager were terminated after the check. No active Windows desktop was captured.

A decorated GTK window generated different X11 client bounds and AT-SPI frame bounds, so the exact-geometry policy correctly refused it; production support for differently decorated real application windows is **not certified** by this fixture.

## Fail-closed Wayland probe

WSL2 does not own a functional session-scoped `org.freedesktop.portal.Desktop` ScreenCast portal. The native helper returned `{"ok":false,"reason":"portal-runtime-unavailable"}` with exit code 3. No unverified PipeWire capture was permitted.

## CI errors diagnosed and fixed

- `f7d0c40e`: declare the direct `yaml@2.9.1` runtime dependency, required for frozen macOS/Linux TypeScript compilation.
- `5ab9af64`: use the supported Swift target triple `arm64-apple-macosx14.0` with explicit macOS SDK; compile Windows WGC as C++20 for newer MSVC.
- `978be634`: include repeatable isolated WSL2 X11 capture/revoke smoke; normalize only the **Windows test fixture** to Unix LF while retaining strict Linux runtime artifact checks.
- `5f25aebb`: replace unsupported macOS Bash 3.2 `mapfile` with NUL-safe `read` loop; unmount the read-only DMG before temporary-directory cleanup. Added regression assertions.

The final run at `5f25aebb` passed all three platform jobs, unlike earlier failed CI runs.

## Explicit remaining release blockers

This CI does not grant macOS Screen Recording TCC consent in an attended user's session, nor certify actual macOS window frames. WSL2 Xvfb is not an installed Linux GUI end-to-end certification. Wayland PipeWire frame streaming remains fail-closed without a compositor-attested exact-window identity, and remote viewer/control transport is not activated. OS signing/notarization, broader soak tests, and R0–R7 production authorization remain separate release gates. No publication, auto-upgrade or OAuth/tunnel ownership cutover occurred.
