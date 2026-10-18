# MCP Independent Multi-Project Operation Plan (Beyond Workspace Chain)

**Date:** 2026-10-18
**Status:** Implemented and verified in the working tree. Full suite passed in bounded shards; build, extension JavaScript checks, wiki validation, and whitespace checks passed. Live SSH host end-to-end verification remains environment-dependent.
**Scope:** Make one MCP connection operate on multiple independent projects. Workspace Chain remains an optional orchestration feature, not a prerequisite for using separate projects.
**Related plans:** `2026-10-18-mcp-multi-project-management-implementation-plan.md`, `2026-10-14-mcp-multi-project-development-plan.md`

## Implementation progress (2026-10-18)

The working tree contains the implementation for project-aware grants, independent local routing, and a standalone SSH provider. The full test suite completed in bounded shards: 332 files discovered; 331 passed and 1 skipped; 3,224 tests passed, 5 skipped, and 0 failed. TypeScript build, 8 extension JavaScript checks, 24 wiki links, and final whitespace checks passed. SSH routing and fail-closed behavior are tested without a real network connection; authentication and remote file operations still require validation against a configured host.

## 1. Goal and intended user experience

An MCP client should be able to work in multiple independent repositories/projects—without creating a Workspace Chain for them.

Example:
1. Register local projects `shop-api`, `shop-web`, and `wordpress-plugin` once.
2. Call `superagent_list_projects` to discover them.
3. Ask the agent to inspect or edit `shop-api` by stable `projectId`; the next call can target `shop-web` in the same MCP connection.
4. Run independent operations against different projects concurrently without one call changing another call's target.
5. Optionally register a standalone SSH project (for example, a deployment repository on a remote host) and run supported file/search/command operations against it without wrapping it in a chain.
6. Use Workspace Chain only when a task intentionally spans multiple nodes or requires cross-workspace operations.

The user should not need a different MCP server/tunnel per repository, should not need to keep switching a global workspace, and should never have to weaken security just to use more than one project.

## 2. Audit findings from the current codebase

The following are confirmed by inspecting source and tests. This plan records current code behavior, not assumptions about a live external MCP client.

### Already implemented

- `src/core/project/projectRegistry.ts` stores explicit project registrations with stable IDs and supports `local`, `ssh`, and `chain` entries.
- `src/core/project/projectRouter.ts` resolves an explicit `projectId`, validates local subpaths against the registered root, detects ambiguous local roots, and maps credential-free SSH/chain targets.
- `src/core/mcp/tools/projectTools.ts` provides list/get/register/update/remove project tools.
- `src/core/mcp/superagentMcpServer.ts` resolves explicit project/workspace targets before dispatch and holds the active workspace in the created MCP server instance.
- `src/core/mcp/tools/workspaceContext.ts` uses `AsyncLocalStorage` for per-call workspace context; routing must continue to avoid `process.chdir()`.
- A Workspace Chain MCP adapter exists in `src/core/mcp/tools/workspaceChainMcpTools.ts`.

### Gaps that prevent the intended independent-project experience

**G1 — Registered project does not automatically have access; current scope checks still use the active workspace.**
The registry correctly says registration is not authorization. However, the dispatcher in `src/core/mcp/superagentMcpServer.ts` and `handleSwitchWorkspace` in `src/core/mcp/tools/workspaceTools.ts` apply Scoped YOLO checks against the current/active workspace. An explicitly registered project rooted outside that current scope can therefore still be blocked, even when the caller intends to select it. Simply bypassing this check would be unsafe. Add an explicit project-access grant model and evaluate permissions against the resolved target project.

**G2 — A standalone `ssh` project is representable but ordinary MCP workspace tools do not operate on it.**
The registry and router accept `type: "ssh"`, but local MCP handlers in `workspaceTools.ts` reject `ssh:` and `chain:` for read/write/search/list/lock operations and instruct callers to use Workspace Chain tools. `networkContentMcpTools.ts` and `worktreeTools.ts` have similar local-only boundaries. This means SSH registration is not equivalent to direct SSH project support.

**G3 — Do not reuse the SSH singleton as if it were multi-project safe.**
`src/core/ssh/workspaceMode.ts` scopes SSH configuration with `AsyncLocalStorage`, but `src/core/ssh/sshProxy.ts` maintains a single SFTP/SSH client and cached connection configuration. Concurrent calls targeting different SSH projects could compete over the same underlying connection. Direct SSH support needs a connection provider/pool whose connection identity is explicit and isolated by project/session.

**G4 — Tool target support is not self-evident to every MCP client.**
The dispatcher can resolve `projectId`, but input schemas/descriptions across the workspace-scoped tool catalogue must be audited and made consistent. A client should not have to guess which operations accept `projectId`, whether relative paths are relative to the selected project, or whether the selection persists.

**G5 — Existing test coverage is mostly component-level.**
Registry/router/tool tests exist, but the completion bar for this feature must include end-to-end dispatch of two unrelated registered projects through the same MCP server, concurrent operations and the permission policy. Standalone SSH behavior needs dedicated tests; chain tests alone do not prove this requirement.

## 3. Architecture decisions

1. **One MCP gateway, many project targets.** Keep the current MCP server/tunnel model; do not create one MCP server per project.
2. **Registered project != Workspace Chain.** Local and standalone SSH projects are first-class targets. Chains remain a distinct type with a node topology and cross-node features.
3. **Stable ID is the primary selector.** For workspace-scoped tools, `projectId` is preferred. Do not use fuzzy project-name matching for operations that read or mutate files.
4. **Per-call target does not mutate session default.** Passing `projectId` routes only that call. Only `superagent_switch_workspace` changes the calling MCP server/session default. Never change another session's default.
5. **Target precedence is deterministic.** (a) explicit registered `projectId`; (b) explicit workspace/cwd/subtarget that resolves inside exactly one enabled and authorized project; (c) that MCP session's default workspace for tools that allow a default. An invalid explicit target must fail closed; it must not silently fall back to another project or `process.cwd()`.
6. **Registration and authorization remain separate.** Registering a path describes the project; it does not grant file, command, or mutation permission. Do not bypass Scoped YOLO just because a project is registered.
7. **Access is explicit and capability-scoped.** Add a project access policy tied to the authenticated MCP principal/session where supported, with separate capabilities such as `read`, `write`, `execute`, `git`, and `manage`. Keep Full YOLO, dangerous-tool opt-in, OAuth scopes, protected-file checks, and server-side authorization as independent safety layers. Exact persistence should follow the current identity/session model after inspection; do not put credentials in `projects.json`.
8. **Local path boundaries remain enforced.** Every file in batch operations must be resolved and checked against the selected project's canonical root. Reject traversal, symlink/reparse-point escapes, and cross-project mixed batches unless each item explicitly identifies and is independently authorized for its project.
9. **SSH credentials are references, not registry values.** A project record may hold a credential-free target (host/user/port/remote root) and an optional reference to a local SSH profile. Reuse supported SSH config/default-key resolution; never store passwords, key contents, bearer tokens, or credential-bearing query strings in the registry.
10. **No process-global routing state.** Do not use `process.chdir()`, a global active project, or a singleton connection whose mutable target changes during concurrent requests.

## 4. Implementation phases

### Phase 0 — Establish the independent-project contract (test first)

**Files to inspect/update**
- `tests/mcpProjectRegistry.test.ts`
- `tests/mcpProjectRouter.test.ts`
- `tests/mcpProjectTools.test.ts`
- `tests/mcpServer.test.ts`
- `tests/mcpHttpTransport.test.ts`
- `tests/mcpWorkspaceRouting.test.ts`
- `src/core/mcp/superagentMcpServer.ts`

**Tasks**
1. Add a regression test with two separate local repositories, neither of which is the process's active workspace.
2. From one initialized MCP server/session, perform one call against project A and a second against project B via `projectId`; assert the correct repository is used for each call.
3. Assert explicit per-call selection leaves the session default unchanged; assert the explicit switch tool changes only that session's default.
4. Add a concurrent test that runs independent operations against A and B with staggered async work and checks file contents, returned paths, and audit context.
5. Test both initialized HTTP sessions and the documented stateless transport behavior. Do not claim switch persistence for a stateless request.
6. Keep chain test expectations separate; a passing Workspace Chain test is not acceptance evidence for independent projects.

**Exit criteria**
- Tests reproduce the currently blocked/uncovered independent-project scenarios before implementation.
- Tool target/default semantics are documented in test names and tool descriptions.

### Phase 1 — Add project-aware authorization without weakening Scoped YOLO

**Primary files**
- New `src/core/project/projectAccessPolicy.ts` (or a module chosen after inspection of existing MCP identity/auth storage)
- `src/core/mcp/superagentMcpServer.ts`
- `src/core/mcp/tools/workspaceTools.ts`
- `src/core/mcp/mcpToolPolicy.ts`
- `src/core/mcp/mcpWorkspacePolicy.ts`
- `src/core/permissions.ts` (only if needed to support explicit authorized-root lists)
- New `tests/mcpProjectAccessPolicy.test.ts`

**Tasks**
1. Define how a registered project is explicitly granted to an MCP principal/session. Preserve the rule that registration alone does not grant access.
2. Add a safe inspection path for effective project grants and a dangerous/approval-gated grant/revoke path if compatible with existing auth and tool policy. If the current identity model cannot safely persist per-principal grants, use a local administrator-managed allowlist first; document the limitation rather than using a process-global grant.
3. Resolve the project target first, then authorize the requested capability against that project. Do not derive authorization from whichever project happened to be active.
4. Integrate access checks with existing Scoped YOLO logic: a target project is usable only when the applicable user/session grant and the relevant safety mode both permit the action. Project grants must not override protected-file restrictions, disabled tools, OAuth scopes or dangerous-operation gates.
5. Return actionable errors that distinguish unknown project, disabled project, no grant, capability denied, YOLO boundary denial, and invalid path.
6. Audit `handleSwitchWorkspace`: selecting a different project must follow the same access policy as a normal operation; do not add the project to trusted directories as an unreviewed side effect.
7. Verify project disable/revoke takes effect on the next tool call, including already initialized MCP sessions.

**Exit criteria**
- A registered-but-ungranted project is denied.
- An explicitly granted project outside the active project's root can be used only within its project root and granted capabilities.
- A read-only grant cannot write, patch, execute commands, or mutate git state.
- No change weakens current Scoped YOLO, Full YOLO opt-in, protected-config, or disabled-tool controls.

### Phase 2 — Complete first-class local multi-project operation

**Primary files**
- `src/core/project/projectRouter.ts`
- `src/core/mcp/superagentMcpServer.ts`
- `src/core/mcp/tools/workspaceTools.ts`
- `src/core/mcp/tools/planSkillsMcpTools.ts`
- `src/core/mcp/tools/networkContentMcpTools.ts`
- `src/core/mcp/tools/worktreeTools.ts`
- Relevant MCP tool definitions/descriptions
- New `tests/mcpIndependentProjects.test.ts`

**Tasks**
1. Enumerate the full workspace-scoped MCP catalogue and mark each tool as local-only, local-and-SSH, chain-only, or global/session-scoped.
2. Ensure every workspace-scoped tool that can reasonably target a local project accepts and documents `projectId`. If direct schema changes are avoided for compatibility, still expose a consistent schema contract; do not leave accepted-but-undocumented parameters.
3. Apply one canonical resolved context to all applicable tools: command execution, batched read/write, list/find/grep, replace/multi-replace, apply patch, git operations, plans/tasks, document reads, worktrees and current-workspace status.
4. Resolve relative paths under the selected project root, not `process.cwd()` or the previous active project. For new file destinations, validate the destination and nearest existing parent before writing.
5. Audit batch semantics. By default, all entries in one batch share the enclosing `projectId`; reject mixed absolute paths that resolve outside the chosen root. Per-item project routing is out of scope for the first release unless a strong workflow requires it.
6. Replace the current active-root-only YOLO check with the Phase 1 project authorization decision, while preserving target-root/path validation and capability checks.
7. Preserve backward compatibility for calls that omit `projectId`: they use the calling session's selected workspace, subject to its existing permissions.
8. Return project identity and normalized workspace in results/logs where useful, without disclosing credentials.

**Exit criteria**
- Separate local projects work through the same MCP connection and without chains.
- All file operations are rooted and authorized consistently.
- Legacy one-project calls continue to work.
- No operation against project B changes files, task state, locks, selected workspace or abort scope in project A.

### Phase 3 — First-class standalone SSH projects (without Workspace Chain)

**Primary files**
- `src/core/ssh/workspaceMode.ts`
- `src/core/ssh/sshProxy.ts`
- `src/core/ssh/sshConfig.ts`
- `src/core/ssh/sshCommands.ts`
- `src/core/workspace/WorkspaceChainManager.ts` (reference existing remote primitives; avoid requiring a chain object)
- `src/core/mcp/tools/workspaceTools.ts`
- `src/core/mcp/tools/networkContentMcpTools.ts`
- New standalone-SSH provider/connection manager module as determined by the audit
- New `tests/mcpStandaloneSshProject.test.ts`

**Tasks**
1. Define and validate the standalone SSH target contract (credential-free host/user/port/remote root). Resolve private-key paths and host aliases through the existing local SSH profile/config mechanisms. Keep secrets out of MCP tool results and registry files.
2. Implement a remote workspace provider interface for operations such as `exec`, `readFile(s)`, `writeFiles`, `list/find/grep`, and `git`. Route by the resolved project target rather than by mutable global SSH mode.
3. Do not assume the existing singleton `sshProxy` is safe for simultaneous targets. Add a project/session-keyed connection manager (or a demonstrably equivalent context-safe design), with connection reuse, timeout, bounded pool size, teardown, error recovery and no cross-target state mutation.
4. Reuse the current SSH path validation and allowlisted remote root rules. Treat the remote root as the security boundary and guard absolute paths, traversal segments, symlinks where the remote APIs permit reliable validation, and output-file parent paths.
5. Route generic MCP tools to the provider for supported remote operations. Keep tools that are inherently local explicitly local-only, returning a clear capability error rather than suggesting a chain as the only way to access a standalone SSH project.
6. Add read-only connectivity/metadata diagnostics only if they do not reveal secrets. Ensure logs identify project ID and operation, but redact user credentials and sensitive target parameters.
7. Keep `chain:` routed through the existing Workspace Chain adapter. A chain-only operation must require a chain target; standalone SSH must not be auto-wrapped in a one-node chain.

**Exit criteria**
- A registered SSH project can be selected and used directly without a Workspace Chain.
- Two SSH projects targeting different roots/hosts can operate concurrently without sharing clients, remote working directory, permissions or cached config.
- Authentication and host-key verification follow current supported SSH policy.
- Unsupported remote features fail explicitly and do not accidentally run against the local checkout.

### Phase 4 — Session isolation and transport integration

**Files**
- `src/core/mcp/mcpHttpTransport.ts`
- `src/core/mcp/mcpSessionRegistry.ts`
- `src/core/mcp/superagentMcpServer.ts`
- MCP route/auth middleware and lifecycle cleanup
- `tests/mcpHttpTransport.test.ts`
- `tests/mcpSessionRegistry.test.ts`
- `tests/mcpServer.test.ts`

**Tasks**
1. Verify default workspace and project-access grants are scoped to the appropriate authenticated session/principal; ensure session A cannot switch or revoke session B's context.
2. Verify simultaneous local-project calls and simultaneous SSH-project calls keep distinct context through the entire async operation.
3. Scope approvals, permission prompts, cancellation/abort, activity/audit events, file locks and long-running command state to the right project/session.
4. Define teardown on MCP session close, transport disconnect, timeout and process restart; ensure SSH clients are released without disconnecting another session's connection.
5. Test HTTP initialized sessions and stateless calls separately. A stateless call must pass an explicit `projectId` or use a documented fixed default.
6. Ensure stale clients that cached an older tool catalogue still encounter server-side validation and disabled-tool enforcement.

**Exit criteria**
- Two or more MCP sessions can target unrelated projects concurrently.
- Switching, cancellation, approval, lock cleanup and connection cleanup are isolated.
- No use of `process.chdir()` or mutable process-global active project is introduced.

### Phase 5 — Documentation, tool discovery and release readiness

**Files**
- `README.md`
- `CHANGELOG.md`
- relevant pages under `docs/wiki/` and MCP docs
- `docs/plans/2026-10-18-mcp-multi-project-management-implementation-plan.md`
- New capability matrix/test documentation

**Tasks**
1. Document the difference among registered projects, session default workspace, feature worktrees, standalone SSH project, and Workspace Chain.
2. Provide examples for registering two local roots, listing projects, granting access, calling a tool with `projectId`, and switching the session default. Add a standalone SSH example only after Phase 3 works end-to-end.
3. Ensure dynamic tool discovery and tool descriptions teach clients to list/inspect projects, then pass the stable `projectId` to the operation; avoid requiring models to memorize absolute paths.
4. Document local-only, SSH-supported, chain-only and global/session-only capabilities.
5. Run build, relevant focused tests, the full test suite in bounded batches if needed, lint/type checks, docs/wiki validation and `git diff --check`. Record exact results in the implementation plan/CHANGELOG once work is complete.

**Exit criteria**
- MCP documentation matches the actual tool schemas, permissions and runtime behavior.
- No claim of standalone SSH support appears before the Phase 3 acceptance tests pass.

## 5. Required end-to-end test matrix

| Scenario | Expected result |
|---|---|
| Two registered local roots outside the active workspace's root | Both usable only after their own project grants and capability checks pass |
| Registered project without an access grant | Denied with a project-access error |
| Project granted `read` only | Read/search/list permitted; write/patch/exec denied |
| Tool call includes `projectId: "shop-api"` | Operation uses only that project's canonical root |
| Next call targets `projectId: "shop-web"` | Operation uses project B; session default remains unchanged |
| `superagent_switch_workspace(projectId=B)` | Changes only calling session's default to B |
| Explicit `projectId` plus mismatched/out-of-root absolute path | Rejected; no fallback |
| Read/write batch with one out-of-root path | No outside write; result reports the rejected entry clearly |
| Concurrent A/B operations | No path, context, lock, plan/task, audit or permission crossover |
| HTTP sessions A/B | Workspace and grants remain isolated |
| Stateless MCP request | Requires explicit target or documented default; no persistence is implied |
| Standalone SSH target, valid identity | Supported file/search/command operations execute on that remote target |
| Two SSH projects called concurrently | Distinct project-scoped connection/config/path boundary |
| Invalid SSH URI or credential-bearing target | Rejected; credentials never written into the registry or returned |
| Remote tool not supported by SSH provider | Clear "unsupported for SSH project" error; must not execute locally |
| Workspace Chain calls | Existing chain behavior remains unchanged and still requires chain registration/policy |
| Disabled/removed/revoked project | Next call fails closed, including within an existing MCP session |

## 6. Definition of done

- The same MCP connection can work on at least two independent local projects without creating a Workspace Chain.
- Project selection is stable-ID based, explicit, documented, and isolated per call/session.
- Scoped YOLO remains restrictive; multi-project access is enabled through explicit per-project authorization rather than an unchecked bypass.
- Ordinary local MCP operations use the selected project's root consistently.
- Standalone SSH is supported through a project-aware remote provider and safe connection lifecycle, without requiring a chain; if Phase 3 is deferred, documentation must state that SSH entries are metadata only until that phase lands.
- Two local projects and two remote SSH projects have concurrency/negative-boundary tests.
- Workspace Chain features continue to work as a separate optional layer.
- Build and tests pass, results are recorded, and docs describe only verified capabilities.

## 7. Recommended implementation order

1. Phase 0: add end-to-end reproduction and tool capability audit.
2. Phase 1: implement explicit project authorization while preserving safety gates.
3. Phase 2: finish the independent local multi-project workflow.
4. Phase 4: verify session isolation alongside the local workflow; do not defer security testing to the end.
5. Phase 3: implement standalone SSH behind the provider boundary, with concurrency tests before exposing it broadly.
6. Phase 5: update docs/release evidence.

**Non-goal:** This plan does not rework Workspace Chain topology or enable disabled agent-orchestration tools. It makes independent projects first-class targets and preserves chain-specific features for workflows that truly need them.

## Current implementation status and limits

### Implemented in the working tree

- Project-access policy is persisted separately from the project registry, with a stable principal hash derived from MCP auth mode and subject and explicit capability grants. Grant operations require Full YOLO locally and a dangerous tool path; disabling, removing, or changing a project target revokes grants.
- Dispatcher-level authorization uses the resolved project ID and capability instead of assuming the active project root is the only possible target. The protected model configuration check remains enforced when a project grant expands access.
- Local independent-project integration coverage proves two unrelated roots can be targeted through the same MCP server and called concurrently without changing the default workspace or mixing returned files. Read-only grants do not authorize writes.
- The standalone SSH provider supports workspace inspection, command execution, batch file reads/writes, listing/search, and Git. It uses one proxy per registered SSH project, rejects credential-bearing target URLs, checks remote roots and realpaths for file operations, disables interactive password prompts and global tool-output capture, and returns explicit errors for unsupported tools instead of running them locally.
- Removing, disabling, or changing an SSH project target closes its cached project connection. Local project boundary checks and existing Workspace Chain requirements remain separate.
- Added docs/mcp/independent-projects.md and updated README, changelog, and API wiki notes.

### Security and verification caveats

- The SSH remote root protects supported file operations and controls the command working directory, but **does not sandbox arbitrary shell commands**. An allowed execute operation runs with the configured SSH user OS privileges. Full YOLO is required for destructive system commands.
- Tests cover routing, authorization, capability denial, concurrency, remote URL validation, unsupported-tool behavior, and transport isolation. No live SSH host was available, so key authentication, actual remote SFTP operations, remote symlink behavior on a real server, and cleanup after a network failure have not been end-to-end verified.
- The test suite was rerun after the final authorization changes in bounded shards; all 332 discovered test files completed with 3,224 passed tests, 5 skipped tests, and zero failures. Build, wiki-link validation, extension verification, and final git diff check passed. Live SSH host authentication and remote file operations remain unverified because no host credentials/endpoint are configured here.
