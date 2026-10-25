# Senopati V6.8 — Watchdog recovery and multi-agent load hardening

**Date:** 25 October 2026
**Workspace:** SuperAgent on Windows/Bun
**Scope:** Local INT8 mmBERT semantic intent inference only. The old lightweight Senopati ONNX still guards destructive commands and remains the fallback; model outputs do not authorize tools or private data.

## What was implemented

- `src/core/senopatiSharedQueue.ts`: bounded FIFO scheduler (4 active ONNX requests, 64 waiting), 7-second queue wait limit, immediate overload denial, queue accounting, and cancellation of pending requests whose client socket disconnects. Active native inference is allowed to drain rather than unsafely interrupting ONNX.
- `src/core/senopatiSharedServer.ts`: integrates scheduler into the authenticated local named-pipe service, exposes `active`, `queued`, `overloaded`, `queueTimedOut`, and `queueCanceled` counters without logging message text. It limits payload sizes, refuses invalid bearer credentials, and accepts only intent requests. Runtime permissions, MCP ACLs and tunnels are out of scope.
- `src/core/senopatiSharedClient.ts`: bounded IPC request, with timeout and a 12-second absolute deadline. Failure always means no new mmBERT result; the legacy classifier handles the turn without loading a duplicate large model.
- `src/core/senopatiWatchPolicy.ts` and `scripts/senopati-watchdog.ts`: single-owner detached watchdog, two failed health checks before restart, at most four restart attempts in a rolling ten minutes, ten-minute circuit-breaker cooldown, no external alerts, and an explicit `stop` that leaves the model and all other agents/tunnels running. A precision mismatch requires manual safe reload rather than automatic termination of a healthy owner.
- `scripts/senopati-burst-probe.ts` and `scripts/senopati-multiprocess-bench.ts`: synthetic load tests without customer data or privileged actions.
- Tests: `tests/senopatiSharedQueue.test.ts`, `tests/senopatiWatchPolicy.test.ts`; additional guardrail/IPC tests remain active.

## Measured before/after load

The original shared server (no bounded queue) handled **21/48** requests, failing **27/48**, under 16 simultaneous requests. With the new queue and watchdog recovery installed, the same 48-request/16-concurrent probe achieved **48/48** and 0 failures. A second 96-request/24-concurrent probe achieved **96/96**. At 128 requests/40 concurrent requests the model achieved **128/128**, though this last probe may reuse some earlier synthetic inputs through the server cache.

A four-process stress run sending **192 unique** synthetic requests (48 per process, per-worker unique identifiers) achieved **192/192 responses, 0 failures** and reused **one shared model PID**. Total run time was **12.3 seconds** (p95 request time approximately 3.2 seconds per worker). The shared server's resident memory was around **576 MiB**. This is local CPU testing, not a guaranteed throughput/latency SLO.

## Recovery evidence

Initial shared model PID 10232; watchdog was started at PID 54836 without stopping the service. Its first controlled recovery restarted only the shared inference server at PID 38516. The watchdog itself was then gracefully replaced without taking down the model (new watchdog PID 44500). A subsequent controlled inference-service restart was automatically recovered into model PID 53800. Other SuperAgent CLI/T-Line/MCP/tunnel processes were not stopped. These were **controlled graceful server stops**, not a forced-kill crash test, and must not be described as proof of restart after all possible faults.

After the last code synchronization, use the status commands below to confirm the current live PIDs. Never depend on the historic PIDs in this report.

## Operator commands

From the SuperAgent repository root:

```bash
bun scripts/senopati-watchdog.ts start
bun scripts/senopati-watchdog.ts status
bun scripts/senopati-shared.ts status
bun scripts/senopati-model.ts status
bun scripts/senopati-multiprocess-bench.ts 4 48
```

For planned maintenance, **stop the watchdog first**, then the shared inference process:

```bash
bun scripts/senopati-watchdog.ts stop  # leaves inference service online
bun scripts/senopati-shared.ts stop    # stops only shared inference
```

To re-enable recovery after maintenance:

```bash
bun scripts/senopati-shared.ts start
bun scripts/senopati-watchdog.ts start
```

If the model service stops while the watchdog remains running and the `shared_only` policy is active, the watchdog attempts a safe local restart with bounded backoff. If restart attempts fail, the circuit breaker pauses further attempts while client calls fall back to legacy Senopati.

**Limitations:** this watchdog runs during the current OS session; it does not install a Windows Scheduled Task or OS-login startup entry. Relaunch the watchdog when the application starts after a reboot. A completed test is not proof of a live authenticated backend tenant/RBAC E2E, production safety-head readiness, or independent human gold performance. Do not promote Noul scores to tool permissions.

## Verification

- Queue/watchdog unit tests **13/13 passed** after adding disconnected-client cancellation cases.
- Combined regression of 8 relevant Senopati and MCP policy suites: **61/61 passed**.
- Whole-project TypeScript type check passed: `bun --bun x tsc --noEmit --pretty false`.
- Active policy remains `precision=int8_embedding`, `inferenceMode=shared_only`.
- Large model assets are still SHA256 pinned and excluded from Git.
- No broad Git commit or unrelated workspace cleanup was performed.

## Final post-upgrade verification

After the disconnect-cancellation and absolute-RPC-deadline changes, the
watchdog gracefully replaced **only** the Senopati shared inference process
and verified the latest code was active. The shared model PID at final check
was **42180**, with watchdog PID **44500**; both were healthy, with
`int8_embedding`, native Rust tokenizer, and `shared_only`.

The final **cache-separated** test used four separate Bun clients, 48 unique
requests per process (192 total), with unique test identifiers for this new
run. **192/192 succeeded, zero failures**, one shared model process,
total wall time 15.1 s, and worker p95 request times 4.1–4.3 s.
The server's current RSS after that test was about 573 MiB. The report is
stored in the ignored local model directory as
`multiprocess_load_report_v3_final.json`.

Final targeted security, IPC, queue, watchdog and model adapter regression:
**61/61 tests passed across 8 suites**. Whole-project TypeScript
`--noEmit` passed. A compiled-classifier smoke retained the destructive
`rm -rf /` hold and retrieved a synthetic documentation request correctly.
The watchdog start command recognized the existing owner instead of
starting a second watchdog. This is **not** a forced-kill crash test and
is not an OS-login/autostart installation.

Requests from disconnected clients are removed from the pending queue
without running ONNX; a single already-executing ONNX call cannot be
forcibly cancelled. The service now exposes cancellation and queue
telemetry as independent counters. The watchdog does not send external
notifications.
