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
