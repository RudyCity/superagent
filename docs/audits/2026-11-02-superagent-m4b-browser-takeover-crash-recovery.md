# SuperAgent M4-B Browser Takeover Crash Recovery — 2026-11-02

## Scope, workspace, and release rule

- Repository: `RudyCity/superagent`, branch `main`, no feature worktree.
- Starting commit: `3458bc50` (M4-A Windows batched regression).
- Target: prevent agent browser mutations after Core restart, loss of human input transport, browser disappearance, and incomplete Return to Agent.
- **No unsafe forced resume, lock theft by age, or expansion of remote VNC/CDP access.**
- Existing unrelated untracked `artifacts/` is preserved.

## Implemented M4-B safeguards

1. **Durable target-lock introspection.** `readTakeoverTargetReservation` distinguishes a truly absent lock from a malformed/partial owner record. Corrupt directories, symlinks, oversized owner records and identity mismatches fail closed.
2. **Native handoff cannot bypass an active takeover.** `setManagedBrowserControl(mode: "agent")` checks the per-target reservation *inside the existing CDP coordination boundary*. Ordinary native API callers can release native-only holds, but may not bypass a takeover reservation. The takeover manager alone supplies an internal second argument with the authorized session identity after validating the human operator token. The HTTP route forwards only the JSON body, not this internal argument.
3. **Agent write fence survives loss of native hold.** `assertManagedAgentMayWrite` now checks the durable takeover reservation if the native human-hold file is absent. The target remains blocked between hold release and lease cleanup, and if the hold file disappears after restart.
4. **Startup fail-closed reconciliation.** A new Core manager reads persisted sessions. Interrupted `HUMAN_ACTIVE`, `RETURN_REQUESTED`, and `VERIFYING` transition to `PAUSED_NEEDS_REVIEW` with audit entries. Pending invitations are invalidated as `EXPIRED`. No reservation or human hold is automatically removed. The default singleton starts reconciliation once and entrypoints await its result before continuing.
5. **Operator-controlled resumption.** On an interrupted session, `requestReturn` requires the persisted operator-token hash, checks session expiry, and starts fresh verification. Live browser fingerprint, tab presence and same-session reservation ownership are validated before releasing the native hold. A missing or corrupt reservation returns `PAUSED_NEEDS_REVIEW`.
6. **Cross-process single-flight return verification.** An atomic per-session `.verify.lock` directory prevents two verifiers from resuming the same session concurrently. A verifier crash retains its lock and requires operator reconciliation, never an automatic timed unlock.
7. **Shared session root.** `SUPERAGENT_TAKEOVER_SESSIONS_DIR`, if supplied, must be absolute. Native CDP fences and the takeover manager read the same root, including deterministic isolated test fixtures.

## Verification evidence

- `bun run build` — PASS (TypeScript + MCP schema sync).
- `bun run runtime:acceptance` — PASS (Bun smoke, server auth, lifecycle, dependencies).
- `bun run security:bun` — PASS (no high/critical dependencies in gate).
- Targeted browser/runtime/CDP/process/MCP matrix (final rerun): **16 test files / 123 passing tests / zero failures**.
- New `browserTakeoverCrashRecoveryM4B.test.ts`: verifies malformed lease owners fail closed, 3 interrupted states preserve reservations, invalidated pending invitations cannot be replayed, operator return waits for startup reconciliation, and interrupted verifier locks are never stolen automatically.
- Updated `browserTakeoverRequestIntegration.test.ts`: real HTTP-mocked CDP backend and owned runtime; two concurrent verification requests yield one winner; restart causes review; browser outage prevents resume; authorized retry succeeds only with live identity restored.
- Updated `managedBrowserControl.test.ts`: native agent return is rejected while the takeover lease is owned; missing native hold still blocks agent writes; wrong internal owner proof is rejected.
- Updated `browserTakeoverSecurity.test.ts`: closed-tab fixture now creates a genuine target lease and still fails closed for the intended reason.

## Independent reviewer caveats — still required before production

- **Operator reconciliation tooling:** After a true crash in the narrow `verify.lock` interval, a stale verification lock intentionally blocks further attempts. An authenticated operator recovery path, including OS process-identity evidence and audit trail, remains to be designed and certified. Do not remove locks by age.
- **No-loss guarantee limitations:** The reservation plus native hold protect normal crashes. If *both* on-disk protections are manually tampered with or lost, the system cannot guarantee fencing; operator investigation and tamper-resistant storage are still needed.
- **Real noVNC disconnect:** The existing WebSocket proxy closes both tunnel sides and does not release the hold on disconnect, but a real end-to-end network drop/mobile reconnection chaos test has not been executed.
- **Linux environment:** No Ubuntu/Debian Chrome, Xvfb, VNC/noVNC or mobile touchscreen E2E completed in this Windows-only milestone.
- **Scale and concurrency:** Session listing is currently capped at 100 records; startup scanning under larger retention, multi-Core/process split-brain and cross-host ownership must be certified.
- **Operator client page reload:** A redeemed operator capability is not recoverable after browser page reload; any recovery feature must be operator-authenticated and preserve single-use invitation semantics.
- **Whole-suite regression:** M4-A had 5,485 passed / 25 skipped in bounded Windows batches. Only the 123 scoped tests and acceptance/security gates were rerun for this M4-B change; full M4-A regression has not been repeated after the new patch.

**Verdict:** M4-B fail-closed core hardening **PASS for the tested Windows scenarios**; full M4-B live certification and production release remain **NO-GO**.
