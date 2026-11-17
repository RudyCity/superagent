# Desktop Live human takeover and controller verification — 17 November 2026

Repository: `RudyCity/superagent`, branch `main`. This file is a source-change and acceptance ledger, **not** runtime certification.

## Delivered in source

1. **Managed Chrome CDP handoff** — `src/core/desktopUi/desktopLiveInventory.ts` now reads the authoritative per-target control state after requesting either `human` or `agent`, rejecting false-positive success when the hold or return did not stick. The existing revision, registered-browser fingerprint and active takeover-reservation guards remain enforced. `tests/desktop-live/desktopLiveTakeoverAuthorization.test.ts` covers successful readback and both mismatch cases.
2. **Android LAN pointer gestures** — the Desktop Live Tray viewport accepts a single primary pointer only with a distinct mouse grant, uses letterbox-aware normalized coordinates, and maps a tap or bounded swipe to the existing consent-checked `lan_support_action(input)`. Non-Android/native PC windows never dispatch the gesture. A screenshot older than three seconds cannot authorize a new pointer action. Concurrent pointer actions, canceled pointers, stale session generations, and failed device acknowledgments remain denied.
3. **Android keyboard/navigation** — text is limited to 1–160 characters without control characters; separate keyboard consent and a one-in-flight action guard remain mandatory. Asynchronous results cannot mutate state or report success for a later session. Mouse and keyboard scopes remain independent.
4. **Stream lifecycle** — new streams are single-flight; old frame/timer callbacks cannot paint into a new session or stop it. An approval that arrives after the operator stopped the stream is revoked rather than attached. Stopping fences outstanding responses before asynchronous recorder cleanup and revokes approved Android input scopes.
5. **UI and CI** — interactive Android imagery disables touch scrolling, supports pointer/touch tap and swipe, and has regression coverage in `tests/desktop-live/trayAndroidGestures.test.ts`. The `Desktop Live Controller Regression` workflow includes these tests. Windows LAN inventory accurately says remote screen/input is unavailable.

## Current platform contract

| Target | Local human takeover | Remote screen | Remote mouse/keyboard | Return to Agent |
|---|---|---|---|---|
| Native Windows/macOS/Linux app | Exact-session revoke/physical keyboard | Local Tray window preview | **NOT_CONFIGURED** across devices | No automatic native resume |
| Managed Chrome CDP | Per-tab human hold | Not a Desktop Live remote viewer | Physical host interaction; no Desktop Live remote PC input | Revision-checked, readback-verified when no reservation |
| Chrome Delegate | Exact tab claim revoke | Not supported by Desktop Live manager | Not supported by Desktop Live manager | Requires agent to reacquire tab |
| Paired Android LAN Client | Device session support | Existing device-approved stream | Scoped tap/swipe and text/nav; requires separate host + phone consent | Not applicable |
| Paired Windows LAN Client | Management only | **Unavailable in this transport** | **Unavailable in this transport** | Not applicable |

Do **not** promote a read-only preview token into OS input, expose frame/input endpoints through a Quick/Named Tunnel, assume private-LAN pairing implies controller access, or claim remote Windows control merely because a DLL/SDK was packaged. The native Windows semantic-input adapter is source-only until it is installed, bound to a trusted attended host, and positively exercised on an actual foreground HWND.

## Verification gates

Source changes have been pushed. CI results were not retrievable from the current GitHub connector during this review and **must not be marked passed**. Execute:

```sh
node --check apps/superagent-tray/ui/desktop-live-manager.js
bun --bun x vitest run tests/desktop-live/trayAndroidGestures.test.ts tests/desktop-live/desktopLiveTakeoverAuthorization.test.ts --maxWorkers=2
bun --bun x vitest run tests/desktop-live --maxWorkers=2
bun --bun x tsc --noEmit --pretty false
bun run build
```

For **Installed Runtime Verified**, use a real installed Windows Tray and real device(s), with physical user consent, and record:

- Native application: the exact window is shown, preview is view-only; physical takeover ends only the exact agent session, leaves app open, refuses arbitrary remote mouse/keyboard.
- Managed CDP: agent write attempt is blocked while a verified human hold is active; physical input works; a properly released reservation permits Return to Agent; stale revisions and browser identity changes fail closed.
- Android: device screen opens only after MediaProjection/support consent; mouse and keyboard permissions are individually approved; tap, swipe, text and navigation have on-device results; a revoked scope, screen stop, pairing change, expired token or disconnect blocks input; no old frame appears after switching sessions.
- Windows LAN Client: screen/input are explicitly unavailable instead of pretending to work.
- Packaging: Windows Tray native Rust and installed Tauri resources compile; update/install the binary, restart only by operator approval, and repeat the checks on the **installed** build.
- Released: only when the target release contains the verified commit and signed, published installer, with runtime-tested version/commit identity.

## Remaining blocking work for full cross-device PC controller

An installed native-host controller composition is still missing. A complete deliverable needs independent mTLS viewer/controller identities, private certificate provisioning, attended one-window mouse/keyboard approval, a verified OS accessibility adapter (Windows first, then macOS/Linux), fail-closed foreground and screenshot/schema checks at input dispatch, revocation/TTL/reconnect tests, a local/remote input UI, and positive unattended-negative + attended-positive physical host E2E. The existing `remotePrivateOperator` correctly reports `NOT_CONFIGURED`; do **not** change this flag to true without those gates. Windows LAN Client would need a separately approved capture/input receiver protocol and independent host consent.

## Status

- **Implemented:** scoped Android UI and CDP handoff/readback/lifecycle hardening in GitHub source.
- **Tested:** regression tests authored and wired into CI; execution result not verified here.
- **Runtime Verified:** no real host/device verification performed in this session.
- **Released:** no installer/release verification performed in this session.

This is **not** a claim that universal remote desktop takeover is complete.

## Follow-up implementation: independent native input scopes and private host lifecycle

This addendum records source changes after the original audit, not an installed
Windows controller or a published installer.

### Implemented in GitHub source

- `AttendedNativeControllerSession` now supports **simultaneously approved,
  independently revocable mouse and keyboard families**, with separate signed
  native challenges, separate tokens/sequences, one verified viewer principal,
  and one native action in flight across both families. A mouse token never
  permits typing or keys. A forged nonce revokes approval; owner drift and
  reentrant dispatch fail closed.
- `RemotePrivateHostTlsListener` has a single trusted host-side terminal
  controller revocation hook. mTLS viewer disconnect, TLS error, approval
  expiry, failed start and human stop revoke controller authorization before
  capture/TLS shutdown. This is not a general viewer input endpoint.
- `RemotePrivateHostOperator.registerNativeHost` atomically pairs the
  controller and listener so duplicate host setup cannot replace an active
  viewer or steal another operator's controller.
- `AttendedPrivateDesktopHostSession` composes the listener, scoped native
  controller, and physical takeover into one trusted host-only lifecycle.
  The listener must already have separately provisioned pinned mTLS identity,
  and the controller must already have a trusted native signer, fresh
  accessibility capture and nativeRef-only adapter. Nothing automatically
  creates those privileges or exposes them through HTTP/MCP/Quick Tunnel.
- Regression tests cover concurrent approvals, independent revocation,
  mismatched controller identity, nonce replay, active private TLS disconnect,
  in-flight startup cancellation and duplicate host registration.

### CI evidence and limits

The earlier full Desktop Live Controller Regression run for
`19e277b1` completed successfully on Windows and Ubuntu Core plus both
Windows Rust gates:
https://github.com/RudyCity/superagent/actions/runs/44084502066

Each later GitHub commit triggers its own CI. Refer to the latest matching
workflow run before promoting **Tested** to PASS for the new host composition:
https://github.com/RudyCity/superagent/actions

**Runtime Verified: NO. Released: NO.** No installed Windows Tray or live
Android/Windows physical device was controlled through this native
composition during this code-only task. Do not claim end-to-end remote desktop,
full keyboard shortcuts, arbitrary monitor dragging or installed readiness.

### Remaining P0 deployment gates

1. Install a native Windows-host approval UI and trusted signed challenges
   bound to a live HWND/PID/process birth/SID/session/foreground.
2. Provision per-viewer pinned mTLS credentials and a private network
   listener from an OS-trusted local path; no secrets through WebView/MCP.
3. Implement and certify a separately approved **private controller command
   transport** with host-side sequence, scope and native input verification.
   Current mTLS stream is view-only and deliberately rejects input messages.
4. Connect the installed Core/Tray native host composition and the remote
   viewer controls, without promoting existing preview tokens into control.
5. Pass physical Windows positive/negative tests, network disconnection,
   reboot, session takeover, installer extraction and clean-host smoke,
   then publish an explicitly identified/signed tested release.

Until these gates pass, `remotePrivateHostOperator.status().state` must
remain `NOT_CONFIGURED`. This is an intentional safety invariant rather
than a successful remote controller activation.
