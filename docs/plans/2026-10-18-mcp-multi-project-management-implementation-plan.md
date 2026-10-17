# MCP Multi-Project Management Implementation Plan

> **For Claude:** Use `${SUPERPOWERS_SKILLS_ROOT}/skills/collaboration/executing-plans/SKILL.md` to implement this plan task-by-task.

**Goal:** Make SuperAgent MCP reliably discover, select, and operate on multiple registered local, SSH, and Workspace Chain projects without leaking workspace context across requests or sessions.

**Architecture:** Keep one MCP gateway. Add a validated user-level project registry and one canonical project/workspace resolver. Keep each initialized MCP session's default workspace isolated, resolve explicit project targets per call through request-scoped context, and expose existing Workspace Chain capabilities through a permission-aware MCP adapter. Never use `process.chdir()` for routing.

**Tech Stack:** TypeScript, Node.js `AsyncLocalStorage`, existing MCP SDK and configuration-path helpers, Vitest, existing YOLO/path permission controls, existing Workspace Chain and SSH abstractions.

---

## 1. Audit Findings and Baseline

Verified in the current repository (`D:\\backup from pc asus\\Documents Development\\superagent`, branch `main`, version `1.13.90`):

- `src/core/mcp/superagentMcpServer.ts` declares the MCP tool catalogue and dispatches calls. It maintains an `activeWorkspace` closure per created MCP server instance.
- `src/core/mcp/mcpHttpTransport.ts` creates separate server/transport instances for initialized HTTP sessions. Its stateless request path creates a fresh server, so a workspace switch cannot be assumed to persist between unrelated stateless calls.
- `src/core/mcp/tools/workspaceContext.ts` uses `AsyncLocalStorage` and resolves explicit workspace arguments, avoiding process-global `chdir`.
- `src/core/mcp/tools/workspaceTools.ts` implements switch/get workspace, file, search, and command operations. Every handler still needs review for consistent path resolution and authorization.
- `src/core/workspace/WorkspaceChainTypes.ts`, `WorkspaceChainManager.ts`, `WorkspaceChainConfig.ts`, and `workspaceChainTools.ts` already implement chains of local/SSH nodes and `cross_workspace_exec` for internal SuperAgent tools.
- The MCP catalogue does not currently expose `manage_workspace_chain` or `cross_workspace_exec`; no canonical MCP `list_projects` / project registry was found.
- Muse's `defaultWorkspace` and `workspaces[]` in `src/core/remoteAgent/config.ts` are a separate watched-workspaces configuration and must not silently become the project registry.
- During this audit, `superagent_switch_workspace` reported a successful switch, but subsequent calls made through the available MCP integration still reported the original `threads-alert` workspace. This is a **reproduction to investigate**, not yet a proven server-side root cause; the test suite must distinguish initialized-session behavior from the host's tool-call/session behavior.
- Baseline command passed: `bunx vitest run tests/mcpWorkspaceRouting.test.ts tests/mcpServer.test.ts tests/mcpHttpTransport.test.ts tests/workspaceChain.test.ts` — **4 files, 58 tests passed**. This is a focused baseline, not full-suite verification.
- An architecture/design plan already exists at `docs/plans/2026-10-14-mcp-multi-project-development-plan.md`. This document converts the next implementation steps into a test-first execution plan based on the latest audit.

## 2. Design Rules

1. **Single gateway, explicit project context.** Do not create an MCP endpoint/tunnel per project.
2. **Stable project IDs.** Use explicit `projectId` for unambiguous routing; paths and labels are metadata, not project identity.
3. **Session default is not authorization.** A selected workspace determines routing only after the target passes registry and permission checks.
4. **Explicit target wins for one call.** An explicit `projectId` / `workspace` / `cwd` target applies only to that operation and must not silently change the session default.
5. **Fail closed.** Unknown, disabled, ambiguous, missing, or unauthorized projects return actionable errors; never fall back to `process.cwd()` after an explicit target fails.
6. **No implicit trust.** Do not scan drives, register arbitrary paths automatically, or trust a directory just because a caller provided an absolute path.
7. **Keep concepts separate.** Registered projects, active MCP workspace, feature worktrees, workspace-chain nodes, and Muse watched workspaces have distinct purposes.
8. **Session isolation.** No process-global mutable workspace or SSH mode may leak one MCP request/session's selection into another.
9. **Respect existing disabled-tool policy.** Do not re-enable `superagent_run_task`, `superagent_invoke`, or other disabled orchestration tools as a side effect of this feature.
10. **Security before convenience.** Validate reads as well as writes, account for path traversal and symlink/reparse-point escapes, retain protected-file checks and dangerous-tool permissions, and never store secrets in the project registry.

## 3. Implementation Tasks

### Task 1: Reproduce and specify workspace-switch persistence

**Files:**
- Modify: `tests/mcpHttpTransport.test.ts`
- Modify: `tests/mcpServer.test.ts`
- Modify: `tests/mcpWorkspaceRouting.test.ts`
- Inspect/modify if tests expose a defect: `src/core/mcp/superagentMcpServer.ts`, `src/core/mcp/mcpHttpTransport.ts`

**Steps:**
1. Add an integration test that initializes MCP session A, calls `superagent_switch_workspace` to project B using session A's `mcp-session-id`, then calls `superagent_get_workspace` using the **same** session ID and expects B.
2. Initialize session B and prove that switching A does not change B's workspace default.
3. Add a test proving an explicit `workspace` / `cwd` operation target does not mutate the calling session's default unless the caller invokes the switch tool.
4. Add a stateless-call test documenting its actual contract. A stateless request must use an explicit target or a documented per-call default; do not imply that a prior stateless switch persists.
5. Run the focused tests before implementation and preserve the failing reproduction as a regression test.
6. Fix only the demonstrated root cause; keep server/transport lifecycle and authorization semantics intact.
7. Re-run tests and commit the task as `test: cover MCP workspace session persistence` followed, if needed, by a separate `fix: preserve MCP workspace per session` commit.

**Verification:**
```bash
bunx vitest run tests/mcpHttpTransport.test.ts tests/mcpServer.test.ts tests/mcpWorkspaceRouting.test.ts
```
Expected: all targeted tests pass; session A and B remain isolated.

### Task 2: Add the project registry contract and storage

**Files:**
- Create: `src/core/project/projectRegistry.ts`
- Create: `tests/mcpProjectRegistry.test.ts`
- Inspect/reuse: `src/core/config/paths.ts` and its existing `getRootConfigDir()` helper
- Reference: `src/core/remoteAgent/config.ts` only for conventions; do not merge the two registries.

**Steps:**
1. Write failing tests for registry creation, list/get, stable-ID uniqueness, duplicate roots, malformed config, disabled entries, missing directories, and local path normalization.
2. Define schema version 1 with `id`, `name`, optional description/tags, target type (`local`, `ssh`, or `chain`), normalized root/target, enabled flag, and registration/update timestamps.
3. Persist at a path derived from the existing root config directory helper (for example, `<root-config-dir>/projects.json`); do not hard-code a home-directory path in multiple files.
4. Use validated reads and atomic writes (temporary file + rename). Handle corrupt JSON with a clear error instead of silently treating it as an empty registry.
5. Store no bearer tokens, SSH passwords, private-key content, tunnel credentials, or session secrets. SSH/chain records must reference existing supported SSH/chain configuration rather than copy secrets.
6. Add explicit register/update/remove APIs with duplicate detection and predictable errors; do not recursively discover folders or auto-trust newly supplied paths.
7. Run registry unit tests and commit: `feat: add validated MCP project registry`.

**Verification:**
```bash
bunx vitest run tests/mcpProjectRegistry.test.ts
```

Expected: valid records round-trip; invalid or duplicate records are rejected; registry persistence never includes secrets.

### Task 3: Implement deterministic project routing

**Files:**
- Create: `src/core/project/projectRouter.ts`
- Modify: `src/core/mcp/tools/workspaceContext.ts`
- Create: `tests/mcpProjectRouter.test.ts`
- Reference: `src/core/permissions.ts`

**Steps:**
1. Write tests for the resolution priority: explicit registered `projectId`; explicit workspace target that maps to one registered/authorized project; absolute paths contained in exactly one registered root; then the current MCP session default only for tool contracts that allow a default.
2. Require explicit `projectId` and reject ambiguous path/name matches; never fuzzy-select a project for a mutating operation.
3. Normalize Windows path casing and separators as appropriate for the platform. Reject traversal, paths outside a registered root, and symlink/reparse-point escapes after resolving the final target.
4. Preserve explicit SSH and `chain:` targets through existing remote abstractions; do not send remote identifiers through local `fs.existsSync` or `realpath` checks.
5. Return a typed resolution result containing stable project ID, canonical workspace target, source of selection, and authorization result. Avoid encoding decisions in display strings.
6. Ensure an explicit but invalid project target returns an error and never falls back to the session default or process cwd.
7. Run project-router and existing workspace-routing tests; commit: `feat: add deterministic MCP project routing`.

**Verification:**
```bash
bunx vitest run tests/mcpProjectRouter.test.ts tests/mcpWorkspaceRouting.test.ts
```

Expected: exact IDs resolve deterministically; ambiguous, unknown, disabled, or unauthorized targets fail closed.

### Task 4: Route every MCP workspace-scoped tool through the canonical resolver

**Files:**
- Modify: `src/core/mcp/superagentMcpServer.ts`
- Modify: `src/core/mcp/tools/workspaceTools.ts`
- Modify as needed: `src/core/permissions.ts`
- Modify: relevant tests under `tests/mcpWorkspaceRouting.test.ts` and `tests/mcpServer.test.ts`

**Steps:**
1. Add consistent `projectId` and/or `workspace` schema properties to applicable read/list/search/write/patch/command/worktree/plan/task tools. Document the precedence rules in each tool description.
2. Pass one resolved workspace context into each handler instead of independently interpreting `cwd`, `workspace`, `worktreePath`, and file paths.
3. Fix the known relative-path risk in `superagent_list_files`: relative paths must resolve against the selected project, not the process cwd.
4. Enforce allowed-root checks for read/list/find/grep and every file in multi-file read/write/patch calls. Verify nested paths and absolute paths cannot bypass the checks.
5. For output files that do not exist yet, validate the resolved parent and destination path before writing.
6. Keep command-level destructive-operation checks, protected-config checks, dangerous-tool gating, and OAuth scopes. Project selection must not grant permissions by itself.
7. Add tests for traversal, absolute outside-root paths, multi-file mixed-root batches, symlink escapes (where supported), and two projects under concurrent calls.
8. Run MCP and permission-focused tests; commit: `fix: enforce consistent MCP project boundaries`.

**Verification:**
```bash
bunx vitest run tests/mcpWorkspaceRouting.test.ts tests/mcpServer.test.ts tests/mcpHttpTransport.test.ts
```

Expected: all workspace-scoped tools obey the same selected project and root-boundary policy.

### Task 5: Expose the project registry through explicit MCP tools

**Files:**
- Modify: `src/core/mcp/superagentMcpServer.ts`
- Create or modify a focused module: `src/core/mcp/tools/projectTools.ts`
- Modify: `src/core/permissions.ts` and tool annotations/allowlists as required
- Create: `tests/mcpProjectTools.test.ts`
- Modify: `tests/mcpServer.test.ts`

**Steps:**
1. Add safe discovery tools `superagent_list_projects` and `superagent_get_project`.
2. Add permission-gated mutation tools `superagent_register_project`, `superagent_update_project`, and `superagent_remove_project`. Follow current dangerous-tool and authenticated-identity behavior; do not expose mutation tools under safe-only mode.
3. Add JSON schemas with required/optional fields, stable ID rules, path/target types, and maximum lengths.
4. Return only project metadata and authorization status; never include secrets or raw config credentials.
5. Ensure remove/update operations require stable IDs and cannot silently target another project by fuzzy name.
6. Test catalogue visibility in safe and dangerous modes, malformed arguments, authorization denial, successful registration/listing/inspection, and removal.
7. Commit: `feat: expose project registry through MCP`.

**Verification:**
```bash
bunx vitest run tests/mcpProjectTools.test.ts tests/mcpServer.test.ts
```

Expected: read-only discovery works under the safe policy; mutations require the configured permission mode and authenticated context.

### Task 6: Bridge Workspace Chain into MCP without leaking request state

**Files:**
- Create: `src/core/mcp/tools/workspaceChainMcpTools.ts`
- Modify: `src/core/mcp/superagentMcpServer.ts`
- Inspect/modify carefully: `src/core/workspace/workspaceChainTools.ts`, `src/core/workspace/WorkspaceChainManager.ts`, `src/core/workspace/WorkspaceChainConfig.ts`, `src/core/ssh/workspaceMode.ts`
- Create: `tests/mcpWorkspaceChainTools.test.ts`
- Reference: `tests/workspaceChain.test.ts`, `tests/workspaceChainPermissions.test.ts`, `tests/workspaceChainSsh.test.ts`

**Steps:**
1. Add a thin MCP adapter over existing chain domain functions. Do not duplicate chain CRUD or cross-node execution implementations.
2. Expose separately permission-annotated actions for listing/inspecting/activating/deactivating chains, viewing topology, and cross-workspace operations.
3. Require explicit `chainId` / `nodeId` for remote or mutating operations where inference would be ambiguous.
4. Audit `WorkspaceChainManager`: although it uses `AsyncLocalStorage`, it can call global `workspaceMode.setSshMode()` / `setLocalMode()`. Remove or isolate global mode side effects for concurrent MCP requests before enabling concurrent cross-project operations.
5. Namespace SSH connections by chain and node, keep cleanup on session teardown, and do not let a session's active node selection change another request's mode.
6. Enforce node/path allowlists and existing permission prompts for writes, execution, sync, and destructive actions. Do not expose SSH secret values in results or logs.
7. Test parallel calls against separate chains/nodes, denied writes, unavailable SSH nodes, invalid chain/node IDs, and cleanup after session closure.
8. Commit: `feat: expose isolated workspace chain operations over MCP`.

**Verification:**
```bash
bunx vitest run tests/mcpWorkspaceChainTools.test.ts tests/workspaceChain.test.ts tests/workspaceChainPermissions.test.ts tests/workspaceChainSsh.test.ts
```

Expected: chain operations are discoverable through MCP and concurrent requests cannot cross-contaminate active chain/node or SSH mode.

### Task 7: Add audit context and update operator documentation

**Files:**
- Modify: `src/core/mcp/superagentMcpServer.ts` and/or existing MCP audit utilities
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Add/update: `docs/plans/2026-10-14-mcp-multi-project-development-plan.md` with a link to this implementation plan, or mark the older document superseded once this plan is adopted
- Tests: relevant MCP audit/catalogue tests

**Steps:**
1. Include stable `projectId` and a normalized target identifier in audit metadata when available. Avoid logging credentials, full private file contents, or sensitive command arguments.
2. Make failures auditable with a specific reason category: unknown project, ambiguous target, boundary denial, registry invalid, or session missing.
3. Document the difference between registered projects, active session workspace, feature worktrees, Workspace Chains, and Muse watched workspaces.
4. Document initialized-session persistence and stateless-request behavior; provide client examples that pass `projectId` or explicit workspace targets.
5. Update README and CHANGELOG for the released feature; bump SemVer only when implementation is complete. A backward-compatible multi-project addition should normally be a MINOR bump, subject to the repo's release policy.
6. Validate documentation links and MCP schema/catalogue examples; commit: `docs: document MCP multi-project management`.

### Task 8: Full verification, compatibility, and release checkpoint

**Files:**
- Tests across `tests/mcp*`, `tests/workspaceChain*`, `tests/museMultiProjectWatch.test.ts`
- `package.json`, lockfile, `CHANGELOG.md`, `README.md` only if a release/version update is warranted

**Steps:**
1. Run all focused tests added/modified in Tasks 1–7 and record the exact outputs.
2. Run `bun run build`.
3. Run `bun run test` (full suite); investigate and fix regressions rather than suppressing tests.
4. Run `bun run verify:extension-js` and `bun run verify:all` when environment and runtime allow; if a command is redundant or cannot run, record the precise reason and still run the applicable checks directly.
5. Check `git diff --check`, review staged/unstaged changes, ensure no secrets or generated runtime data entered the diff, and confirm all changed source files stay within repo line-count limits.
6. Run tests proving the existing disabled MCP orchestration tools remain disabled and safe-only mode does not expose mutation tools.
7. Complete changelog/version/docs synchronization and make an atomic Conventional Commit for the completed feature; push only when explicitly requested.

## 4. Acceptance Criteria

- A registered project can be listed, inspected, selected, and removed by stable ID.
- The initialized MCP session retains its default workspace after `superagent_switch_workspace`; a separate MCP session remains unaffected.
- Explicit per-call project targeting does not unexpectedly mutate the session default.
- Unknown, disabled, ambiguous, unauthorized, or out-of-root targets fail closed without a fallback to another project.
- Read, list, search, multi-file read/write, patch, command, worktree, plan/task, and chain operations follow consistent project authorization.
- Existing local workspace and SSH/chain capabilities remain functional.
- MCP clients can discover and operate Workspace Chains through a documented permission-aware interface.
- Concurrent calls and concurrent sessions do not leak selected workspace, chain/node state, or SSH mode.
- Project registry contains no secrets and does not auto-trust arbitrary filesystem paths.
- Muse watched workspaces and Git feature worktrees remain distinct from the registry.
- Disabled orchestration tools stay disabled; dangerous operations remain opt-in and auditable.
- Focused tests and build pass; full-suite results are reported truthfully.

## 5. Risks and Guardrails

- **Session mismatch could be in the runtime host rather than the repository.** Use a real Streamable HTTP integration test with stable `mcp-session-id` before changing implementation.
- **Workspace Chain currently interacts with global SSH mode.** Do not expose its concurrent execution path over HTTP MCP until request isolation is proven by tests.
- **Registry can become an authorization bypass if treated as a trust list without path checks.** Registration, trust, and operation permissions must stay separate.
- **Existing clients may send paths without project IDs.** Keep compatible explicit paths only when validated against authorization policy; do not silently reinterpret bad targets.
- **Scope creep into remote agent orchestration is prohibited for this plan.** Leave disabled task/invoke tools disabled.
- **Completion must be evidence-based.** Each task must pass its own tests before the next integration layer is enabled; do not declare complete until the final verification matrix passes.

## 6. Implementation Report — 2026-10-18

### Completed implementation

- **Task 1 — MCP session workspace persistence:** implemented and covered by a Streamable HTTP regression test. Switching session A persists in A; session B is unchanged; per-call target overrides do not mutate the session default.
- **Task 2 — Project Registry:** implemented at the path derived from the existing root configuration helper, with schema versioning, canonical local paths, atomic writes, stable IDs, duplicate/malformed record rejection, metadata updates/removal, and secret-field / credential-bearing SSH-target rejection. Chain project records must point to an existing Workspace Chain.
- **Task 3 — Project Router:** implemented explicit project ID, workspace/cwd/worktree target, remote SSH/chain target, session default, disabled target, ambiguity, symlink, and out-of-root validation. Legacy local path-only callers remain candidates only when the MCP scoped permission boundary independently permits them; invalid explicit project IDs fail closed.
- **Task 4 — Workspace routing and filesystem boundaries:** applied selected workspace context and root validation to local read/list/search/write batches, locks, document reads, Git add/restore paths, and patch/replace operations. Worktree management is scoped to the selected workspace. SSH/chain URIs are rejected by local-only file tools.
- **Task 5 — Registry MCP tools:** added `superagent_list_projects`, `superagent_get_project`, `superagent_register_project`, `superagent_update_project`, and `superagent_remove_project`. Discovery is safe/read-only; registry mutations remain dangerous/permission-gated and removal does not delete project files.
- **Task 6 — Workspace Chain MCP:** added `superagent_list_workspace_chains`, `superagent_manage_workspace_chain`, and `superagent_cross_workspace_exec`. Mutating/remote execution requires locally enabled Full YOLO, a registered chain project for cross-workspace operations, and no inline SSH secrets. Workspace Chain SSH/local mode now uses request-scoped async context to avoid cross-request state bleed.
- **Task 7 — Audit/docs/versioning:** updated README, changelog, the historical plan link, version metadata to `1.14.0`, project-aware tool schemas, and MCP security classification exports. Split policy, worktree, workspace-status, and checklist handlers into focused modules to respect the repo's file-size guidance.

### Verification results

- `bun run build` — **passed** (TypeScript compile).
- `bun run build` — **passed** after updating the tests.
- `bun run verify:extension-js` — **passed**, all 8 extension JavaScript files verified.
- Focused MCP/project/Workspace Chain command — **15 files, 127 tests passed**; MCP compatibility rerun — **3 files, 42 tests passed**.
- Refreshed outdated/flaky tests:
  - `tests/wizardDialog.test.ts`: uses isolated PassThrough stdin/stdout/stderr, disables raw terminal mode, waits for Ink's first rendered frame, and cleans up each renderer.
  - `tests/fileLockOptimisticAndUI.test.ts`: creates a unique temporary directory/file for each test and releases its locks during cleanup, avoiding collisions with concurrent suites.
  - `tests/processInspectionTools.test.ts`: obtains a candidate free port from an OS-assigned ephemeral listener instead of selecting random numbers that may be reserved/used by Windows services.
- Full test suite, run in four bounded batches due the total suite duration: **329 test files (328 passed, 1 skipped), 3,211 tests passed, 5 skipped, 0 failed**. Batch summaries: 80 files / 811 passed; 80 / 685 passed; 80 / 820 passed; 88 passed files + 1 skipped file / 895 passed + 5 skipped.
- `git diff --check` — **passed**.

### Acceptance status

- Project registration/discovery/routing and permission-aware Workspace Chain MCP interfaces are implemented and covered by focused tests.
- Initialized-session isolation and local project-root boundaries are covered by integration/unit tests.
- The previously failing/stale terminal-render, shared-file-lock, and random-port tests now pass; all test files completed in the bounded full-suite run with no failures.
