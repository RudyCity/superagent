# MCP Provider Architecture and Production Hardening Plan

**Date:** 18 October 2026
**Status:** Planned; documentation only. No implementation work is included in this plan.
**Repository:** `D:\\backup from pc asus\\Documents Development\\superagent`
**Branch / HEAD inspected:** `main` / `d4923e62`
**Working tree before this document:** clean; branch was one commit ahead of `origin/main`.

## 1. Objective

Turn the recently implemented independent local/SSH MCP project support into a maintainable and operable provider architecture. Close the remaining progressive tool-discovery validation gaps, prove that authorization and mutable state remain isolated under concurrent MCP sessions, provide read-only project health diagnostics, and make the existing audit/approval controls more observable and verifiable.

This is a follow-up plan, not a claim that the remaining items are already implemented. The first stage must confirm each current contract before refactoring it.

## 2. Current state confirmed during inspection

### Implemented and to be preserved

- Independent project registry and per-call routing by stable `projectId`, without requiring a Workspace Chain.
- Explicit per-identity project grants for `read`, `write`, `execute`, `git`, `worktree`, `planning`, and `chain`; registration does not itself grant access.
- Standalone SSH project dispatch for workspace inspection, command execution, batched file reads/writes, listing/search, and Git. Unsupported SSH operations fail closed rather than running against the local checkout.
- Local project roots and supported SSH file operations have path-boundary checks. SSH remote-root checks do not sandbox arbitrary shell commands; an authorized command runs with the SSH account's OS privileges.
- MCP HTTP uses a per-session transport/server registry, binds each session to its authenticated identity, and applies idle and maximum-lifetime limits. Mutable active workspace/project state is scoped to the created MCP server instance.
- Audit infrastructure already exists: `createMcpAuditLogger()` appends sanitized JSONL records, and `mcpActivityBus` records activity for live UI and cross-process consumption.
- Single Mode and Multi Mode already use progressive schema discovery through `list_tools` and `describe_tool` at the Agent schema-construction boundary. The authorized tool catalog stays separate from the currently model-visible schemas.

### Remaining gaps or claims not yet verified

- The existing dynamic tool-discovery plan explicitly leaves provider-level multi-turn completion, dynamic-hook refresh integration, and real task-level payload/latency/success measurements pending.
- There is no shared project-provider interface used uniformly by both local operations and standalone SSH. The SSH provider is a concrete dispatcher alongside local handlers and project routing.
- Session-registry unit tests and HTTP integration tests exist, but the full cross-session matrix for concurrent project selection, revoked grants, approval state, cancellation, SSH config/connection lifetime, and shutdown has not been established as one acceptance gate.
- Audit records currently focus on tool name, sanitized argument summary/shape, outcome, error, duration, and a session credential hash. They do not consistently carry canonical project ID/provider/capability/authorization-decision/correlation context.
- Existing server health diagnostics are not a comprehensive, read-only health report for each registered local or SSH project.
- Dangerous-tool opt-in, project-grant safeguards, Full YOLO, and OAuth owner-consent flows exist. A distinct, request-bound approval lifecycle for individual high-risk MCP mutations still needs a design audit; it must not be confused with OAuth startup consent or implemented as a second conflicting permission system.
- No live SSH host is configured in the current environment. Real SSH authentication, SFTP, symlink behavior, connection recovery, and teardown have not been end-to-end verified.

## 3. Design constraints

1. Preserve the existing execution path and permission checks. Tool discovery, provider resolution, health checks, and approval records must never grant authorization by themselves.
2. Resolve one canonical project context per tool call. The context carries the stable project ID, provider type, canonical target, requested capability, authenticated principal/session metadata, and cancellation signal where available.
3. Never use `process.chdir()` or a process-global mutable active-project setting. A per-call `projectId` must not change the session default. An explicit workspace switch may change only the calling MCP server/session.
4. Re-evaluate project status and grants at the time of the operation. Do not trust stale client schemas or cached permission snapshots after a project is disabled, retargeted, or revoked.
5. Keep local, SSH, and Workspace Chain semantics distinct. Shared provider contracts should cover genuinely common operations; chain orchestration is not to be forced into a one-node SSH abstraction.
6. Use typed capability/support metadata so unsupported operations fail explicitly before side effects. Never fall back to local execution when a remote operation is unsupported.
7. Keep SSH remote-root checks narrowly described: they protect supported file operations but are not an OS-level sandbox for arbitrary commands.
8. Keep user-facing MCP/API/docs strings in English, consistent with repository rules.
9. Use existing test infrastructure and add deterministic tests first. External-provider tests must be opt-in or fixture-backed and must never depend on production credentials.
10. Keep audit summaries redacted. Never log credentials, access tokens, full file bodies, private-key contents, or raw model configuration values.

## 4. Proposed architecture

### 4.1 Project context and provider contract

Add a small, typed provider boundary after auditing the current local handlers and SSH dispatch. Suggested location: `src/core/project/providers/`.

Initial common contract should cover only operations which can be represented consistently:

- Provider identity and supported-capability/operation discovery.
- Workspace metadata.
- Batched file reads and writes, with an explicit canonical root and path validation.
- List, grep, and find operations.
- Command execution with explicit cwd, timeout, cancellation, and result metadata.
- Git status/diff/log and explicitly scoped mutations, with operation-level capability checks.
- Read-only health inspection.
- Per-project cleanup/disposal.

Suggested conceptual shape (not a frozen API):

```ts
interface ProjectProvider {
  readonly type: "local" | "ssh";
  supports(operation: ProjectOperation): boolean;
  getWorkspace(context: ProjectContext): Promise<WorkspaceInfo>;
  execute(context: ProjectContext, operation: ProjectOperation): Promise<ProjectOperationResult>;
  checkHealth(context: ProjectContext): Promise<ProjectHealthReport>;
  dispose(projectId: string): Promise<void>;
}
```

Prefer typed operation inputs/results over an unrestricted `Record<string, any>` dispatcher. Do not create a new general-purpose bypass around the existing MCP tool definitions. Existing tool handlers should continue to own schema validation; the provider boundary owns target-specific mechanics and root enforcement.

### 4.2 Provider routing

- Resolve the target using the existing project router.
- Load the enabled registry entry and select the provider by its registered type.
- Validate the requested operation against provider support.
- Calculate the required project capability and validate identity grant / local safety mode.
- Pass the canonical resolved context to the provider.
- Sanitize and return provider results with project ID and operation metadata.
- On project disable, remove, retarget, or server shutdown, dispose stale provider resources without disrupting another in-flight operation.

Start with a compatibility adapter for local handlers and the existing SSH provider; avoid a large rewrite of all handlers in one step. Workspace Chain keeps its existing resolver and manager until a later design explicitly addresses chain operations.

## 5. Implementation phases

### Phase 0 — Contract inventory and baseline

**Purpose:** Establish exactly what exists at the current HEAD before changing architecture.

**Tasks**
1. Build a tool capability matrix from the actual MCP schema/registry and dispatcher: workspace-scoped, global/session-scoped, local-only, local-and-SSH, chain-only, read-only, mutating, and destructive.
2. Review tool descriptions and schemas for consistent `projectId` support. Identify tools where accepting `projectId` is undocumented or a workspace operation is incorrectly classified as global.
3. Trace the current audit hooks from HTTP request through project routing, capability enforcement, SSH dispatch, tool result, and journal.
4. Trace approval mechanisms separately: dangerous-tool allowlist, Full YOLO, OAuth owner-consent, and any interactive permission prompts. Document which paths are available to an MCP request and which are not.
5. Record focused test baseline, build, extension verification, wiki validation, and current git state. Keep existing tests and unrelated files unchanged.

**Exit criteria**
- A checked-in matrix identifies the authoritative policy for each workspace-scoped tool.
- No implementation claims depend on an old plan's historical HEAD or old test run.
- Existing and missing approval/audit behavior is explicitly separated.

### Phase 1 — Finish progressive tool-discovery validation

**Primary areas**
- `src/core/tools/toolDiscoveryState.ts`
- `src/core/tools/toolDiscoveryTools.ts`
- `src/core/tools/toolsets.ts`
- `src/core/agent/ContextBuilder.ts`
- `src/core/agent/LoopIterationProcessor.ts`
- `src/core/agent/ToolExecutor.ts`
- `src/core/tools/index.ts`
- Relevant discovery and provider-call tests.

**Tasks**
1. Add a deterministic multi-turn provider integration test: the model requests a schema with `describe_tool`, the next model request includes the selected schema, and the real Agent-scoped implementation is invoked.
2. Cover both provider-native function calling and prompt/XML-based tool calling with matching schema visibility and execution behavior.
3. Add a dedicated dynamic-hook/registry refresh test. Newly registered tools must be discoverable only if authorized; removed or changed tools must invalidate stale discovered schemas.
4. Verify discovered schemas are reset or preserved correctly across independent tasks, recognized continuations, tier/mode changes, cancellation, and Agent disposal.
5. Verify authorization prompts, cancellation, protected-file denial, dangerous-command checks, and tier restrictions are unchanged by progressive exposure.
6. Add benchmark tooling for first-request schema payload and follow-up payload, estimated schema tokens, tool-selection success, task completion, latency, and failure rate. Clearly distinguish static token estimates from provider-billed usage.
7. Run a small deterministic mock-provider matrix in CI and document an opt-in manual matrix for supported live providers. Do not add a fallback flag unless measurements reveal a compatibility issue that needs one.

**Exit criteria**
- Multi-turn schema discovery works through the actual model-call loop, not only direct helper/dispatcher tests.
- Dynamic-hook changes and lifecycle resets are covered by regression tests.
- No tier or permission boundary can be bypassed by describing a tool.
- Benchmarks report repeatable before/after measurements; any untested live-provider claims remain labeled unverified.

### Phase 2 — Introduce the provider boundary incrementally

**Primary areas**
- New `src/core/project/providers/` modules, after Phase 0 confirms the final boundaries.
- `src/core/project/projectRouter.ts`
- `src/core/project/projectRegistry.ts`
- `src/core/mcp/tools/standaloneSshProjectTools.ts`
- `src/core/mcp/superagentMcpServer.ts`
- Local workspace/file/Git handler modules and their tests.

**Tasks**
1. Define `ProjectContext`, supported operation types, provider results, error categories, cancellation behavior, and disposal semantics.
2. Implement a local provider adapter around current local mechanisms without duplicating permission or tool-schema validation.
3. Adapt the existing SSH provider to the same interface. Keep its per-project cache and root checks, and make connection/operation concurrency behavior explicit.
4. Have the MCP dispatcher route supported workspace-scoped operations through the provider registry after authorization.
5. Return a stable unsupported-capability error before side effects. Never run a locally implemented fallback for a requested SSH operation.
6. Preserve current stable project IDs, access grants, Full YOLO requirements, protected-config restrictions, and Workspace Chain behavior.
7. Define how relative paths, subdirectories, symlinks, batch failures, timeouts, and partial results are represented in the shared result contract.
8. Add contract tests that run against both local and SSH provider fixtures; add provider-specific tests for behavior that cannot be made identical.

**Exit criteria**
- Local and SSH operations share one explicit routing contract for the agreed operation set.
- Existing MCP tool names and schemas remain compatible unless an independently justified schema change is documented.
- Unsupported remote operations fail closed.
- Local, SSH, and chain targets cannot be silently reinterpreted as another provider type.

### Phase 3 — Prove session, identity, and connection isolation

**Primary areas**
- `src/core/mcp/mcpHttpTransport.ts`
- `src/core/mcp/mcpSessionRegistry.ts`
- `src/core/mcp/superagentMcpServer.ts`
- `src/core/project/projectAccessPolicy.ts`
- SSH provider context/connection lifecycle
- `tests/mcpHttpTransport.test.ts`, `tests/mcpSessionRegistry.test.ts`, `tests/mcpIndependentProjects.test.ts`, and SSH provider tests.

**Tasks**
1. Test two simultaneously initialized MCP sessions with different default projects and interleaved operations; their workspace switches must never cross.
2. Test two identities against the same project and one identity against multiple sessions. Grants remain per authenticated identity; mutable active workspace remains per MCP server/session.
3. Test explicit per-call `projectId` calls concurrently with default-workspace calls. Explicit routing must not mutate the default.
4. Test access revocation, project disable, remove, and target change while sessions remain initialized. The next operation must fail closed, and a stale client schema must not restore access.
5. Verify read-only access cannot write/execute, a project grant cannot override protected-file restrictions, and OAuth scopes / dangerous-tool policy are still checked.
6. Test concurrent SSH operations targeting different projects and subdirectories. Confirm `workspaceMode.runWithWorkspaceConfig`, cwd, connection/cache state, output capture, and cancellation do not leak between calls.
7. Make connection cleanup idempotent on project removal, disable/retarget, session close, idle timeout, transport close, and MCP server shutdown. A session closing must not disconnect a connection still used by another in-flight operation.
8. Exercise stateless MCP requests separately from initialized sessions; document where persistence is not implied.
9. Add rejection cases for mismatched credentials reusing an existing `mcp-session-id`.

**Exit criteria**
- The concurrent local A/B and SSH A/B matrix passes without context, file, grant, event, cancellation, or connection crossover.
- Every authorization change takes effect on the next tool call.
- Teardown releases stale resources without disrupting other active sessions or requests.
- Any shared per-project SSH connection is demonstrably safe for concurrent use, or the provider is changed to isolate state appropriately.

### Phase 4 — Add per-project health diagnostics

**Proposed tool name:** `superagent_check_project_health` (confirm naming against repository conventions during implementation).

**Tasks**
1. Add a read-only health operation for one enabled registered `projectId`; it must use the same target resolution and authorization rules as other project inspection operations.
2. Local checks: path exists and is a directory, canonical real path remains under the registered root, readable/writable status where safely testable, Git repository/branch status when applicable, and manifest/dependency hints as optional heuristics rather than universal requirements.
3. SSH checks: configured target is valid, connection/authentication succeeds, SFTP can resolve the registered root, and read-only metadata checks complete within strict timeouts.
4. Chain projects report chain-specific readiness using existing chain diagnostics; do not treat a chain URI as a plain local or SSH target.
5. Return a stable structured report: project ID/type, overall `healthy` / `degraded` / `unavailable` state, named checks, sanitized reason, duration, and timestamp. Do not expose credentials, key paths unless explicitly safe, command secrets, or full configuration.
6. Bound concurrency and timeout; support partial results when one check fails; health checks must not install packages, create files, change Git state, or run arbitrary user commands.
7. Add negative tests for missing roots, disabled projects, insufficient grants, invalid SSH targets, auth failures, timeouts, host/network errors, and root escapes.

**Exit criteria**
- Health check is safe, read-only, bounded, and informative enough to diagnose common local/SSH setup problems.
- Failure in one check is represented without hiding other check results.
- Health check authorization never exposes a project merely because it is registered.

### Phase 5 — Enrich audit events and operational diagnostics

**Primary areas**
- `src/core/mcp/mcpHttpTransport.ts` (`McpAuditInfo` / `createMcpAuditLogger`)
- `src/core/mcp/mcpToolPolicy.ts`
- `src/core/mcp/superagentMcpServer.ts`
- `src/core/mcp/mcpActivityBus.ts`
- `src/core/mcp/mcpLogSanitizer.ts`
- Audit and transport tests.

**Tasks**
1. Keep the security audit log and UI activity bus purposes distinct, but share a stable event contract or a well-defined mapping so they cannot disagree on the resolved project/operation.
2. Enrich security audit entries with request/correlation ID, hashed principal identity, session hash, canonical project ID/type, provider, tool, required capability, authorization decision, outcome/error category, duration, and safe result summary.
3. Record denied attempts as well as successes, including missing grant, disabled project, unsupported provider operation, protected-file block, scope denial, and approval timeout/denial.
4. Record approval request/decision IDs once the approval phase exists. Never record bearer tokens, OAuth tokens, SSH credentials/private keys, sensitive argument values, file contents, or complete tool outputs.
5. Keep error messages bounded and sanitized. Add redaction tests for tokens, passwords, `.env`, `model-config.json`, Authorization headers, SSH URLs, and nested tool arguments.
6. Define bounded log growth and retention/rotation for `mcp-audit.log` and `mcp-activity.jsonl`; tolerate partial lines and recovery after restart.
7. Make audit-write failure behavior explicit. Preserve current non-throwing behavior as a baseline, then decide which high-risk mutations must fail closed if durable audit cannot be written. Do not silently change semantics without tests and documentation.
8. Verify logs identify the correct project for concurrent A/B calls and do not leak one workspace's activity into another workspace's UI subscription.

**Exit criteria**
- Every project-scoped operation can be correlated from request to authorization outcome to provider result.
- Security-sensitive denials are observable without storing secret-bearing payloads.
- Logs remain bounded, parseable, redacted, and correct under concurrent writes.
- The chosen audit-write failure policy is documented and tested.

### Phase 6 — Request-bound approval workflow for high-risk actions

**Purpose:** Make the local owner approval requirement explicit for selected high-impact MCP operations, without duplicating existing permissions or treating an MCP client's own response as owner approval.

**Tasks**
1. Inventory and reuse the existing permission/approval mechanisms where viable. Distinguish local dangerous-tool opt-in, Full YOLO, OAuth owner-consent, and one-off action approval in code and docs.
2. Define risk levels and scope an initial pilot to operations such as broad multi-file writes, destructive Git/system commands, project grant changes, or high-impact remote execution. Read-only tools remain unaffected.
3. Represent a pending approval with a cryptographically unguessable ID, authenticated requester/principal, MCP session, canonical project ID/type, operation name, normalized-arguments digest, reason, creation/expiry time, and single-use state.
4. Bind approval to the exact operation and target. Any argument, project, capability, or target change invalidates the approval. Expired, denied, cancelled, previously used, or mismatched approvals fail closed.
5. Route approval to the trusted local owner/approval UI or the already-supported trusted authorization path. The same remote MCP caller must not self-approve its own request.
6. Define approve, deny, expire, cancel, and execute-failure states. Prevent duplicate execution on retries and record final disposition in the audit log.
7. Preserve Full YOLO and existing permission guards as independent gates; approval is not a way to grant project access or bypass sensitive-file protections.
8. Start behind a deliberate opt-in setting. Do not enable new blocking approval prompts by default until the workflow is verified in the supported client/UI modes.

**Exit criteria**
- Approval is bound to an exact, short-lived, single-use operation and project.
- Another identity/session cannot approve, replay, or alter the action.
- Denial, timeout, disconnect, cancellation, and argument changes do not execute the pending operation.
- Existing dangerous-tool classification, Full YOLO, and protected-file policies remain authoritative.

### Phase 7 — Real-provider and release validation

**Tasks**
1. Add an isolated SSH integration fixture, preferably a disposable localhost SSH server in CI. If CI cannot run an SSH daemon, keep a clearly labeled optional integration suite and record the remaining coverage gap.
2. Exercise key-based authentication, root SFTP operations, writes and reads, Git metadata, symlink boundary checks, permission denial, network interruption, reconnection, project retargeting, and cleanup.
3. Run the complete test suite in bounded shards if required by memory/timeout limits; record exact file/test totals and skipped tests.
4. Run `bun run build`, `bun run verify:extension-js`, `bun run wiki:validate`, and `git diff --check`.
5. Reconcile README, changelog, MCP documentation, API wiki, this plan, and the earlier dynamic discovery plan only after implementation evidence is available.
6. Verify generated docs and tool counts from runtime/schema sources rather than hardcoded assumptions.
7. Do not commit or push as part of a plan-only task. Implementation work must report the final changed-file list and exact verification results.

**Exit criteria**
- Local and fixture-backed SSH checks cover successful, denied, timeout, failure, and teardown paths.
- All required project/security tests and build/docs checks pass.
- Live provider claims are limited to behaviors actually verified in CI or an explicitly described manual test.
- The plan records any residual gap and a clear release decision.

## 6. Required regression matrix

| Scenario | Expected result |
|---|---|
| Model describes a permitted tool in Single/Multi Mode | Schema appears on the next model request and the Agent-scoped implementation executes |
| Model describes an unregistered/unauthorized tool | No schema activation and no execution |
| Dynamic tool registry changes during a task | Stale schemas are invalidated; current authorization is respected |
| Native and prompt/XML tool-calling modes | Identical authorization and selected-schema semantics |
| Two MCP sessions default to projects A and B | Switching or calling in A never changes B |
| Explicit call to project B from a session defaulted to A | Call uses B; session default remains A |
| Grant revoked or project disabled after initialization | Next operation is denied, even if the client cached the schema |
| Same project used concurrently by two sessions | Independent active defaults and no cross-session permission state |
| Two SSH projects used concurrently | Correct host/root/client/cache used by every operation; no shared mutable target |
| Unsupported operation targeted at SSH | Explicit unsupported result; no local fallback or side effect |
| Project health check on unauthorized project | Denied without revealing sensitive project metadata |
| SSH host/authentication/path failure during health check | Bounded sanitized degraded/unavailable result; no mutation |
| Protected config or secret passed to an operation | Existing sensitive-file policy remains effective; no secret stored in audit |
| Audit for denied and successful operation | Correlatable event contains safe project/operation metadata and redacted arguments |
| Audit storage failure | Behavior follows the documented per-risk policy, never silently changes semantics |
| Action approval is expired, replayed, modified, or from another identity | Denied and not executed |
| Session closes during an SSH operation | Defined cancellation/cleanup behavior without damaging another request |
| Stateless request versus initialized session | Only documented per-request/default semantics are relied on |

## 7. Suggested implementation order

1. Phase 0: contract and security inventory.
2. Phase 1: finish the existing dynamic discovery plan's outstanding integration/benchmark work. This is independently testable and reduces regression risk before the provider refactor.
3. Phase 3: add missing session/concurrency regressions early, before changing connection/provider internals.
4. Phase 2: introduce the local/SSH provider boundary incrementally against the regression matrix.
5. Phase 4: project health check built on the new provider contract.
6. Phase 5: enrich audit metadata and policy without duplicating the activity bus.
7. Phase 6: implement an action approval pilot only after identifying the existing trusted approval UI/path.
8. Phase 7: full release and fixture-backed SSH validation.

Phases 2 and 3 may overlap once the baseline tests are in place, but their exit criteria remain separate. Do not begin with the GUI/dashboard; reliable provider semantics, authorization, health data, and audit data should be stable first.

## 8. Non-goals

- Replacing existing MCP tools with one unrestricted generic executor.
- Rewriting Workspace Chain or disabling its current workflow.
- Claiming Docker, Kubernetes, or cloud IDE provider support in this plan.
- Treating SSH remote-root validation as a sandbox for shell commands.
- Adding a project dashboard before the provider, health, audit, and authorization contracts are stable.
- Claiming live-provider reliability without a repeatable integration fixture or explicitly documented manual evidence.

## 9. Definition of done

- Progressive tool discovery has provider-level multi-turn tests, dynamic-hook refresh coverage, and measured payload/task results.
- Local and standalone SSH operations share a typed provider contract for the documented common capabilities.
- Cross-session project, identity, grant, cancellation, and SSH connection behavior passes concurrent and negative tests.
- A safe read-only per-project health check provides actionable, sanitized diagnostics.
- Audit entries correlate request, identity, project, authorization, provider result, and approval without exposing secrets.
- Any action approval is exact-request-bound, expiring, one-time, owner-authorized, and cannot bypass the existing safety gates.
- Test/build/docs results and any unverified remote behavior are recorded accurately.
