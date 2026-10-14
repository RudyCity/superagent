# MCP Multi-Project Routing and Workspace Safety — Development Plan

Date: 2026-10-14  
Status: Proposed — based on codebase audit  
Scope: MCP workspace selection, multi-project routing, workspace boundary enforcement, and cross-session validation

## 1. Objective

Make SuperAgent's MCP interface reliably and safely operate on multiple registered projects without mixing workspace context, silently falling back to the wrong project, or exposing files outside an authorized workspace.

Build on the existing request-scoped workspace implementation. Do not replace the MCP transport or introduce one MCP endpoint per project unless later measurements show a concrete need.

## 2. Verified Current State

The following points were confirmed by inspecting the current codebase:

- `src/core/mcp/superagentMcpServer.ts` registers the MCP tool catalog and dispatches tool calls.
- `src/core/mcp/tools/workspaceContext.ts` uses `AsyncLocalStorage` to provide an asynchronous workspace context; `switch_workspace` updates the workspace held by an MCP server instance rather than calling `process.chdir()`.
- `src/core/mcp/mcpHttpTransport.ts` creates a separate MCP server/transport pair for each initialized HTTP session and binds that session to its authenticated identity.
- Workspace-aware operations already accept a workspace or cwd in a number of handlers. MCP-to-HTTP agent calls can also pass `x-workspace-path`.
- Muse has a separate watched-workspaces configuration (`defaultWorkspace` and `workspaces[]`) and batch workspace resolution in `src/core/remoteAgent/config.ts` and `src/core/remoteAgent/batchExecutor.ts`. This is not yet a common MCP project registry.
- The MCP tool catalog deliberately disables selected agent orchestration tools, including `superagent_run_task` and `superagent_invoke`. This plan does not assume those tools are remotely callable.
- There is no confirmed MCP project registry or `list_projects` tool in the inspected implementation.
- The exposed HTTP MCP endpoint is `/mcp`; per-project URL namespaces are not required for the initial design.

### Baseline verification

Focused tests were run on 2026-10-14:

| Test file | Result |
|---|---:|
| `tests/mcpWorkspaceRouting.test.ts` | 12 passed |
| `tests/mcpServer.test.ts` | 12 passed |
| `tests/mcpHttpTransport.test.ts` | 14 passed |
| `tests/museMultiProjectWatch.test.ts` | 15 passed, 1 failed |
| Total | 53 passed, 1 failed |

The failing Muse test is `should execute tool calls in appropriate project directory during batch execution` at line 247. Its test uses the `read` tool with `filePath`, while the current `readTool` contract in `src/core/tools/fileReadTools.ts` requires a `filePaths` array. Reproduce and determine whether to correct the test fixture, restore a supported alias, or fix a genuine routing regression before changing behavior.

These results cover only the listed focused tests; they are not a full-suite or production-runtime certification.

## 3. Design Decisions

### 3.1 One MCP gateway, explicit project context

Keep the existing MCP endpoint and session lifecycle. Route workspace-scoped calls using a normalized, validated project context. Do not create a new tunnel or MCP server for every project by default.

Every workspace-scoped tool should resolve its target in one canonical helper rather than implementing a different fallback policy.

### 3.2 Project registry as the source of truth

Introduce a user-level registry at `~/.superagent-r/projects.json` (resolved through the existing configuration-path helpers, not by scattering hard-coded home paths). Initial schema:

- `schemaVersion`
- Project records with stable `id`, `name`, `type` (local, SSH, or chain), normalized root/target, enabled status, and registration timestamp.
- No provider credentials, tunnel tokens, or other secrets.
- Explicit registration/removal. Do not recursively scan a drive or automatically trust arbitrary paths.

The registry is separate from Git feature-worktree metadata and from Muse's watched-workspaces list. Reuse existing path and SSH/chain abstractions where appropriate, but avoid silently merging these different concepts.

### 3.3 Deterministic project resolution

Apply this priority consistently:

1. Explicit `projectId`, if enabled and registered.
2. Explicit `workspace`/workspace target, if it maps to a registered and authorized project.
3. An absolute file or directory path that resolves inside exactly one registered local project root.
4. The active project bound to the current MCP session, but only when the tool contract permits a session default.

Reject unknown or ambiguous targets with an actionable error. Never silently route a failed explicit target to the CLI's active session, `process.cwd()`, or another project.

For SSH/chain targets, preserve their existing canonical identifiers and use the corresponding remote workspace implementation; do not run local filesystem checks against an SSH URI.

### 3.4 Session and request isolation

- Keep active-project selection per MCP server/session instance.
- Resolve each call inside request-scoped context using `AsyncLocalStorage`.
- Explicit arguments take precedence over the session default for that call.
- Do not use `process.chdir()` or mutable process-global workspace/mode state to switch projects.
- Cross-project batch operations must identify a project for each operation and validate each target separately.
- Parallel agents must be bound to an explicit project and, when editing the same repository concurrently, an isolated Git worktree.

### 3.5 Uniform authorization boundary

All filesystem tools—including read, list, search, glob, write, patch, and file batches—must enforce the same workspace policy. The fact that a tool is read-only must not imply permission to read arbitrary files.

Normalize and validate the final target path, account for symlinks/reparse points, enforce allowed roots, and keep protected configuration files protected. Preserve the existing dangerous-tool opt-in, OAuth scopes, audit logging, and default-deny behavior for remote mutation.

## 4. Implementation Phases

### Phase 0 — Preserve the working tree and establish a clean baseline

1. Inspect `git status` and diffs for all files that will be touched. The repository already has unrelated, uncommitted modifications; preserve them.
2. Reproduce the Muse multi-project failure and classify it as a stale test contract or a product regression.
3. Run the focused tests and `bun run build`; record actual results and environment constraints.
4. Add no automatic workspace initialization or fallback behavior in this phase.

Exit criteria:
- The existing failure is explained and covered by a regression test.
- No unrelated working-tree changes are overwritten.
- Baseline results are recorded truthfully.

### Phase 1 — Canonical workspace resolution and filesystem safety

Primary files:
- `src/core/mcp/tools/workspaceContext.ts`
- `src/core/mcp/tools/workspaceTools.ts`
- `src/core/mcp/superagentMcpServer.ts`
- `src/core/permissions.ts`
- Relevant MCP tool schemas and tests

Tasks:
1. Add one canonical helper that resolves `projectId`, `workspace`, path arguments, and session defaults with explicit error results.
2. Pass the resolved context into every workspace-scoped handler, including list, grep, find, read/write batches, command execution, worktree operations, plan/task tools, and Chrome handlers where applicable.
3. Fix inconsistent relative-path behavior; for example, `superagent_list_files` currently calls `path.resolve(dirPath)`, which can resolve relative paths from the process cwd rather than the active MCP workspace.
4. Add workspace-boundary checks for reads and directory listing as well as writes. Ensure file batches cannot bypass the check by using absolute paths or nested entries.
5. Reject traversal, ambiguous roots, and symlink escapes; retain explicit exceptions only where the policy requires them.
6. Update MCP input schemas and descriptions so supported tools consistently expose `projectId` and/or `workspace` instead of silently interpreting similar parameters differently.

Exit criteria:
- Every workspace-scoped handler uses the canonical context.
- An unregistered path cannot be accessed merely by passing an absolute path.
- Existing local, SSH, and chain flows still work under explicit target selection.

### Phase 2 — Project registry and explicit project tools

Primary files:
- New `src/core/project/projectRegistry.ts`
- `src/core/config/paths.ts` or the existing configuration-path helper
- `src/core/mcp/superagentMcpServer.ts`
- MCP workspace tool module(s)
- New registry and MCP contract tests

Tasks:
1. Implement validated registry load/save operations with schema versioning, atomic writes, duplicate detection, path normalization, and helpful malformed-config errors.
2. Add MCP tools to list registered projects and inspect one project. Use stable IDs; avoid relying on fuzzy folder-name matching for mutations.
3. Extend workspace switching to accept a registered `projectId` as well as a validated workspace target.
4. Clearly distinguish registered projects, active session workspace, feature worktrees, and Muse watched workspaces in returned status.
5. Make adding/removing registry entries an explicit, permission-gated action. Do not auto-trust new paths as a side effect of a failed tool call.

Exit criteria:
- A project can be registered, listed, inspected, selected, and removed through supported flows.
- Invalid, duplicate, missing, and disabled entries produce predictable errors.
- Registry operations never store secrets and do not alter unrelated project data.

### Phase 3 — Project router and task-intent matching

Primary files:
- New `src/core/project/projectRouter.ts`
- MCP dispatch/context modules
- Project router unit tests

Tasks:
1. Prefer explicit project IDs or paths supplied by the caller.
2. For natural-language routing, match task terms to registered project metadata (name, description, technology tags) only when the match is sufficiently unambiguous.
3. Return the selected project and the reason for the match before executing a mutating task when confidence is low or the target is ambiguous.
4. Do not perform repository edits, shell commands, or agent invocation on an inferred project without a validated project context and required permission.
5. Do not use an LLM-only decision as an authorization boundary; registry validation and path checks remain deterministic.

Exit criteria:
- Exact identifiers resolve deterministically.
- Ambiguous or unknown intents fail closed and explain how to choose a project.
- Router tests cover overlapping names, renamed/missing directories, disabled projects, and explicit overrides.

### Phase 4 — Multi-project concurrency and agent orchestration

This phase is gated on Phases 1–3.

Primary files:
- `src/core/mcp/mcpHttpTransport.ts`
- `src/core/mcp/mcpSessionRegistry.ts`
- `src/core/mcp/tools/executionTools.ts`
- Server session/workspace resolution and relevant lifecycle tests

Tasks:
1. Add integration coverage for two authenticated MCP sessions targeting Project A and Project B concurrently.
2. Verify switch-workspace changes only the invoking MCP session's default; explicit per-call targets must not change another session's default.
3. Test that an abort, permission response, plan approval, event subscription, or command in one project cannot affect a second project's session.
4. Keep currently disabled remote orchestration tools disabled until their plan approval, identity, session selection, workspace routing, abort scope, and opt-in behavior have dedicated tests and explicit design review.
5. If remote invocation is later enabled, bind every agent instance and worktree to a registered project ID and record the selected project in its audit events.

Exit criteria:
- Two or more MCP sessions can use different projects concurrently without context leaks.
- Negative tests prove cross-session reads, writes, invocation, and abort cannot cross project boundaries.
- Agent orchestration is not enabled merely because basic workspace routing succeeds.

### Phase 5 — Documentation, wiki, release readiness

Tasks:
1. Update README usage for registering, listing, selecting, and targeting projects.
2. Update the relevant architecture/API/workflow pages under `docs/wiki/` and MCP examples under `docs/mcp/`.
3. Run the wiki sync and wiki-link validation scripts; inspect their result rather than assuming success.
4. Update `CHANGELOG.md` and the package version only when implementation is complete and verified, according to repository rules.
5. Document migration behavior for existing installations with no registry: current workspace may be used as the initial session default, but must not automatically register arbitrary sibling or parent folders.

Exit criteria:
- Documentation matches the implemented tool catalog and actual security model.
- Build, focused tests, relevant integration tests, wiki validation, and full test suite results are recorded.
- No claim of production-ready parallel multi-project support is made before runtime verification.

## 5. Required Test Matrix

| Scenario | Expected result |
|---|---|
| Explicit registered `projectId` | Routes only to that project |
| Explicit workspace path outside the registry | Rejected; no fallback |
| Unknown or ambiguous project name | Rejected with a useful explanation |
| Relative path after switching workspace | Resolves from the intended project root |
| Absolute read path outside authorized roots | Rejected |
| Symlink or traversal escapes a registered root | Rejected |
| Batch contains entries in different projects without explicit targets | Rejected as ambiguous |
| Batch explicitly identifies a project per operation | Each entry independently validated |
| Two MCP sessions run concurrently on different projects | No workspace-context leakage |
| Switch workspace in session A | Session B remains unchanged |
| Abort or approval in Project A | Project B remains unaffected |
| SSH/chain target | Routed via remote implementation, not local filesystem |
| Registry malformed, duplicated, disabled, or missing project | Stable and non-destructive error |
| Dangerous tunnel tool without opt-in/write scope | Remains blocked |
| Current Muse batch-read test | Passes after test/product contract is corrected |

## 6. Acceptance Criteria

- A single canonical workspace resolver is used by workspace-scoped MCP tools.
- Project IDs are stable and resolved through a validated registry.
- Workspace boundary checks apply equally to reads, writes, lists, searches, batches, and commands.
- Explicit project selection cannot silently fall back to a different project.
- Active workspace, workspace mode, session identity, approvals, and aborts remain request/session-scoped.
- At least two authenticated MCP sessions are tested concurrently against different local projects.
- Current focused tests, new security tests, relevant integration tests, and build results are documented.
- Disabled agent-control tools remain disabled until separately reviewed and tested.
- README, wiki, CHANGELOG, and version metadata match the verified implementation.

## 7. Risks and Guardrails

- Path authorization is a security boundary. A registry match alone is insufficient; validate the resolved filesystem target and symlink behavior.
- Scoped YOLO and tunnel dangerous-tool opt-in must remain separate, layered controls.
- Do not solve concurrency with a mutex around process-global workspace state; use explicit request/session context.
- Do not conflate a feature worktree with a registered top-level project or a Muse watched workspace.
- Do not automatically call session initialization endpoints until their side effects and security contract are verified.
- Preserve current uncommitted changes. Review diffs before editing any file already marked modified.
- Keep modules focused and under the repository's 1,000-line limit.
- Final release must include test/build evidence; the baseline result of 53 passed and 1 failed must not be represented as a clean suite.

## 8. Recommended Execution Order

1. Phase 0: reproduce and classify the current test failure; establish baseline.
2. Phase 1: unify workspace resolution and fix filesystem boundary gaps.
3. Phase 2: add the registry and explicit project-selection tools.
4. Phase 3: add safe, deterministic project routing.
5. Phase 4: verify true concurrent MCP sessions and only then review agent orchestration.
6. Phase 5: synchronize documentation and prepare release.

The plan is a proposal only. No application code is changed by this document.
