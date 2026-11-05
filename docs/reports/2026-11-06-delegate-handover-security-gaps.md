# Delegate handover security gaps — Worker C, 2026-11-06

## Scope / evidence

Read-only review of `src/core/delegate/delegateListenerPreference.ts`, `delegateListenerLifecycle.ts`, `delegateListenerRecovery.ts`, `src/core/runtime/coreDelegateHandover.ts`, `src/serverRoutes.ts` (especially 1155–1272) and `coreSupervisorCheckpoint.ts`. Isolated fake-worker tests: `tests/delegateListenerSupervisorGates.test.ts`. No live worker, port, pairing, config, supervisor owner or tunnel modified. A mock is not proof of real end-to-end handover.

## Findings and recommended changes

1. **High — TOCTOU RPC drain**: `coreDelegateHandover.ts:80–85` validates an old worker's pending count *before* stopping it, but the worker may accept a new RPC between status and stop. `delegateListenerLifecycle.ts:24–31` likewise checks pending once before an awaited close; concurrent arrivals may race. Implement an atomic listener quiesce operation inside the bridge that refuses new RPCs, waits for existing RPCs with a deadline, then closes; verify operation/generation identity in its response. Require a recheck after quiesce. Cover race in a real transport integration test.

2. **High — checkpoint injection bypasses freshness check**: `delegateListenerRecovery.ts:70–79` re-reads the supervisor checkpoint only when `options.checkpoint` is absent. The injected checkpoint path is useful for tests but should not be reachable in production without an explicit test-only capability. More importantly `delegateListenerRecovery.ts:72–78` checks activePid and worker tuple membership, not checkpoint revision/nonce, inspectToken rotation, current active generation's identity or process birth identity. Require a supervisor-signed, short-lived generation lease bound to exact worker identity, checkpoint revision and operation nonce; revalidate immediately before mutation. Avoid accepting a caller-provided checkpoint in production code.

3. **High — handover API trusts caller port/token tuple**: `coreDelegateHandover.ts:71–80` accepts arbitrary previous/next loopback ports from its caller. `callCoreWorkerDelegateBridge` only checks port range/token length at `coreDelegateHandover.ts:27–30`. A bearer credential cannot itself prove the target is a supervisor-owned worker. Enforce checkpoint-backed exact worker PID, port, generation and transport-isolation attestation in the handover entry point, not just inside the separate recovery path. Bind transient requests to inspection capability and refuse supervisor handover if missing.

4. **Medium — preference can change during handover**: `coreDelegateHandover.ts:77–90` samples manual OFF/ON once; a concurrent explicit Stop after the read could allow next worker Start. `delegateListenerLifecycle.ts:11–21` serializes only *per bridge object*, not across generations/processes. Add supervisor-wide monotonic desired-state revision and compare-and-swap at start, re-read after stop, and ensure manual OFF wins concurrent handover. A fake callback test does not establish cross-process ordering.

5. **Medium — unverified legacy socket/RPC handling**: `coreDelegateHandover.ts:62–69` and `delegateListenerRecovery.ts:57–61` allow `pendingRequests: 0` even with active sockets, assuming the worker's count is trustworthy. `coreDelegateHandover.ts:54–58` permits negative pendingRequests/openSockets. Enforce non-negative bounded counters, strict generation attestation and transport-side drain barrier; treat unknown counts as busy when any sockets exist.

6. **Medium — recovery rollback race**: `delegateListenerRecovery.ts:100–108` restores a retained listener if starting the new one fails, but does not reverify the old worker's generation/active owner before rollback. `coreDelegateHandover.ts:89–99` has similar risk. Revalidate the supervisor lease immediately before rollback; if ownership changes, report an uncertain outcome instead of issuing a stale Start.

7. **Medium — lifecycle supervisor check not proof of identity**: `serverRoutes.ts:1232–1245` gates `transient` on worker environment plus a 64-character shared inspect secret; it does not by itself bind request to current supervisor operation ID, generation or exact caller worker. The outer API bearer gate is assumed by the router and must be verified by integration tests. Add operation-scoped nonce, worker identity and replay protection; test unauthenticated/remote/invalid-token requests against an isolated HTTP app.

8. **Low/Medium — persistence crash window**: `delegateListenerLifecycle.ts:23–49` writes desired preference before start/close and rolls back only on caught errors. Crash or termination between persistence and bridge mutation may leave desired and observed state inconsistent. Preserve durable operation intent with a reconcile-on-boot routine; never auto-override explicit OFF. `delegateListenerPreference.ts:36–52` uses atomic rename but does not fsync parent directory; durable power-loss semantics may differ across platforms.

9. **Medium — pair-code stop boundary**: `serverRoutes.ts:1175–1193` rejects renew-pair-code when bridge is stopped, but this is a non-atomic status check preceding renew. Add a bridge-internal atomic running check, block renew while quiescing, invalidate outstanding codes on Stop, and integration-test that no pairing succeeds after Stop. The isolated suite covers no new listener Start while OFF, **not** a real browser pairing handshake.

## Gate matrix

- Manual OFF across simulated restart; no new worker Start: covered with fake callbacks.
- Stale active checkpoint and mismatched server token: rejected before callbacks using injected checkpoint; actual disk checkpoint swap not exercised.
- Supervisor HTTP credential: request header/URL/body contract covered by mocked fetch; inbound route auth is code-reviewed, not route-tested.
- In-flight RPC (known and legacy unknown counts): fail-closed before Stop in deterministic mock.
- Stopped pairing: no Start while OFF tested; real pair-code invalidation is an **open integration gap**.
- Concurrent transitions: per-object lock tested; cross-worker concurrency **open**.
- Rollback and double rollback failure: simulated.

## Go / no-go

**NO-GO for claiming production-safe zero-loss handover based on these tests alone.** Require quiesce/acceptance barrier, checkpoint generation lease, atomic desired-state versioning, HTTP route auth/stop-pairing integration, and real two-worker fault-injection before release. No service mutation authorized by this worker.
