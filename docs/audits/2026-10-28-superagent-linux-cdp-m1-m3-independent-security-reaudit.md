# Independent security and functional reaudit: SuperAgent Linux CDP M1–M3
**Date:** 2026-10-28
**Reviewer:** Independent source inspection (not AGY's M3 implementer/reviewer)
**Scope:** Existing feature worktree `feature/linux-cdp-headless-m0-m1-20261028`; read-only source review and non-destructive local tests. No implementation edits, commits, merges, pushes, or deployment.
**Verdict:** **FAIL — NOT PRODUCTION CERTIFIED; DO NOT EXPOSE TAKEOVER REMOTELY.**

## Verified checks
- Independently ran `bun run build` followed by eight targeted suites covering browserRuntime and browserTakeover; exit code **0**, **73 passed, 0 failed, 222 expect calls**. These are Windows-host tests/mocks, not real Ubuntu + Xvfb E2E.
- Reproduced invitation URL authentication mismatch directly against `isRequestAuthorized`: a synthetic valid-format invitation link token gave `false`, so the main `/api/*` authentication gate rejects the generated landing-page URL without the separate server bearer credential. No actual credential was accessed or transmitted.
- Reproduced token redemption race with a synthetic session in a disposable OS temporary directory: **2 of 2 concurrent `redeemInvitation` calls succeeded** despite single-use semantics; temp directory removed after test.
- The prior AGY audit documents claimed full security compliance and reported different totals (142 vs 157). Both figures are not a substitute for negative tests of the findings below.

## Confirmed blockers / findings

### IA-01 — P0 — Takeover UI is not a functioning VNC client
`src/core/browserTakeover/takeoverUi.ts:401–405`: `initVncStream()` only constructs a WebSocket URL and logs a message. It never creates a browser WebSocket, loads a noVNC RFB client, renders frames, or forwards keyboard/mouse events. The `<canvas>` at lines 290 is inert. Mobile takeover is **not operational** even with a healthy server.

### IA-02 — P0 — Invitation cannot authenticate to the generated landing page
`src/core/browserTakeover/takeoverSessionManager.ts:250–256` returns `/api/browser/takeover/ui?sessionId=...&token=<invitation nonce>`. `src/server.ts:976–985` authenticates all `/api/*` paths with `isRequestAuthorized`, which compares URL `token` to the unrelated **core server bearer token** (`src/core/utils/serverSecurity.ts:78–87`). The generated invitation does not authenticate. The takeover UI's `fetch` calls (`takeoverUi.ts:338–343,366–370`) send no separate server bearer either. Independently reproduced `isRequestAuthorized(...) === false` for a synthetic invitation URL. Do NOT solve by putting the long-lived core bearer in the invitation URL.

### IA-03 — P0 — Single-use invitation redeem is raceable
`src/core/browserTakeover/takeoverSessionManager.ts:267–315`: check `invitationRedeemed` -> check token -> async save, without a per-session mutex, atomic compare-and-swap or file lock. Two concurrent redemptions both succeed. Reproduction: create a synthetic HUMAN_READY session with a valid test SHA-256 hash and execute `Promise.allSettled([manager.redeemInvitation(input,dir),manager.redeemInvitation(input,dir)])`; observed **2/2 fulfilled**. This defeats replay/single-owner guarantees.

### IA-04 — P0 — Agent-exposed tool can release a human hold
`src/core/tools/chromeBrowserTools.ts:613–659` exposes `return_to_agent` to agents with just `sessionId`, calls `requestReturn` and `verifyAndResume`. `takeoverSessionManager.ts:324–361,367–479` trusts caller-supplied `actor` and checks no human approval/actor-bound token. An agent can initiate return and release the hold it should be respecting, even if the human has not pressed Return. Also `/api/browser/takeover/return` at `serverRoutes.ts:854–870` only has generic core bearer auth. Fix with explicit per-session human/operator authorization and a control plane that prevents agent-originated release.

### IA-05 — P0 — PID ownership checks are not fail-closed
`src/core/browserRuntime/browserProcessManager.ts:407–426,476–485` allows termination when the tracked process has no `creationIdentity` or when the live identity lookup fails, and sends SIGKILL without refreshing PID identity following the wait. `src/core/browserRuntime/virtualDisplayWorker.ts:64–72,100–108` has the same problem. Therefore claimed “never kill an unverified or recycled PID” is **not proven** and contradicted by branches in source. Refuse signaling without both positively verified identities, and re-verify before every escalation.

### IA-06 — P1 — WebSocket authorization/state is checked only at upgrade
`src/core/browserTakeover/takeoverWebsocketProxy.ts:41–98` validates bearer and `HUMAN_ACTIVE` once, while `setupProxyTunnel` at lines 128–140 relays every subsequent message without rechecking session state/expiry/actor binding. Connections with a missing Origin are allowed (lines 52–57). The local WS uses a global core bearer rather than a redeemed target-bound capability. Add short-lived authenticated session capability, Origin-required validation, per-message or revocation-generation fences, expiry-driven socket shutdown and target/session binding. Tests only reject upgrades, not post-upgrade race/disconnect behavior.

### IA-07 — P1 — Remote access fail-closed flag and session sweeper are not wired
`remoteAccessEnabled: false` is declared (`takeoverSessionManager.ts:45–50`) but no check was found in `server.ts` WS upgrade, `serverRoutes.ts`, or proxy to reject remote paths based on this setting. `expireStaleSessions()` exists at `takeoverSessionManager.ts:533–562`, but has no production caller/scheduler in inspected source. UI countdown does not enforce server expiry. Keep external access OFF at ingress; implement server-side timed revocation.

### IA-08 — P1 — Takeover token exposed to CLI/agent context
`takeoverSessionManager.ts:250–255` returns a URL with the one-time secret; `takeoverNotification.ts:47–75` embeds the full token-bearing URL in `formatTakeoverCliAlert`; `chromeBrowserTools.ts:567–570` returns this text directly from the agent tool. This contradicts “metadata-only” notification and leaks the takeover capability into agent output/log capture. Issue capabilities through a dedicated secret delivery channel, never tool-visible logs or telemetry.

### IA-09 — P1 — VNC local service is unauthenticated and not bound to instance identity
`virtualDisplayWorker.ts:293–302` launches `x11vnc` with `-localhost -nopw -shared -forever`. Local untrusted processes can bypass agent/human authorization and directly operate the browser (even though default VNC is opt-in). `takeoverWebsocketProxy.ts:109–116` guesses noVNC port from display number; `takeoverSessionManager.ts:218` accepts caller-provided displayNumber with no verified BrowserProcessManager binding. Prevent direct bypass through isolated user/network namespaces and bind the session to the actual owned display/runtime and port, not guessed values.

### IA-10 — P1 — Browser/virtual-display startup and shutdown may leak processes
`browserProcessManager.ts:115–151` starts Xvfb before executable discovery and profile/flag validation, with no encompassing failure cleanup. On CDP startup timeout `browserProcessManager.ts:225–236` terminates the virtual display but not the Chrome child. These paths can strand processes, cause port collisions, or leak memory. Add a shared teardown/finally path and failure-injection tests.

### IA-11 — P0 release gate — No real Linux end-to-end verification
All provided test reports and the independently rerun tests are Windows-host checks. No live Ubuntu/Debian Xvfb/Chrome/noVNC handshake, mobile rendering/input, actual identity ownership, or crash/restart takeover has been demonstrated. Production must stay **NOT CERTIFIED**.

## Confidence and test coverage
- **Confirmed by source:** IA-01, IA-02, IA-04–IA-10.
- **Confirmed by new independent reproducible tests:** IA-02 and IA-03.
- **Confirmed tooling:** `bun run build` exit 0; 73 relevant tests passed across 8 files (222 assertions). Passing mocks do not disprove unsafe branches.
- **Not tested:** Real Linux VPS/container, end-to-end mobile video/input or external proxy; no live public exposure attempted.
- **Unchanged:** The underlying Git implementation, main worktree, branches, and production environment.

## Remediation order (do not merge or release yet)
1. **P0 security:** Per-session authorization/role verification, stop agent-triggered release, atomic one-time redemption, eliminate plaintext invitations from agent logs, fail-closed PID identity verification (including pre-SIGKILL).
2. **P0 functionality:** Correct invitation-to-HTTPS auth bootstrap without exposing core bearer, implement genuine browser noVNC RFB client and input transport, assert a working end-to-end same-session visual takeover.
3. **P1 hardening:** Ingress feature flag + authenticated Origin and CSRF handling, expiry/disconnect websocket revocation, dedicated browser OS namespace/uid, VNC local bypass isolation, correct display/noVNC port binding, process cleanup.
4. **Independent negative suites:** Add double-redeem race test (must yield 1 success), link-auth positive/negative tests, return denied to agent-origin callers, active WS post-expiry test, missing process identity refusal, startup failure orphan-cleanup.
5. **Real Linux E2E:** Ubuntu 24.04 non-root Chrome sandbox, Xvfb, window manager, local noVNC, login challenge synthetic page, phone/desktop takeover, crash and disconnect, return-to-agent; only then consider certifying.

**Release decision: FAIL-CLOSED.** The prior implementation/deep audit is an engineering baseline, not independent proof of secure or functional production takeover.
