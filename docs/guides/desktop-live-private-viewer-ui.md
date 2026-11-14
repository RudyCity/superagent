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
- Browser users open only a dedicated **HTTPS** hostname protected by a
  Cloudflare Named Tunnel. Never reuse the active MCP hostname/route.
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
  It does not install services, change DNS, start cloudflared, restart Core,
  or modify the active named MCP tunnel.
- Gateway status distinguishes a **local internal listener** from a publicly
  *verified* HTTPS/Named Tunnel route. A listening origin does not mean the
  remote URL is reachable. Network routing and end-to-end external access
  require independent verification before claiming completion.

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
- `src/core/desktopUi/trayRemoteRuntime.ts` starts/stops only the dedicated
  remote management gateway inside the existing Core.
- `src/serverRoutes.ts` rejects forwarded/remote HTTP for local native
  administration. Remote browser requests use the separate gateway, never
  the Core admin API routes.

## Deployment and verification status

The feature code can be built and tested **without** changing active tunnel
ingress or running the installed Tray. The operator must still set a password,
select an approved dedicated HTTPS hostname/port, activate the gateway from
the installed Tray, configure the named tunnel to forward **only** that hostname
to the dedicated origin, and verify both access and revocation from another
device. There is **no claim** that this has been deployed or is reachable online.

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
