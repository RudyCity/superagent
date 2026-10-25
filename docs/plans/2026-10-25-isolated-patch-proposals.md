# Session-scoped isolated patch proposals and explicit reconciliation
Date: 2026-10-25

## What is implemented

For authenticated, active **T-Line** workspace sessions only, the existing assistant task journal now supports an explicit patch-proposal workflow:

1. Create a queued draft task. An operator must separately click **Prepare patch**.
2. Core starts a bounded detached agent with **read-only tool access**. It requests a single Git unified diff for existing tracked source/test files; agent tools cannot write files or invoke shell commands.
3. Core validates the generated diff (bounded 32 KiB/1500 lines, max 8 files, fixed source/test directory allowlist, no binary, renames, new/deleted/symlink files, path traversal, sensitive .env or Git configuration paths).
4. A separate **detached Git worktree** is created from repository `HEAD`, under the Core configuration directory. The original checkout, including its uncommitted work, is **not modified**.
5. Git `apply --check --whitespace=error` and `apply` run with direct child process arguments, without shell evaluation. Tracked target files and symlink traversal are verified. The verified diff and task summary are stored in owner/workspace-scoped artifacts.
6. Only a completed task bearing `patch_review_ready` evidence can retrieve the patch via GET `/api/assistant/tasks/:id/patch`. No endpoint exists to automatically merge it into the primary checkout.
7. `POST /api/assistant/tasks/:id/reconcile` with exact expected task revision lets the operator mark **orphaned** planning/running tasks interrupted, and subsequently mark interrupted tasks `reconcile_required`. It refuses tasks whose worker is currently live, never assumes successful side effects and never replays task execution.

Other fixed routes remain: GET list/events/result; POST create/run/cancel. The list reports `supportedModes: ['analysis','patch-preview']` only on compatible Core builds.

## Safeguards and known limitations

- This is a **patch proposal**, not a general writable agent worker. The actual AI engine cannot edit even the worktree directly; only the Core patch validator can apply the proposed diff inside the detached worktree.
- Headless worker is owned by the Core OS process; it does **not survive** Core termination. Journal metadata survives; manual reconciliation replaces unsafe automatic replay. Worktree artifacts may survive interrupted work for manual cleanup. No cleanup command automatically removes them.
- Git source is repository `HEAD`, so local uncommitted changes in the original workspace are deliberately excluded. Patches against the working tree may not directly apply once the main branch moves.
- Only changes to already tracked source/test files are supported. No untracked new file, deletion, rename or binary updates yet. A patch which fails validation causes the task to fail, without merging anything.
- Tests use a local Git fixture and an injected patch text generator; model provider availability and desktop packaged end-to-end have **not** been verified by these tests.
- OS-level write sandboxing, permissions handoff for mutating tools, process-independent durable workers, audited worktree cleanup, safe rebase/merge and conflict resolution remain follow-up work.

Muse/Telegram/channel owners are untouched. The original SuperAgent CLI is unchanged.

## Tests

`bun run build`
`bun --bun x vitest run tests/assistantTaskPatchHttp.test.ts tests/assistantTaskPatch.test.ts tests/assistantDetachedTaskHttp.test.ts tests/assistantTaskHttpRoutes.test.ts tests/assistantTaskDispatcher.test.ts`
