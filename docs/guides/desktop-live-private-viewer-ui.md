# Desktop Live — Tray Session Manager and Password-Protected Remote Console

## Product contract (owner decision, 15 November 2026)

Desktop Live **is not a local preview/VNC host**. Its primary home is
**SuperAgent Tray → Desktop Live**, with a central operator inventory of:

1. Native application windows (exact PID + OS-native handle).
2. Managed Chrome CDP targets (exact registered browser generation, port, tab/target).
3. Paired Chrome CDP Delegate tabs (client profile ID + tab ID, including owner lease).

Each entry has its own status, owner where known, and scoped stop/takeover
action. Empty/unknown sources are labelled; failures never invent screens.
**Stop session never kills a process, closes a native application, or closes a
Chrome tab.** Managed CDP human takeover blocks agent mutations using existing
control fencing. A claimed Delegate tab can be revoked individually with an
expected revision and the existing durable lease journal. Disconnecting an entire
Delegate *profile* is a separate, clearly labelled action requiring confirmation.

Authorized agents use the existing dangerous, principal-bound
`superagent_desktop_ui` tool:

- `command="live_inventory"` lists handles and metadata only.
- `command="live_stop"`, `liveId`, and the **owner's exact session**
  `leaseToken` revoke only that agent-owned session; never another agent's.
  No token is echoed in the inventory. No profile-wide disconnect by agents.

## Remote access: expose Tray **management only**, never a screen view

The prior tunnel-based Desktop Live viewer was removed.
**Do not expose raw Desktop Live frame/start/challenge endpoints, Chrome CDP
debug ports, unmodified Core/MCP ports, or Tauri IPC through Cloudflare.**
No VNC/RFB server or screenshot feed may traverse the remote Tray gateway.

A separate, password-protected remote **management-only** HTML console is
implemented in `src/core/desktopUi/remoteTrayGateway.ts` and its frontend.
It can list verified handles, revoke exact sessions, sign out, and nothing more.
It executes in the **owning Core process**, not an independently spawned
viewer that would have stale or incorrect session state.

Security invariants:

- The gateway binds **127.0.0.1 only** on a dedicated, explicitly selected
  internal port (for example 19330, if available). This port is connector
  plumbing, **not** a supported user-facing local viewer URL.
- Browser users open only a dedicated **HTTPS** hostname. Named Tunnel uses
  a stable hostname; Quick Tunnel gets a temporary `*.trycloudflare.com`
  hostname from a separate Tray-owned `cloudflared` child, never the MCP tunnel.
- Exposed requests require the exact HTTPS Host, Cloudflare proxy metadata,
  a strict same-origin policy, and a *separately configured Tray password*.
  The gateway checks the password itself; Cloudflare headers are not passwords.
- Passwords are kept outside `tray-settings.json` in a local-only salted
  `scrypt` credential store. The stored value is a hash, never plaintext.
  Changes require the old password, except first enrollment. An update closes
  the management gateway and revokes all previously authenticated sessions.
- A successful login receives a five-minute `Secure; HttpOnly; SameSite=Strict`
  session cookie. POST actions require same-origin, an explicit CSRF proof,
  bounded JSON input, and strict action allowlists. Failed logins are throttled.
- Neither password knowledge nor remote website access grants screen capture,
  OS input, elevation, browser write authority, or native approval.
- Gateway activation is an **attended Tray action** in Settings → Security.
  Named mode starts only the local gateway; Quick starts a new, owned
  `cloudflared tunnel --url http://127.0.0.1:<dedicated-port>` process.
  Neither mode modifies the running MCP, Muse or other Cloudflare tunnels.
- Gateway status reports Named or Quick mode and whether an origin/connector
  was started. A generated Quick URL is not proof of external HTTPS reachability.
  Quick sessions are revoked when its owned connector exits or is stopped.

## Controls and source

- `apps/superagent-tray/ui/index.html` includes a restored Desktop Live
  navigation page with four filters, and the password and gateway controls
  on its Security settings subpage.
- `apps/superagent-tray/ui/desktop-live-manager.js` renders native/CDP/
  Delegate rows with DOM-only text (no arbitrary HTML, no frame rendering).
- `apps/superagent-tray/ui/tray-access-password.js` sets/rotates password and
  explicitly starts/stops the internal remote management gateway.
- `apps/superagent-tray/src-tauri/src/main.rs` has allowlisted native actions
  bound to the visible main Tray and authenticated loopback Core requests.
- `src/core/desktopUi/desktopLiveInventory.ts` uses the actual owner-managed
  OS window discovery, managed CDP registry, and Delegate coordinator;
  native and agent stop remain distinct operations.
- `src/core/browserTransport/sessionCoordinator.ts` now supports host-operator
  per-tab lease revocation under the existing target lock and durable checkpoint.
- `src/core/desktopUi/trayManagementPassword.ts` handles credential storage.
- `src/core/desktopUi/trayRemoteRuntime.ts` owns Named/Quick management mode
  and the dedicated gateway in the existing Core.
- `src/core/desktopUi/trayQuickTunnel.ts` launches a new Quick-only connector,
  validates the generated Cloudflare hostname and stops only its own child.
- `src/serverRoutes.ts` rejects forwarded/remote HTTP for local native
  administration. Remote browser requests use the separate gateway, never
  the Core admin API routes.

## Human takeover versus read-only viewing (17 November 2026)

The local native Tray preview is approved window-by-window with an attended OS
dialog and an exact PID/native window handle. **Preview consent is not input
consent.** The Tray's native Take over action revokes an exact session via the
authenticated `stop-handle` bridge; it does **not** promise to force a window
into the foreground or issue mouse/keyboard events. Managed CDP takeover
continues to use the existing revision-checked human hold and agent write fence.
Individual Delegate tab release uses numeric tab IDs and exact expected
revisions. Connected LAN device stops route to the LAN controller, not the
native-window PID parser, and a rejected disconnect is never reported as success.

The legacy `/api/desktop/live/lan-preview` and `lan-frame` HTTP endpoints are
now **loopback-only**, even when the caller is on a private RFC1918 network.
Their minimal local viewer uses a URL-fragment token removed from browser
history, a same-origin JSON POST frame request, no-cache headers, and a
nonce-based CSP. They are not an advertised remote browser/viewer service.
The legacy `lan-input` and `lan-takeover` endpoints always refuse requests:
an image-preview capability cannot authorize clicks, typing, or human takeover.
No cleartext screenshot feed is exposed to Wi-Fi or Cloudflare.

Remote screens across devices remain subject to separate mTLS 1.3 transport,
independent host/viewer identity, private certificate provisioning, and
attended controller approval. These controls are intentionally fail-closed until
installed runtime and release certification. A paired Android/Windows LAN
device uses its separate device-specific `lan_support_action` authorization
policy, not the native desktop preview token.

**Current verification boundary:** GitHub source and regression tests were
updated; this does not establish a clean build, live host takeover, installer
readiness, or a published release. A real OS E2E should verify the
agent-to-human-to-agent handoff, revocation races, active foreground, and
disconnection behavior before promotion.

## Independent Viewer and Controller UX (17 November 2026)

The Desktop Live panel now displays **two separate authorization areas**:

- **Viewer · View Only**: the host's own OS permission dialog and exact
  window identity grant the five-minute local native preview. LAN Android
  viewing uses a distinct device-approved support session. Viewing is never
  a mouse/keyboard approval.
- **Controller · Mouse & Keyboard**: **Request Control** is a separate
  operator action. On native application windows it opens an attended
  informational Tray dialog and returns `NOT_CONFIGURED`; no controller
  token or OS action is issued until independently verified remote input
  provisioning and native semantic adapters have been certified. On a paired
  LAN Android device it opens the input UI only after explicit user action;
  every touch/text/navigation command must still be accepted by the phone
  under its separate Accessibility/input consent. The Windows LAN client is
  still discoverable/manageable, but its screen and input actions are labelled
  unavailable in this transport instead of claiming unsupported control.
- **Take Over**: locally revokes agent/native preview access on the exact
  window. The host operator then uses physical mouse and keyboard; this is
  distinct from remote controller access.
- **Return to Agent**: for an existing managed CDP human hold, the Tray and
  password-protected management console offer a revision-checked return.
  It refuses to bypass an active takeover reservation, changed browser
  fingerprint, stale target, or mismatched revision. Native apps and
  Delegate tabs do not automatically regain an agent session by clicking
  this action.

The operator inventory returns `access.view` and `access.controller`
independently, with `independentlyApproved:false` in the informational
snapshot. That snapshot is **not** an authorization source; actual native
input remains guarded by `RemoteControlAuthority` and
`RemoteNativeInputDispatcher` with fresh, attended approval and
nativeRef-only dispatch. No viewer token is ever accepted for input.

Tests added: `desktopLiveAccessModes.test.ts`, extended
`desktopLiveTakeoverAuthorization.test.ts`, and
`trayManagementSurface.test.ts`. These are source regression tests; clean
CI and installed host E2E certification are still required before claiming
full remote-controller readiness.

## Android controller end-to-end authorization contract (17 November 2026)

The paired **Android** transport now implements a separate native controller
consent path in both Desktop Live and the dedicated LAN Devices screen:

1. A read-only viewer can open an existing owner-approved support session,
   without receiving any controller authority.
2. **Request Mouse** and **Request Keyboard** are distinct operations. Each invokes the installed, visible main Tray only. Rust
   identifies the exact connected Android device/fingerprint by asking the
   authenticated Core, then requests a one-use Core challenge for that
   specific support-session generation.
3. Each separate, attended **operating-system dialog** names the target,
   fingerprint, and **mouse or keyboard** permission. If approved, Rust
   generates a kind-bound, domain-separated HMAC using
   the protected local native key. Core validates the signed proof,
   the challenge deadline, current pairing fingerprint, and a private
   digest of the *current support session ID/token*. It issues a new
   independent, random 256-bit controller token with a **120-second TTL**.
4. The controller token is returned only to **native Rust memory**. It is
   not sent to the WebView, screenshot, viewer URL, MCP or discovery list.
   The native `lan_support_action` bridge injects it internally only for
   `input` and `element`. Core refuses both without a valid, current
   token, even when a caller knows the ordinary Core bearer and a viewer
   session is active. **Mouse approval permits only tap, swipe, and semantic
   click. Keyboard approval permits only text and navigation.** Each token
   can expire or be revoked without elevating the other. Attended, proof-bound
   viewer/input operations do **not** require autonomous-agent Full YOLO:
   target owner consent and native host approval remain independent,
   mandatory guards. Remote shell, file operations and autonomous execution
   retain their distinct Full YOLO/security approval policy.
5. Native and Core grants revoke independently on explicit revoke, session
   close, reconnect, device identity drift or expiry. A hidden main Tray
   cannot invoke input. A new approval is needed after a reconnect, even
   if the Android device's pairing identity did not change.

A late host approval after the viewer stopped or the target changed is
immediately revoked rather than being promoted to a current controller.
UI accessibility/status presents separate mouse/keyboard ready states and
revoke actions; Core and Rust enforce the same separation.

Windows LAN capture/input remains unavailable in this Android-specific
transport; do not show functioning controls for it. Local native
Windows/macOS/Linux application *remote* interactive control is still
**disabled** until an authenticated private viewer transport, independently
attended OS input approval, and verified semantic adapter are integrated
and physically tested. Existing native source/installer artifacts do not
by themselves certify a usable end-to-end remote controller.

Source regressions: `nativeAndroidControllerApproval.test.ts`,
`desktopTrayAndroidScreenUi.test.ts`, `androidLanRemoteScreen.test.ts`,
`androidLanSchemaFirst.test.ts`, and the native Rust gate tests.
The separate `Desktop Live Controller Regression` CI workflow covers
TypeScript, Windows/Linux contract tests, and a Windows native Rust job.
Do not claim Installed Runtime Verified or Released from source tests alone.

## Deployment and verification status

The feature code can be built and tested **without** changing active MCP tunnel
ingress or running the installed Tray. The operator must configure a strong
password and select either Named mode (dedicated HTTPS hostname/ingress) or
Quick mode (temporary HTTPS hostname generated by a separate cloudflared
process). After activating from the installed Tray, verify login, logout and
session revocation from another device. No public URL, installed binary or
live external reachability is claimed until independently tested.

Checks:

```sh
bun --bun x vitest run tests/desktop-live --maxWorkers=2
bun --bun x tsc --noEmit
bun run build
git diff --check
```

The gateway tests use a disposable loopback listener and simulated operator
inventory; they prove password, cookie, CSRF, and deny behavior, not real
Cloudflare DNS/ingress or a signed installed Tray binary.
