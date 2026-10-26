# Safe assistant draft checkpoints — phase 1

Date: 2026-10-26. Scope: T-Line authenticated detached tasks only. Muse untouched.

## Actual supported controls
- `POST /api/assistant/tasks/:taskId/pause` transitions **queued → paused** only if the Core runtime has **not submitted the task**. Uses exact session+workspace ownership and `expectedRevision` CAS. Stores the checkpoint in the existing per-owner journal, which survives desktop/Core restart.
- `POST /api/assistant/tasks/:taskId/resume` transitions **paused → queued** only. It neither starts an agent nor replays any tool. Run requires a separate explicit POST after user approval.
- `GET /api/assistant/tasks/:taskId/checkpoint` reports `checkpoint: draft-boundary` for queued/paused or `manual-review-only` for other states; always returns `executionResumptionSupported: false`. This never exposes token-bearing worker state.
- `POST /api/assistant/tasks/:taskId/retry` requires a failed/cancelled/reconcile_required **terminal** source, an exact revision, no live local worker, and a caller-supplied idempotency key. Atomically creates a **new queued draft** with the same domain, goal and title, `retryOfTaskId` linking to the source, but cleared evidence and fresh task ID. It does **not** execute the new draft. Interrupted work must first be explicitly reconciled.
- Paused drafts may be cancelled; they cannot be directly dispatched. All state changes emit ordinary durable task journal transitions.

## Concurrency and safety
- Journal mutation holds a cross-process exclusive file lock and validates compare-and-swap revision and owner scope before changing state.
- If Run races Pause, an already-submitted task is rejected by the runtime live ID guard, or the dispatcher's CAS claim loses after a successful pause; there is no permission to execute a paused task.
- A restart loads draft status from the journal; it does not restart execution.
- All routes retain Core HTTP authentication, explicit T-Line client mode, trusted workspace and session ownership. T-Line fixed localhost proxy strips arbitrary extra action/tool fields.
- UI only shows controls if Core declares `draft-checkpoint` in `supportedModes`. Older Core stays compatible.

## Not supported
- Suspending a **running** model inference or resuming tool execution from a process/memory checkpoint.
- Replaying shell commands, web calls, external payments, writes or worktree mutations.
- Automatic retry of a failed job, or guessing whether external side effects succeeded after a crash.
- Generic agent pause/resume/retry outside detached task draft lifecycle.

## Checks
```sh
bun run build
bun --bun x vitest run tests/assistantTaskStore.test.ts tests/assistantTaskHttpRoutes.test.ts tests/assistantTaskDispatcher.test.ts tests/assistantTaskPatchHttp.test.ts
```
For full running-agent checkpoints, a separate future design needs tool-side idempotency, side-effect receipts, an exact step journal and explicit operator reconfirmation before restarting operations.
