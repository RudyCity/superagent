# T-Line Running Agent Checkpoint Phase 2A — Evidence Before Recovery

Date: 2026-10-26. Scope: detached SuperAgent Core tasks visible in T-Line. Muse and the generic CLI agent restart pipeline remain unchanged.

## Implemented

- `assistantExecutionSteps.ts` implements a **durable, owner/workspace/task-scoped observation journal** for tool start and end events. Event IDs are salted with owner+workspace+task and hashed; raw tool call IDs, arguments, prompts, outputs, credentials and execution capabilities are never serialized.
- Real detached model execution attaches the observer to its `Agent` callback. Observations are serialized in event order and flushed before a successful model result is considered complete. If the step journal cannot be written, the worker is aborted and success is not claimed.
- Each step records `tool`, `phase`, `effect`, optional `outcome`, hashed `callRef`, timestamp and monotonic sequence. Local allowlisted read tools can have an *observed completion*; web calls are always `external_unverified` even after a tool-end event. Unexpected tools are classified `other/unknown`.
- The journal enforces a 256-event cap, bounded file size, exclusive locking, atomic replace and file sync. Corrupted files are not reset or silently accepted. A started-but-unfinished event after a simulated crash counts as incomplete and requires manual review.
- Authenticated scoped `GET /api/assistant/tasks/:taskId/checkpoint` now includes `execution` with observations, `incomplete`, `externalUnverified`, and `manualReviewRequired`. The response continues to advertise `executionResumptionSupported: false`.
- GET list advertises `execution-step-observation` in `supportedModes` for capability negotiation.
- **Risk-based retry gate**: a reviewed terminal attempt with manual-review-required steps must include both `acknowledgeUnverifiedEffects: true` and `expectedEvidenceSeq` matching the latest journal observation. Stale or missing acknowledgments are rejected. A successful request creates a **new queued draft only** and still requires a separate explicit Run.

## Safety boundary (critical)

This is a **step observation journal, not a transactional pre-execution checkpoint**. Agent events are delivered through a callback, and the disk writer is asynchronous; a process can terminate after a tool action but before its observation is durable. Therefore even an empty journal cannot prove an external action never occurred. `completed` for local read means the tool emitted an end event, not that it is safe to replay a different operation.

There is **no automatic resume or replay** of a running model turn, mutation, browser action, payment, file write, shell command or external request. The current worker is a monolithic `Agent.sendMessage` call and has no audited deterministic tool-result snapshot/receipt gateway. A future Phase 2B must provide execution-level checkpoints *before* side effects, durable external receipts, and step-ID idempotency at the executor boundary.

## Verification

```sh
bun run build
bun --bun x vitest run tests/assistantExecutionSteps.test.ts \
  tests/assistantTaskHttpRoutes.test.ts tests/assistantTaskStore.test.ts \
  tests/assistantTaskDispatcher.test.ts
```

Tests cover redaction, correlation, cross-scope protection, incomplete steps after crash simulation, corrupted-file fail-closed behavior, external-unverified classification, and rejection of stale approval evidence. Full native GUI/provider E2E remains outstanding.
