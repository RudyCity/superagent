# Senopati shared inference: watchdog freshness and bounded acceptance

Date: 26 October 2026
Workspace: SuperAgent on local Windows/Bun
Scope: guarded INT8 shared inference only. No public external provider, notifications, tunnel restart, model kill, or CLI/T-Line restart.

## Baseline and observed results

- Watchdog PID: 22204, live with fresh heartbeat, total restarts: 1, failed checks: 0, circuit breaker closed.
- Shared model PID: 10988, precision: `int8_embedding`, tokenizer: `rust-native`, RSS: approximately 579 MiB.
- Local CLI session was online and MCP tunnel active; the browser bridge and other optional channels were independently reported by their own status commands.
- Synthetic burst probe: `bun scripts/senopati-burst-probe.ts 16 4 followup` — 16/16 successful, 0 failures, median 249 ms, P95 272 ms. Short, synthetic, cache-influenced CPU measurements are not service SLOs.
- Existing five focused suites passed 33 tests before changes.

## Follow-up hardening

- `src/core/senopatiWatchdogStatus.ts` now considers a stored `healthy:true` meaningful only with a live PID and a fresh heartbeat. It refuses stale heartbeats and timestamps implausibly in the future (small 1-second adjustment tolerance).
- `scripts/senopati-watchdog.ts status` reports `heartbeatFresh` and delegates the live/healthy interpretation to that validated reader. An unreadable or stale record cannot be presented as an active, healthy watchdog by the CLI status command.
- Added `tests/senopatiWatchdogStatus.test.ts` with positive and negative cases for live, stale, future-dated, dead and invalid owners.
- Added `scripts/senopati-recovery-soak.ts`, a bounded, non-destructive acceptance probe. It reads private IPC health and watchdog metadata, performs synthetic retrieve inference, and asserts process ownership and uninterrupted PID continuity. The inference requests increment model counters/cache; no process is spawned/stopped and no report is persisted.

## Verification

- `bun --bun x vitest run tests/senopatiWatchdogStatus.test.ts tests/senopatiWatchPolicy.test.ts tests/senopatiStartLease.test.ts`: 20/20 passed across 3 suites.
- `bun --bun x tsc --noEmit --pretty false`: passed.
- `bun scripts/senopati-recovery-soak.ts 12 1000`: 12/12 health samples, 4/4 synthetic retrieve predictions, 11.043 s wall time, stable watchdog PID 22204 and model PID 10988, RSS min/max 579/579 MiB and end-minus-start 0 MiB.
- `bun scripts/senopati-watchdog.ts status`: active, fresh and healthy with unchanged owner PIDs.

## Limits and next acceptance gates

- The historic live force-kill result (4.85 seconds model-only restoration) remains recorded in the V6.9 report; this follow-up did **not** repeat any forced kill or planned model drain.
- The soak window is short and cannot rule out a multi-hour memory leak or prove real Windows login reboot restoration.
- Packaged T-Line GUI reconnect across a real model-only crash, prolonged model throughput, and independent human safety review remain separate validation tasks.
- The classifier is not a tool authorization layer. All original permission and destructive-command guards remain in force.
- Unrelated concurrent workspace edits were not modified.
