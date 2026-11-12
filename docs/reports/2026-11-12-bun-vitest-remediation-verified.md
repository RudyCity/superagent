# Bun / Vitest Telegram Poller Remediation Verification

**Date:** 2026-11-12
**Result:** Targeted regression and build PASS; full-suite soak not yet run.
**Original RCA:** `docs/reports/2026-11-12-bun-vitest-memory-leak-rca-and-remediation.md`

## Fix applied

The runaway memory reproduction involved a Telegram `pollEnvelopes()` loop left active after an assertion failure. A later Vitest mock replied with HTTP 200 `{ "ok": true }` lacking `result`, creating an unthrottled loop and retaining many mock call records and abort listeners.

- `src/core/remoteAgent/museClient.ts`: claim the per-client polling lock synchronously before awaiting the cross-process lease; release the lease and clear the lock on every exit path.
- Add exponential, abortable backoff to malformed successful responses. Bound immediate timeout/rejection retry loops; retain normal 429, 409, HTTP and network error backoff.
- Dispose of per-request timeout timers and parent abort listeners in `finally`. Polling delays also clean abort listeners when they complete.
- `tests/remoteAgent.test.ts`: always abort and await the original poller in `finally`; add a regression proving malformed HTTP 200 cannot trigger rapid repeated `getUpdates` calls.

## Observed verification

| Gate | Result |
| --- | --- |
| `bun --bun x tsc --noEmit` | PASS, exit 0 |
| `bun --bun x vitest run tests/remoteAgent.test.ts --reporter=dot --maxWorkers=1` | PASS, 52/52 |
| `bun --bun x vitest run tests/museTokenRefresh.test.ts tests/telegramPollingLease.test.ts tests/remoteAgent.test.ts --reporter=default --maxWorkers=2` | PASS, 65/65 |
| `bun run build` | PASS, exit 0 |
| Windows process inspection after tests | 0 remaining Vitest fork/worker Bun processes; approximately 22.76 GB available physical RAM |

This verifies the reproducer's failure chain is addressed. It does **not** establish that every possible Bun memory spike is eliminated, or that the separately reported historical PID can be conclusively attributed to this reproducer. A long-duration soak and full test suite are separate gates. No production owner, MCP tunnel, or live sessions were restarted for this change.
