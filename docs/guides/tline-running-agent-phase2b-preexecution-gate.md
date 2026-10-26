# Phase 2B-1 — Durable Pre-Execution Gate for Detached Agent Tools

2026-10-26 — Applies to T-Line detached agents only. Muse, CLI, generic Agent, ACP and standalone dynamic tool dispatch are not changed.

## Implemented
- `assistantToolPreflight.ts` registers a per-Agent WeakMap callback. There is no process-wide auto-approval.
- The actual `executeToolCall()` boundary invokes preflight **before** `pre_tool` hooks and `tool.execute()`, only if the Agent registered the gate. If the checkpoint cannot be written, the adapter is not called.
- During a detached `Agent.sendMessage`, the ordered start-event queue is flushed, then the prepared event is durably fsynced and atomically written. Phase order is `started → prepared → finished`. Denied operations may end `started → finished` but never count as proven pre-execution-protected.
- Only domain-allowlisted tools may record `prepared`. Unknown tools are denied preflight. A crash after `prepared` but before `finished` remains incomplete and requires human review, even for local reads.
- `GET /api/assistant/tasks/:id/checkpoint` now also reports `preparedCount`, `unpreparedCount` and `missingHistory`. Old v1 journals without prepared events are accepted but considered **unverified**, not retroactively trusted.
- Terminal work that reached execution but has no step history also requires manual review (with evidence sequence 0) before Retry-as-New-Draft; this still never re-executes a tool.
- The observation journal remains capped at 256 events, owner/workspace/task-bound, opaque call references only, and excludes prompts, arguments, outputs, tokens and secrets. Corrupt lifecycles are rejected.

## Explicit limits
A durable prepare record establishes that logging preceded this executor's invocation. It **does not** prove the external provider completed or did not complete an action. No transactional receipts from providers, deterministic model-state snapshots, idempotent external mutations or running-model restore are implemented here. Therefore `executionResumptionSupported: false` remains and the UI must not add a running-agent Resume button.

The callback event `tool_end` is not a provider receipt. All external operations stay `external_unverified` even on success. Phase 2B-2 would require side-effect-specific idempotency keys and signed/verified action receipts plus an explicit operator review boundary before any potentially repeated execution.

## Validation
```sh
bun run build
bun --bun x vitest run tests/assistantToolPreflight.test.ts \
  tests/assistantExecutionSteps.test.ts tests/assistantTaskHttpRoutes.test.ts \
  tests/assistantTaskStore.test.ts tests/assistantTaskDispatcher.test.ts
```
The gateway tests use a controlled in-memory tool adapter, verifying ordering and fail-closed behavior. There has not yet been a packaged Tauri/provider crash-injection end-to-end test.
