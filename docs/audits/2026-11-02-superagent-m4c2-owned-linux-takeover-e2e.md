# SuperAgent M4-C2 — Owned Linux Human Takeover Component E2E and WSLg Remediation
Date: 2026-11-02

## Scope / source of truth

- Repository: `RudyCity/superagent`, branch `main`, starting HEAD `ac499267`.
- No new branch/worktree; user-owned untracked `artifacts/` untouched.
- This milestone uses **real Linux Chrome owned by BrowserProcessManager, real VNC/noVNC, real takeover session manager and the production WebSocket proxy** with a temporary loopback HTTP harness. It is a component-level E2E, NOT deployment of the full production Core HTTP server or TLS/OIDC gateway.

## Findings and implemented fixes

### 1. WSLg abstract Unix X11 socket handling
In Ubuntu 24.04 WSLg, `/tmp/.X11-unix` is a read-only 0777 mount; Xvfb can bind `@/tmp/.X11-unix/X99` in the **Linux abstract Unix namespace** but not create the expected filesystem pathname. Previously VirtualDisplayWorker waited 10 seconds and falsely failed startup.

- `virtualDisplayAllocation.ts`: probes Linux abstract X11 socket in addition to filesystem socket and system lock so an already listening display cannot be reallocated.
- `virtualDisplayWorker.ts`: accepts either filesystem or live abstract X11 socket during readiness and health checks.
- Launches `x11vnc` with `WAYLAND_DISPLAY` **absent**, not set to empty string, and its own X11 DISPLAY/XDG_SESSION_TYPE. x11vnc detects global WSLg Wayland state merely from the variable's presence.
- Does not attempt to chmod or modify WSLg's read-only system mount.

Live evidence: managed Chrome/Xvfb/Openbox/x11vnc/websockify starts healthy and stops cleanly on display :99, using independently allocated ephemeral loopback ports.

### 2. Managed browser registration generation and profile ID mismatch

Process Supervisor creates generation `gen_<timestamp>_<pid>_<8 hex>`; the managed-browser registry previously accepted only the older `<numeric>-<numeric>` generation. Thus a live runtime was unregistrable and takeover failed before establishing the human hold.

- `managedBrowserRegistry.ts`: strictly accepts **both** legacy numeric generation and the exact Process Supervisor generation schema; arbitrary or path-like generations stay rejected.
- `takeoverSessionManager.ts`: human-facing runtime profile labels such as `Default` are not strict lowercase profile IDs. For missing profileId, derives a deterministic 16-hex-suffixed lowercase ID from invalid display labels without weakening validation for explicit profile IDs.
- `tests/managedBrowserRegistry.test.ts`: confirms canonical process generation passes and malformed/forged variants fail.

### 3. Real owned browser + operator-authenticated input/return

Reproducible scripts:
- `scripts/linux-takeover-owned-launch-probe.mjs` — real managed Linux browser and clean teardown, no worktree.
- `scripts/linux-takeover-owned-e2e.mjs` — full component chain, with isolated session/CDP storage in temporary directories:
  1. Launch Chrome with virtual-display mode through the actual BrowserProcessManager; verify Xvfb, Openbox, VNC/noVNC are live, and the abstract X11 socket is reachable.
  2. Discover the actual Chrome tab through CDP; invoke the real `requestTakeover` without special profile ID overrides.
  3. Assert agent writes are blocked; redeem the single-use invitation to obtain an operator capability and VNC password.
  4. Start a test-only localhost HTTP server, but dispatch WebSocket upgrades through **TakeoverWebsocketProxy.handleUpgrade** and Return to Agent through the production `TakeoverSessionManager`.
  5. `scripts/linux-takeover-input-smoke.mjs` supports the actual x11vnc **VNC Authentication** RFB type 2 (DES challenge) using the password issued at redemption. Test-only direct loopback VNC RFB type 1 remains supported for the earlier smoke.
  6. Send a mouse click and keyboard `a` across the operator-token-authenticated proxy into real Chrome and confirm actual Chrome DOM pointerdown/keydown via CDP.
  7. Disconnect and reconnect operator WebSocket with the valid token. Invoke operator Return to Agent, verify live browser fingerprint and original target reservation, and prove reconnect with the old operator token now returns HTTP **401**.
  8. Assert agent writes become available only after verified Return. Tear down managed Chrome and owned display services with positive process identity verification.

**Live result:** `M4C_OWNED_LINUX_TAKEOVER_E2E_PASS`, `M4C_LINUX_INPUT_PASS`, final `AGENT_ACTIVE`, and `M4C_OWNED_LINUX_CLEANUP {"success":true,"virtualDisplayStopped":true}`.

## Limitations / release gates

- The local HTTP wrapper calls the production manager and proxy, but **does not execute the full `runServer()` / production route middleware**, because that heavyweight Core path was not successfully launched in the isolated WSL environment. Therefore this is an **owned component-chain E2E**, not a full deployed-Core E2E.
- No actual physical mobile client, TLS/OIDC gateway, public exposure, multi-host split-brain, network partition fault injection, long-duration soak, or comprehensive CI matrix.
- Test processes, browser profiles, HTTP ports and session directories are ephemeral and loopback-bound. Do not copy test-only insecure settings to production.
- Windows scoped regression: **19 test suites, 137 passing tests, zero failures**.
- `bun run build` — PASS; `bun run runtime:acceptance` — PASS; `bun run security:bun` — PASS; `bun run verify:extension-js` — PASS (16 extension JavaScript files); `git diff --check` — PASS after whitespace cleanup.
- Final Linux owned-browser integration rerun after code changes: `M4C_LINUX_INPUT_PASS`, `M4C_OWNED_LINUX_TAKEOVER_E2E_PASS` (including HTTP 401 for stale operator token), and `M4C_OWNED_LINUX_CLEANUP` reporting success for browser and virtual display.
- The full 682-file regression baseline of M4-A has **not** been repeated after this change. Windows targeted results and the Linux owned component-chain run must not be described as full production certification.

**Verdict:** Linux owned takeover component E2E PASS; full production deployment remains **NO-GO** pending Core deployment, mobile/TLS/OIDC, failover, and CI certification.
