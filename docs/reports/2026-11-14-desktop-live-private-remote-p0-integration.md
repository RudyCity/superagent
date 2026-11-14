# Universal Desktop Live — private remote P0 integration evidence

Date: 2026-11-14
Repository: RudyCity/superagent, canonical main checkout.
Previous clean packaging baseline: GitHub Actions https://github.com/RudyCity/superagent/actions/runs/43566453599 (Windows/Linux/macOS successful at 5f25aebb).

## Implemented in this iteration

- **Independent private viewer identity:** `remotePrivateTransport.ts` adds a bounded attach-only, private-address mutual-TLS 1.3 transport, separate ephemeral viewer HMAC proof and server-side certificate fingerprint verification. This is NOT a public listener, HTTP route, WebSocket server, tunnel forwarding, or a running remote service.
- **Authenticated viewer SDK:** `remotePrivateViewerClient.ts` connects to a private IP only, validates pinned server certificate, TLS 1.3, ALPN, session challenge, bounded binary JPEG frames; sends ACK only after the consumer finishes. There is no browser GUI, recording, file transfer, mouse or keyboard channel.
- **Native host lease:** `livePreview.ts` and `remoteHostCapture.ts` accept only an existing, specifically native-approved local preview. Captured pixels and all frame metadata are validated; no desktop-wide screenshot fallback and no network access to local preview bearer.
- **Host-only handoff:** `remotePrivateTransport.ts` keeps the viewer CSRF and internal session policy private; the local host claims capture through `claimNativeCapture`. `remotePrivateLiveRuntime.ts` binds the two independently approved sides, and `remotePrivateHostStream.ts` provides bounded sequential delivery, revoking both sides on host takeover, disconnect or uncertain capture. `remoteLiveOrchestrator.ts` provides an additional explicit ACK-only host/viewer composition gate.
- **Separate input authorization:** `remoteNativeInputDispatch.ts` requires a **different human-approved one-shot controller lease**, fresh host-native PNG and accessibility hashes, and an exact `nativeRef` semantic OS adapter. No input is authorized merely because a viewer connected.
- **Windows native UIA proof-of-source:** `adapters/windowsRemoteSemantic*.ts` plus `native/desktop-live-windows-input/windowsRemoteSemantic.cpp` implement an optional fixed-source UI Automation native semantic binding. A native function re-verifies PID, exact root HWND, process birth, current desktop, Windows user SID, OS session, integrity level and unique accessibility element before invoking a one-shot synchronous approval callback immediately before the OS UIA action. It has NO application network listener and is not enabled by default.
- **Wayland:** only guarded one-shot XDG portal consent policy, stronger D-Bus owner consistency checks and a positive/negative simulated verification. PipeWire FD is immediately closed. Live capture remains unavailable without compositor-verifiable binding to the approved exact window.

## Verification in real Windows checkout (not a production service)

- Focused Desktop Live suite `bun --bun x vitest run tests/desktop-live --maxWorkers=2`: **245 passed, 8 skipped, 0 failed** across 32 passing suites; the optional real Windows input host smoke was skipped until explicitly enabled.
- `bun --bun x tsc --noEmit --pretty false`: **PASS**.
- `bun run build`: **PASS**.
- `tests/desktop-live/remoteHostCapture.win32.test.ts`: a disposable WinForms window really captured through exact HWND, encoded as JPEG, and offered to the viewer gate with ACK (**PASS**).
- `tests/desktop-live/remotePrivateTransport.test.ts` and `remotePrivateViewerClient.test.ts`: real loopback TLS 1.3 and separate verifier/proof, frame, ACK and revoke (**17/17 PASS**).
- `tests/desktop-live/remotePrivateEndToEnd.test.ts`: trusted host native-lease **fixture** -> real mTLS socket -> independent Node viewer -> JPEG frame -> ACK -> human takeover revoke (**PASS**).
- `tests/desktop-live/remotePrivateLiveRuntime.test.ts`: trusted host/native grant and viewer grant are composed without exposing local preview bearer; disconnect and takeover invalidate both (**7/7 PASS**).
- The separately enabled `SUPERAGENT_RUN_NATIVE_WINFORMS_E2E=1` test on a disposable Windows WinForms button returned a native `-356` foreground mismatch and **FAILED** before any action. The MCP-driven test window did not reliably own the interactive foreground. This remains a hard gate: no fake success, no weakening of foreground checks, and no remote-control activation.
- WSL2 Ubuntu: `python3 tests/desktop-live/waylandPortalNativeSimulation.py` **8/8 PASS**; actual WSL portal capability probe rejects unavailable portal (exit 3). Prior isolated WSL X11 real fixture verified 320x200 PNG and revocation on title change.

## Security and production boundaries

- No remote desktop endpoint/port is opened. The server-side bridge requires **an independently accepted private TLS socket**; the SDK is not a GUI application yet.
- No remote input was exposed through Core, MCP, Chrome Delegate, LAN, Cloudflare tunnel, or Tray UI. Native desktop input remains fail-closed without separately attended host approval and installed nativeRef-only adapter.
- The optional Windows UIA DLL is a local compile output, not yet signed, packaged or enabled in an installed release. Compiled intermediates are not part of this source change.
- No true macOS attended Screen Recording E2E, production Linux GUI X11 certification, Wayland PipeWire frames or native remote control in the installed product is claimed.
- No installed Core/Tray/MCP services were restarted, public URLs modified, production secrets changed, or release published.
- The successful prior cross-platform GitHub Actions run predates this iteration: **new remote integration code requires a fresh CI run and review before release**.

## Remaining gates

1. Bind a native host-controlled start/stop UI to the new preview + mTLS bridge without ever forwarding the local Core bearer.
2. Provision the independently verified, private TLS listener and viewer certificates through an owner-approved workflow; add the viewer GUI on supported platforms.
3. Complete and certify the Windows native semantic control dispatcher with attended Tray proof and disposable host UIA E2E; port the same contracts to macOS AX and Linux X11, keeping Wayland input disabled until verified.
4. Verify macOS ScreenCaptureKit with real TCC Screen Recording permission and Wayland through a real compositor's PID-bound window selection.
5. Add deterministic native build+checksum into installer packaging, install/smoke on each platform, stress tests, signing/notarization, security R0–R7, then user-approved release. Do not silently cut over the active named Cloudflare tunnel.

Status: **P0 source implementation & isolated integration advances complete; installed remote desktop production readiness is PARTIAL.**
