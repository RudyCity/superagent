# Hermes Phase 5 — Scoped Muse Watcher Task Status

Date: 2026-10-20
Status: Local increment implemented; full Phase 5 acceptance remains open.
Parent: docs/plans/2026-10-20-superagent-hermes-phase-5-muse-tline-live-task-status.md

## Findings

MuseWatcher previously exposed its unscoped activeTaskId through the general status metadata. A multi-project watcher could publish the task ID for one project from another project's local terminal, and the global remote service status formatted it without caller workspace context. Muse Watcher task identities are distinct from the single-task Muse runner and must not be conflated with its session.

## Implementation

- MuseWatcher tracks the workspace and start timestamp alongside the active task ID. The workspace is resolved from the actual selected execution target for task batches.
- The local getScopedActiveTask(workspace) observation returns only task ID, workspace and time when the watcher is running, the task is known, and the exact canonical workspace is in the watched allowlist. It never returns a prompt, transcript, token, transport connection or permission grant.
- T-Line /muse watch status projects a normalized, conservative running/unverified task state only for the local caller workspace. Other local workspaces receive a generic no-active-task state.
- Global get_remote_service_status reports only whether a watcher task exists; it no longer includes the current task ID because there is no trusted workspace identity at this global inspection boundary.
- Task completion for the matching ID, operator abort, task_cancel, session reset and watcher shutdown clear the in-memory observation. A task_request that fails to send does not create a misleading active task record; a mismatched task_done does not clear a different task's identity.
- Normalized watcher records deliberately keep sessionId null. Not every remote envelope supplies a trusted local session ID, and a transport session does not confer authorization.

## Local acceptance

- Unit coverage for conservative watcher task projection.
- Integration coverage for local workspace visibility, other workspace denial, global MCP/tunnel non-disclosure, matching/mismatched completion, cancellation, reset and declined outgoing task requests.
- Existing remote agent session, remote status and CLI/T-Line tests remain part of targeted and full regression.

## Open gates

No new write authorization is granted. The existing watcher task routing policy and tool permission checks require a separate security audit. Authenticated MCP/OAuth authorization, cross-host task identity, durable correlation of results and staging/live provider verification remain open. Do not interpret local task activity as successful delivery or verified artifact completion.

## Local verification — 2026-10-20

- TypeScript build: passed.
- Extension JavaScript verification: passed (8 files).
- Wiki validation: passed (9 documents, 24 links).
- Focused Muse watcher/session, remote status, Muse remote agent, chat and readiness suites: 98/98 passed in 6 suites. This focused run includes the watcher workspace visibility and global remote status non-disclosure tests.
- Full Vitest (maxWorkers=3) run against a concurrently changing main working tree: **exit 1; 379 suites passed, 1 failed, 1 skipped; 3,603 tests passed, 6 failed, 5 skipped**.
- All six full-suite test failures were in tests/chromeCdpTools.test.ts, concerning CDP terminal write/key handling and registration; Chrome CDP source and tests were concurrently modified by a separate workstream. No Hermes watcher suite failed.
- This is a scoped Hermes increment acceptance only. Full repository regression and cross-channel staging gates remain OPEN until a clean full-suite run passes. Do not claim global full-suite success.

Focused and full test counts overlap and must not be combined.
