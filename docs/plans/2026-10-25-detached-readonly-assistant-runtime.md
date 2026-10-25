# Explicit detached analysis tasks — 2026-10-25

## Scope

Only the T-Line Core task routes and dedicated background analysis runner are changed. Muse/Telegram and CLI interactive execution remain untouched.

### Task flow

1. T-Line operator creates a **queued draft** scoped to a live session and workspace.
2. Separate, explicit `POST /api/assistant/tasks/:id/run` with `expectedRevision` starts an independent Agent using the configured **single-agent** model, not the owning chat Agent.
3. A bounded in-process dispatcher (2 per session/task journal) atomically claims `queued → planning → running`. The owner can keep chatting while this distinct Agent runs. A repeated run or stale revision cannot run the work twice.
4. The worker uses an allowlisted **read-only** set of local inspection tools and memory/search reads. It cannot run arbitrary shell commands, edit files, spawn subagents, or auto-approve permissions. Both the model-facing toolset and executor headless gate enforce this. Ambient YOLO permission bypass is disabled.
5. On verified `task_completed`, worker persists a bounded summary under the scoped result directory before transitioning to `completed`. GET `/:id/result` returns it only for the authenticated owner/session/workspace; GET list/events never return raw results.
6. `POST /:id/cancel` accepts queued cancellation or signals an owned live worker. Any running task with no live owner is marked **unverified** in snapshots and requires manual reconciliation; automatic replay is forbidden.

### Durability and limits

- Durable: task identity, journal states, revision-protected transitions, bounded event cursor, result file when completed.
- Core-process owned: worker instance itself. Exiting/restarting the Core may interrupt execution. A supervisor- or daemon-owned process-independent task host and recovery handoff have **not** been established.
- Live owner IDs are held in Core memory; after an unexpected restart, already-started tasks are not adopted or restarted. Result evidence is never synthesized.
- Executable background tasks are **read-only** and local-workspace only; mutating code tasks need worktree isolation, permission handoff, cross-process write locks and rollback.
- No unrelated remote messaging endpoints were modified.

### Verification

`bun run build` and focused tests in `tests/assistantDetachedTaskHttp.test.ts`, `tests/assistantTaskHttpRoutes.test.ts`, `tests/assistantTaskDispatcher.test.ts`.
Live model-provider execution and packaged desktop end-to-end still require staging verification.
