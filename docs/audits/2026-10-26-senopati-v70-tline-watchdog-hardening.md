# Senopati V7.0 — guarded desktop status and self-healing

Date: 26 October 2026
Scope: Phase 1 (read-only T-Line/CLI model readiness) and Phase 3 (fail-closed recovery watchdog).
No external alerts or provider access. No implicit chat replay, tool authorization, CLI/transport/tunnel restart, or destructive model-owner kill.

## Phase 1 — Desktop and CLI model status

- `src/core/senopatiReadiness.ts` projects a cheap, read-only, last-known status based on the guarded shared-only policy and validated watchdog heartbeat. It does not open an IPC connection or load another model.
- The authenticated `GET /api/status` response now includes `senopatiInference` with `healthy`, `degraded`, or `disabled`, and an explicit legacy fallback contract. This remains just a status hint and is *not* proof of next-request availability.
- The existing T-Line front-door reconnect probe reads that optional field from `GET /api/status`; it never reconnects/replays chat because of model degradation. A 200 response with a verified session ID remains a connected session even if shared model inference is degraded.
- The CLI `senopati doctor` checks matching watchdog/model ownership before marking healthy and reports the same inference readiness projection.
- Independently, `inferModernPrediction` already returns null in shared-only mode when its IPC is unavailable; the guarded classifier's original tiny/legacy path remains the fallback, without loading an extra ONNX mmBERT per client.

## Phase 3 — Bounded model recovery

- `src/core/senopatiWatchPolicy.ts` now spaces successive restart attempts by 2, 4, 8 seconds (maximum 30 seconds), while still enforcing two failed checks, at most four attempts per rolling ten minutes, and the ten-minute circuit breaker.
- The model-only watchdog now refuses an automatic replacement when a verified shared IPC registry still points to an OS-live but unresponsive model owner. The status gives `unresponsive-model-owner-needs-operator-review`; no PID is killed or guessed to be safe.
- Starting a watchdog against a live PID with a stale heartbeat now refuses silently declaring successful monitoring; an operator must inspect the owner. Unknown/corrupt startup leases keep fail-closed behavior.
- No action is authorized by classifier intent; existing destructive-command and runtime permission boundaries remain separate.

## Verification

- Focused regression suites include policy, readiness projection, T-Line probe (GET-only), watchdog heartbeat, IPC, queue, exclusive lease, and core reconnect. All must pass before commit.
- Server authentication regression verifies status still requires its normal server credentials.
- TypeScript compilation must pass with no emission.
- Runtime `senopati doctor` confirms current model/watchdog ownership and native INT8/Rust tokenizer.
- The live watch process must be restarted **on its own** to pick up watchdog source changes. Existing CLI/T-Line/MCP/tunnels are never restarted as part of that step.

## Remaining acceptance boundaries

- Packaged T-Line's actual native UI renderer and GUI reconnect flows have not been verified; this is a backend/API contract plus mocked T-Line probe tests.
- Exponential backoff and owner-stall handling have unit/code verification but a real hung ONNX native model cannot be safely injected on a running shared production-model process.
- No Windows OS reboot, multi-hour soak, independently adjudicated natural safety-gold review, or complete production SLO certification was performed.
- Reconnect health probes remain GET-only; no implicit resume/POST or ambiguous turn replay.

## Local non-disruptive activation evidence (26 October 2026)

- The pre-update watchdog PID 22204 was stopped using its own owner-controlled model-safe stop command. It confirmed the shared model remained running. Its successor watchdog PID **30908** started with a fresh heartbeat.
- The shared model remained PID **10988** throughout the watchdog handover, `int8_embedding`, native Rust tokenizer. The 8-request/2-concurrent synthetic burst passed **8/8** (P95 approximately 143 ms).
- A subsequent non-destructive 12-sample/11.037-second soak passed **12/12** owner/health checks and **4/4** synthetic retrieve inferences. RSS observed 579–580 MiB, end-to-start delta 0 MiB.
- A fresh `senopati doctor` reported healthy and matching watchdog/model owners. The existing CLI PID 13424, port 7888, and OAuth MCP listener port 6789 remained online. External services were not restarted.
- **Rollout limit:** Port 7891 had no T-Line transport listener at inspection time. The currently running global SuperAgent core is an installed `dist/cli.js` build and was not restarted/rebuilt. The new `GET /api/status` inference field is committed to source and tested, but **not yet verified on the live installed core or packaged T-Line GUI**.
