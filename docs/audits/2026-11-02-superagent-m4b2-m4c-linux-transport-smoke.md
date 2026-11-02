# SuperAgent M4-B2 Operator Lock Recovery & M4-C Linux Transport Smoke — 2026-11-02

## Scope, state and safety

- Repository: `RudyCity/superagent`, branch `main`, starting commit `a06c2639`.
- No Git worktree or feature branch created. Existing untracked `artifacts/` preserved.
- This is a hardening increment, not production certification.
- A takeover human hold and per-target lease are **not** lifted by stale-verifier reconciliation; only a separate, authenticated, live Return to Agent may resume agent writes.

## M4-B2 completed

1. A dedicated durable `takeoverVerificationLease.ts` records `sessionId`, owner PID, host-local OS process creation identity, random nonce and acquisition time in a restrictive owner file. Lock directories are created atomically. Crash before owner persistence remains an ambiguous lock and fails closed.
2. `verifyAndResume` uses the verified lock and releases it only if the same nonce, process and session are still recorded. Concurrent verifiers are refused.
3. `reconcileInterruptedVerification` requires: redeemed operator token, unexpired session, exact `PAUSED_NEEDS_REVIEW` state, explicit acknowledgement, and the exact session's durable target reservation.
4. The OS owner PID must be **absent**; PID present/unknown, corrupt or missing owner, unsupported birth identity, foreign lease, expired operator capability and active verifier are all denied. Age alone never authorizes recovery.
5. The operator action is authorized through local `POST /api/browser/takeover/reconcile-verifier`, guarded by the normal Core bearer, loopback socket and loopback Host, plus the redeemed human operator token. This endpoint is not a generic force-release or a privileged native-hold bypass.
6. A read-only eligibility check happens before writing a session audit entry, so rejected unlocks do not modify the persisted state. Authorized reconcile emits a write-ahead audit record before atomically quarantining the old lock, and writes a completion entry. Subsequent recovery still requires a fresh Return to Agent verification.
7. Restart reconciliation now scans the entire takeover ledger, rather than silently truncating to the first 100 sessions. Public/default listing stays capped at 100. Startup fails closed if the ledger exceeds 10,000 session records, pending operator review.

## Tested M4-B2 behavior

- Wrong operator capability denied.
- Missing acknowledgement denied.
- Live owner PID denied; active verification lock stays intact.
- Legacy empty/malformed lock denied.
- Expired token, wrong session state, alien target owner, unknown process creation identity denied.
- Proven absent owner can only clear its own `.verify.lock`; target reservation stays held and session remains `PAUSED_NEEDS_REVIEW`.
- 106 persisted interrupted sessions are all processed on Core restart.
- Two concurrent verification requests never both resume the same session.

## M4-C Linux native transport smoke

Linux environment: Ubuntu 24.04.1 LTS on WSL2 (kernel 5.15); installed `google-chrome-stable` version `156.0.8078.79-1`, `x11vnc`, `websockify`, `novnc`, with preexisting `Xvfb`.

Reproducible script: `scripts/linux-takeover-smoke.sh`. Executed as the non-root Ubuntu user on the Windows repository mounted at `/mnt/d/backup from pc asus/Documents Development/superagent`. The script:

- Chooses an available X display and three ephemeral local ports.
- Starts GUI Chrome using an isolated temporary profile on Xvfb and a loopback-only CDP endpoint.
- Starts x11vnc against that X display with WSLg Wayland variables removed, and websockify exposing local noVNC assets.
- Confirms CDP `/json/version`, at least one page from `/json/list`, and the raw RFB handshake `RFB 003.008` via a native Node 22 WebSocket.
- Uses a cleanup trap to stop owned processes and remove temporary profiles and logs.
- `-nopw` is permitted **only for this ephemeral loopback-only smoke**, not production deployment.

Result: `M4C_LINUX_LOCAL_SMOKE_PASS` for Chrome CDP + Xvfb + x11vnc + websockify/noVNC local handshake. Observed no lingering smoke-owned processes after cleanup.

## Verification matrix and remaining gaps

- `bun run build` — PASS, TypeScript/MCP sync.
- `bun run runtime:acceptance` — PASS, including server authentication.
- `bun run security:bun` — PASS, no high/critical advisories found by its dependency gate.
- `bun run verify:extension-js` — PASS, 16 JS files.
- Windows targeted regression: **17 suites, 128 passing tests** on the broad matrix; targeted 5-suite rerun **30 passing tests** after final audit-order change.
- Linux local Chrome/VNC transport smoke — PASS.
- No Git worktree created; original `artifacts/` unchanged.

**Still NO-GO for production:** true Linux SuperAgent end-to-end managed browser + authenticated operator takeover, simulated VNC input/mouse/keyboard, network disconnect/reconnect, failure injection in Rust/T-Line and Core process, multi-Core host fencing, noVNC TLS/OIDC gateway, long-duration load/chaos, all platforms' CI. The smoke uses unauthenticated VNC **only on isolated local loopback** and does not test production authentication.

## Operator recovery contract

An authorized local Core operator with a still-valid *redeemed* human session token may submit an explicit recovery request:

```json
{"sessionId":"<uuid>","operatorToken":"<human-only session capability>","acknowledgeInterruptedVerification":true}
```

Send it to `POST /api/browser/takeover/reconcile-verifier` with the authenticated Core bearer through loopback. Do not paste real operator or Core secrets into chat/logs. On `PAUSED_NEEDS_REVIEW`, a verified-dead owner allows mutex reconciliation but does NOT resume browser automation. A separate human `Return to Agent` action is required. If the operator token has expired or a lock lacks trustworthy owner evidence, this path refuses recovery and requires manual investigation; there is no force-unlock.

**Verdict:** M4-B2 scoped Windows hardening PASS, M4-C Linux native **transport smoke** PASS, complete Linux human takeover / production certification **NO-GO**.
