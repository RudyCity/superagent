# Desktop Live completion pass — private host listener, viewer UI, safe native input

Date: 2026-11-14
Project: SuperAgent, branch main

## Implemented and verified

1. Native Windows exact-window capture is now exercised through a **real TLS 1.3 mTLS socket**, separate authenticated viewer client, JPEG integrity and host takeover in `tests/desktop-live/remotePrivateNativeWin32E2E.test.ts`. This uses a disposable WinForms child and test-only synthetic approval proof; it does not activate production screen sharing.
2. `remotePrivateHostTlsListener.ts` introduces a trusted host-initiated listener that is OFF by default, validates a numeric loopback/RFC1918 bind address and certificate SAN, requires separate native remote approval, pins viewer TLS identity, accepts one viewer, fails closed at 5-second connection/attach boundaries, caps session lifetime and revokes both TLS/capture on takeover or disconnect. Real socket tests cover success, denied approvals, public/wildcard bind rejection, bad cert, stop and replay. No public tunnel.
3. The separate viewer-machine UI is served only on 127.0.0.1. It requires a random local unlock secret (not in URL or HTML), origin-checked POST, HttpOnly SameSite Strict cookie, no-store CSP, verified JPEG/PNG frame digests, a freshness indicator, and explicit Start/Stop; no mouse/keyboard/clipboard or recording. The CLI accepts short-lived TLS configuration only over private standard input, never browser or argv.
4. Host Tray/Core adds explicit readiness review with `NOT_CONFIGURED`, a native informational dialog, and stop/takeover. No remote listener is enabled via WebView because production identity, certificate provisioning and out-of-band viewer credential handoff are not yet verified. This is intentional fail-closed behavior.
5. Windows UI Automation native source and its signed ABI are hardened. DLL build verification and focused dispatch tests pass. Native `GetForegroundWindow()==HWND` still blocks attended action in the MCP-launched temporary WinForms test (`-356`, `foregroundAtShown=false`). No focus stealing, SendInput, coordinate fallback, or fake PASS.
6. Windows packaging scripts/workflows build the optional UIA native DLL from C++ source on trusted Windows CI, check PE x64 and SHA-256 provenance, and audit a real NSIS payload; not enabled by default. Installer and clean-installed runtime certification for this change are still pending.
7. The unrelated Linux CI LAN-folder regression was traced to 300-iteration `setImmediate` polling of async folder completion. The test harness now observes actual UI status and enforces a bounded real-time watchdog. Both file/directory path collision orders are rejected; no unauthorized folder save is accepted.

## Verification conducted (local REAL Windows checkout)

- `bun --bun x vitest run tests/desktop-live/remotePrivateNativeWin32E2E.test.ts`: **1/1 PASS**, real disposable HWND -> mTLS -> viewer.
- `bun --bun x vitest run tests/desktop-live/remotePrivateHostTlsListener.test.ts`: **5/5 PASS**, real mTLS loopback and deny tests.
- `bun --bun x vitest run tests/desktop-live/remotePrivateViewerLocalUiBrowser.test.ts tests/desktop-live/remotePrivateViewerLocalUi.test.ts`: **7/7 PASS**, actual Chrome 320px renders two SHA-256-checked frames.
- `bun --bun x vitest run tests/desktop-live tests/desktopTrayLanFolderUi.test.ts tests/desktopTrayDesktopLiveRemote.test.ts tests/desktopTrustedInputTrayUi.test.ts tests/desktop-ui-integration/trusted-desktop-input.test.ts --maxWorkers=2`: **316 PASS, 8 SKIPPED, 0 FAIL** at the integration checkpoint.
- `bun --bun x tsc --noEmit --pretty false`: PASS.
- `bun run build`: PASS (Core and MCP).
- Rust `cargo check --locked --quiet --manifest-path apps/superagent-tray/src-tauri/Cargo.toml`: PASS.
- Focused LAN folder suite: 24/24 PASS repeatedly on Windows. Ubuntu GitHub Actions full regression must be rerun on the new commit.

## Release & security blockers

The host-side listener **exists as an opt-in trusted module**, not an active production listener. The Tray operator deliberately reports NOT_CONFIGURED until native provisioning of the server key, pinned viewer certificate identity, separate viewer approval and credential handoff is implemented and certified. Standalone viewer UI exists; no remote desktop session from a user's Android device is claimed. The user-facing installed GUI does not currently activate a remote view with certificate provisioning, and remote input is not enabled. Any native UI Automation action still requires an attended foreground exact HWND. Wayland fails closed if portal identity cannot bind Window PID/nativeId. The updated Windows optional DLL and NSIS package have not yet passed new GitHub CI extracted-installer audit.

Do NOT expose a local Core bearer or signed preview capability over an HTTP/tunnel endpoint, bypass foreground checks, auto-connect public listeners, or auto-enable remote input. Existing Core, Tray, MCP and named tunnel processes were not restarted or modified during tests.

Status: **Source integration and local regression PASS; installed production feature PARTIAL / require attended approval and certified private provisioning.**
