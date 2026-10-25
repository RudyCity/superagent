# Chat Runtime v3 — Isolated Supervisor Smoke & Recovery Safety
Date: 2026-10-25
Workspace: `D:\\backup from pc asus\\Documents Development\\superagent`

## Changes

- Supervisor state, credentials, and durable checkpoint paths now respect `SUPERAGENT_CONFIG_DIR`. Without an override the default remains `~/.superagent-r`, preserving existing installation behavior.
- `SUPERAGENT_CORE_STAGING=1` is opt-in and requires a **non-default** `SUPERAGENT_CONFIG_DIR`. In this mode, the first supervised worker doesn't own or start the fixed-port Vision helper, and staging can inspect and drain its own workers without affecting any globally shared sidecar.
- Supervised workers do **not** blindly call global `recoverInterruptedChatTurns()` when a new generation starts. The previous generation can still be running a legitimate turn against the same SQLite file. Unsupervised startup retains its conservative crash recovery. Per-generation/orphaned turn recovery requires separate owner-aware reconciliation and remains intentionally blocked from automatic replay.
- Reproducible local integration script `scripts/smoke-chat-core-staging.ts` builds on a random free loopback port, isolated temp config and workspace, sanitized environment, and an independently spawned Bun CLI supervisor. It does NOT invoke a model or tool.
- The staging smoke verifies authenticated status, successful chat initialization, actual SSE handshake, two generations simultaneously handling different sessions, a received heartbeat **from the old worker after hot restart**, hot rollback preserving both sessions, a synthetic running SQLite turn not being incorrectly interrupted by the new worker, and uninterrupted pre-existing local listeners on 7888 / 9864 / 7666.
- Finalizer terminates only PID identities obtained from the staging supervisor started by the harness and checks that those worker PIDs are no longer alive. Temp config/workspace are then cleaned up.

## Validation

```powershell
bun run build
bun scripts/smoke-chat-core-staging.ts
bun --bun x vitest run tests/coreSupervisor.test.ts tests/coreSupervisorCheckpoint.test.ts tests/coreSessionRouting.test.ts tests/coreGenerationPolicy.test.ts tests/chatRuntimeLedger.test.ts tests/chatRuntimePersistence.test.ts tests/chatRuntimeCutover.test.ts tests/sessionAgentOwnership.test.ts tests/server.test.ts tests/serverAuth.test.ts tests/sessionEventScope.test.ts tests/sessionEventReplay.test.ts tests/agentAbortInterrupt.test.ts tests/messageQueueing.test.ts tests/chromeExtensionIsolation.test.ts tests/chromeExtensionHardening.test.ts tests/chromeExtensionRemote.test.ts
```

- Full regression: **124/124 passed in 17 suites**.
- Real staging: **PASS**, including restart, rollback, two-session worker affinity, SSE heartbeat and cleanup.
- Global runtime: deliberately unchanged. Port 7888 is not managed by Core Supervisor and its process also serves MCP 9864. Staging test does not prove production cutover is safe.

## Remaining validation & migration

- Staging operates real API and SSE sockets but does not load an actual unpacked Chrome Extension or exercise a real model/provider stream.
- Migrating the unsupervised public port 7888 remains **blocked** while the shared MCP process owns it; do not terminate it to force activation.
- Durable interrupted-turn reconciliation under supervised worker crash should be owner/generation-aware. Until verified, do not replay old tool calls automatically.
- Before production cutover, verify existing active jobs, MCP/tunnel continuity, authenticated endpoint path routing and rollback in a maintenance-safe deployment plan.
