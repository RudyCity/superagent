# Hermes Phase 4 — CLI Bridge Multi-Project Workspace Isolation

**Date:** 2026-10-20
**Status:** Bounded local implementation and focused regression accepted; overall Phase 4 remains in progress.
**Parent reference:** `docs/plans/2026-10-18-superagent-hermes-like-implementation-master-reference.md`
**Previous increment:** `docs/plans/2026-10-20-superagent-hermes-phase-4-delegation-outcome-implementation.md`

## Defect / security boundary

CLI Bridge background delegations previously used a global map, and `delegate.jobs`, `delegate.get`, `delegate.tail`, `delegate.cancel` accepted an arbitrary job ID with no per-workspace authorization. Likewise, session list, get, tail, send and kill operated on global session IDs. Explicit `cwd` and document artifact overrides could select neighboring project directories (or symlinks out of the selected project).

The MCP provider authorizes the selected workspace *before* the tool executes. This increment binds tool operations to that already-authorized workspace; selecting a different registered project is a separate, explicit operation. A job ID or session ID is not itself authorization.

## Implemented safeguards

- Canonicalized and validated the caller workspace using `realpathSync` and directory checks. Explicit delegation/session `cwd` may select an existing child of that workspace only; sibling projects, parent traversal, and symlinks leaving the boundary fail closed.
- Added `workspaceRoot` to persisted background job records at creation. The `delegate.jobs` list is filtered by owner, while get/tail/cancel deny non-owner workspace callers with a generic not-found error (no job ID or output leak). For historical jobs without a recorded owner, visibility is restricted to the original recorded job cwd, never opened globally.
- Active, detached, and persisted CLI sessions are gated on their existing cwd. Session list hides other workspace records. A valid foreign session ID cannot read status/events, alter idle TTL, answer prompts, resume, detach, kill or send messages.
- Session creation and resume cannot select a cwd outside the caller's workspace. A fresh session can be created after explicitly selecting the intended workspace.
- CLI Bridge plan/task/walkthrough artifacts are checked against the authorized workspace before their paths are included in delegated prompts. Explicit outside overrides fail; ambient `SUPERAGENT_SESSION_PATH` fallbacks outside the workspace are discarded. Symlinked files and ancestors resolve to their real targets for checking.
- No implicit `Full YOLO` escalation or cross-project permission grant is introduced. This is an additive fail-closed boundary. Other CLI provider configuration (profiles, optional named skills) is not redefined in this increment.

## Tests

`tests/cliBridgeDelegateJobs.test.ts` adds two-project background isolation and child/foreign cwd tests while preserving concurrency and cleanup checks.

`tests/cliBridgeWorkspaceIsolation.test.ts` uses actual local CLI session management (no real AI provider) to check project A session visibility and rejection of project B attempts to list/get/tail/send/kill, plus invalid cwd and document path/Windows symlink regression coverage.

Existing `tests/cliBridgeTool.test.ts`, `tests/projectProvider.test.ts` and `tests/mcpWorkspaceBoundary.test.ts` continue to exercise provider contracts.

Focused local gate: `bunx vitest run tests/cliBridgeDelegateJobs.test.ts tests/cliBridgeWorkspaceIsolation.test.ts tests/cliBridgeTool.test.ts tests/projectProvider.test.ts tests/mcpWorkspaceBoundary.test.ts --reporter=default` — **74/74 passed across five suites**. `bun run build` also passed.

## Outstanding risks and next phase

**Scope limit:** The controls described above authorize CLI Bridge API routing and prompt artifact paths. They are **not** an OS/container sandbox for a third-party CLI subprocess. External CLIs still run with the host user's own filesystem permissions, may open independent paths through their own flags or code, and must not be treated as fully isolated tenants. Running truly untrusted providers requires OS-level sandboxing and explicit capability restrictions.

This is **not** final cross-provider Phase 4 acceptance. Live SSH provider delegation, actual OAuth-authenticated MCP project grants, multi-worktree file lock/cancellation, heterogeneous CLI provider failures, structured artifact completion evidence, provider resource ceilings, and production staging checks remain open. RMemory live gateway/LLM replay gates also remain unverified. Real clients should be smoke-tested with explicitly selected project workspaces.

The broad full-suite gate, when available, must be recorded separately from focused tests. Tests running with fake CLI processes and local fixtures do not certify live provider behavior.


## Final local regression acceptance — 2026-10-20

- `bun run build` — passed.
- `bun run verify:extension-js` — passed (8 extension JavaScript files).
- `bun run wiki:validate` — passed (9 wiki files; 24 links).
- Focused CLI/MCP/project regression: **74 tests passed across 5 suites**.
- Post-fix WebSocket and workspace boundary replay: **47 tests passed in 2 suites**.
- Final full-suite `bunx vitest run --reporter=default --maxWorkers=3`: **exit 0**, **370 suites passed**, **1 skipped suite**, **3,540 tests passed**, **5 skipped tests**, **0 failures**.
- Earlier full-suite run reported three failures: a dangling-symlink assertion prior to its fail-closed patch and two Muse transport-dependent assertions. Symlink handling was hardened; tests now select the WebSocket transport/token fixtures explicitly. Final full suite is the authoritative local gate.
- `git diff --check` and `git diff --cached --check` — passed.

Focused and full counts overlap; do not add them. Local CLI child-process fixtures do not establish actual live SSH/provider authorization or OS sandboxing.
