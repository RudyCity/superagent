# SuperAgent MCP: Provider Abstraction and Production Hardening Roadmap

**Date:** 18 October 2026
**Status:** In progress — A deterministic discovery hardening verified; B common local/SSH operations routed; C read-only health implemented; D audit context/rotation implemented; E session/provider isolation covered with mocks; full local suite passes; live-provider and approval-channel gates remain pending
**Repository:** D:\\backup from pc asus\\Documents Development\\superagent
**Baseline commit:** d4923e62 — feat: support independent MCP projects and SSH

## Executive summary

The independent-project foundation is implemented: registry/routing, per-identity grants, local and standalone SSH project handling, isolated MCP HTTP sessions, and audit logging. This roadmap execution added deterministic multi-turn discovery tests and stale-hook cache invalidation, a typed local/SSH provider route for workspace/health/file/search/write/execute/Git operations, per-project health checks, enriched audit context/rotation, and stronger session/SSH lifecycle tests. Live provider billing/latency and live SSH verification remain open gates.

The remaining work is evidence-led hardening: verify real provider outcomes, add any remaining cancellation/concurrency tests, and run the release gate. Keep Workspace Chain separate. Do not add per-action approval until a trustworthy out-of-band local owner channel exists; existing MCP authorization must not be misrepresented as individual user approval.

## 1. Current-state audit

### 1.1 Already present — do not rebuild

- **Dynamic Tool Discovery:** src/core/tools/toolDiscoveryState.ts and the Agent/schema projection progressively expose authorized schemas. Detailed plan: docs/plans/2026-10-14-dynamic-tool-discovery-single-multi-plan.md.
- **Project registry and resolver:** src/core/project/projectRegistry.ts, projectRouter.ts, and projectAccessPolicy.ts.
- **Local and standalone SSH targets:** normal local dispatch plus StandaloneSshProjectProvider in src/core/mcp/tools/standaloneSshProjectTools.ts.
- **Workspace Chain MCP adapter:** src/core/mcp/tools/workspaceChainMcpTools.ts; chains remain optional and distinct from standalone projects.
- **HTTP MCP session lifecycle:** src/core/mcp/mcpSessionRegistry.ts owns a transport/server pair per initialized session, with idle and maximum-lifetime cleanup.
- **MCP audit logging:** createMcpAuditLogger() in src/core/mcp/mcpHttpTransport.ts writes sanitized JSONL with tool, summarized arguments, success/error, duration, and session hash.
- **Existing safeguards:** safe-tool defaults, dangerous-tool opt-in, OAuth identity/scopes, Full YOLO checks for sensitive registry/grant operations, protected-file guards, project capability checks, and existing Agent/ToolExecutor plan or command approval mechanisms.

### 1.2 Gaps or behaviors not yet proven

1. **Tool discovery has deterministic loop coverage, but rollout evidence is incomplete.** Mocked native and prompt/XML loops, independent-task reset, continuation, mode reset, dangerous-command denial, and hook refresh are tested. Actual provider tokens, latency, task completion and live-provider compatibility remain unmeasured.
2. **Provider routing covers the agreed local/SSH operation set.** The typed contract and dispatcher route workspace info, health, batch reads, list/search, batch writes, command execution, and Git through explicit methods. Those methods intentionally delegate to existing guarded handlers/SSH dispatch rather than duplicating mechanics. Chain remains separate.
3. **Project health is locally tested and mock-tested, not live-SSH verified.** Tests cover missing roots, scope denial, SSH deadline behavior, stale SSH target rejection and connection teardown. Real SSH authentication/SFTP/recovery and Chain health remain unverified or unsupported.
4. **Audit context and log rotation are implemented.** Request-local events carry correlation ID, hashed principal, resolved project/provider, capability, decision and normalized failure code for explicit/implicit routing. The file rotates at a size limit with numbered archives; older generations expire beyond configured retention.
5. **Most project/session isolation has regression coverage; cancellation remains open.** Tests cover distinct HTTP session defaults, credential mismatch on session-ID reuse, concurrent local project calls, parallel mocked SSH hosts, deferred close during active operations, target-change cleanup, and grant revocation on the next call. Cross-project cancellation, locks/activity-event scoping, and real SSH interruption recovery remain pending.
6. **Per-action MCP approval was audited; no trusted owner channel is available.** MCP uses a safe-tool allowlist, --allow-dangerous/allowDangerous opt-in, OAuth mcp:tools:write scope, project capabilities, and local Full YOLO/scope checks. Agent/ToolExecutor onPermission and plan approval apply to the local model execution loop, not arbitrary HTTP MCP calls. Do not invent model self-approval; revisit only after adding a trusted local owner approval UI/CLI.

### 1.3 Baseline and constraints

- Last recorded full-suite run after the independent-project implementation: **332 test files discovered; 331 passed and 1 fully skipped; 3,224 tests passed, 5 skipped, 0 failures**.
- Last recorded additional checks: bun run build, bun run verify:extension-js, bun run wiki:validate, and whitespace checks passed.
- Baseline commit before this roadmap execution: d4923e62. The branch was main and ahead of origin/main by 3 commits at the last status check; the working tree contains ongoing implementation and unrelated pre-existing plan documents. Stage only intended files and do not sweep unrelated plan artifacts into a commit.
- Live SSH host end-to-end verification has **not** been performed because no test host/credentials were available. Do not claim live authentication, remote SFTP, or real-host symlink behavior has been proven.

## 2. Design rules

1. **Close evidence gaps before large refactors.** Extend the existing discovery plan instead of recreating its implementation.
2. **Provider routing is not authorization.** A resolved project/provider never grants a capability. Every call must pass identity, project grant, capability, tool policy, protected-file, and dangerous-operation checks.
3. **Resolve context once per call.** Resolve project ID, provider kind, normalized workspace/root, and selection source once. Pass typed context into a provider; do not re-resolve from process cwd inside handlers.
4. **No process-global active project.** Do not introduce process.chdir(), mutable global project selection, or global SSH mode as a routing mechanism.
5. **Keep provider interfaces narrow.** Initial shared contract covers workspace identity, health, file operations, command execution, and Git only where supported. Workspace Chain remains an orchestration adapter.
6. **Fail closed on unsupported features.** Unsupported operations return explicit capability errors and never fall back to the local checkout.
7. **Remote root is not a shell sandbox.** Root checks protect supported file/path operations; arbitrary commands execute with the SSH OS user's privileges. Keep this limitation explicit.
8. **Observability must redact.** Never log file contents, tokens, SSH passwords/private-key material, environment variables, or raw sensitive command arguments.
9. **No auto-approval.** Approval must be an explicit out-of-band user/operator action bound to the intended project, action, and authenticated context.
10. **Compatibility first.** Calls without projectId retain current default-workspace semantics. Do not rename MCP tools or register duplicate discovery aliases as part of this work.

## 3. Workstream A — Finish Dynamic Tool Discovery verification

**Priority:** P0
**Depends on:** None
**Primary reference:** docs/plans/2026-10-14-dynamic-tool-discovery-single-multi-plan.md

### Tasks

- [x] Run the exact discovery tests against current HEAD and record a current baseline without rewriting historical findings.
- [x] Add deterministic model-loop multi-turn tests for native tool calling and prompt/XML-based tool calling: bootstrap exposes only list_tools and describe_tool; describing an authorized tool exposes it on the next model iteration; the tool then executes through the normal permission-aware executor. The tests mock model responses; external live providers remain unverified.
- [x] Cover denied/unavailable tools, dangerous-command approval, cancellation, task continuation, independent-task reset, and mode/tier changes across the discovery integration tests and existing guardrail suites.
- [x] Add a dynamic-hook registry-refresh regression: a removed hook is removed from Agent catalogs and stale calls are rejected; a replacement hook can be discovered after refresh.
- [ ] Capture schema size, provider-reported token usage where available, latency, task completion and tool-selection failures on a small reproducible task set. Label static token estimates as estimates.
- [x] Document rollout/fallback behavior for provider compatibility without weakening tier allowlists. See the rollout decision below.

### Exit criteria

- [x] Native and prompt-based paths have matching schema exposure and execution semantics in deterministic Agent-loop tests.
- [x] Discovered schemas do not bypass the Agent-authorized catalog or dangerous-command approval; unauthorized global tools and dangerous-command denial are covered by integration regressions.
- [x] Dynamic-hook/catalog refresh cannot leave stale executable schemas; stale cached hook calls are rejected without running their command.
- [ ] Benchmarks record method, provider/model, task set and limitations; schema-token estimates alone are not presented as billed-token savings.

### Verification

    bunx vitest run tests/toolDiscoveryFuzzy.test.ts tests/toolRegistryConsistency.test.ts tests/extensionChatToolFilter.test.ts tests/agentDiscoveryTierProjection.test.ts
    bun run build

Add newly introduced provider/refresh tests to the command and run the full suite before declaring this workstream complete.

### Current rollout decision

- Progressive schema exposure remains the intended default for Master, Single, and Superagent tiers. Discovery never expands an Agent's authorized catalog.
- There is no automatic switch from provider-native to prompt/XML tool calling after a tool-schema failure. Retrying an ambiguous provider failure through another calling mode could repeat an operation or hide provider incompatibility.
- For custom endpoints that do not reliably support native tool calling, the existing `forcePromptBasedToolCalling` setting is the explicit operator-controlled fallback. The provider-loop regression covers both paths, but a live-provider compatibility matrix is still required before claiming production parity.
- Do not weaken tier allowlists or permission gates as a provider workaround.

### Execution log — 18 October 2026

- Current baseline command passed: `bunx vitest run tests/toolDiscoveryFuzzy.test.ts tests/toolRegistryConsistency.test.ts tests/extensionChatToolFilter.test.ts tests/agentDiscoveryTierProjection.test.ts` — 4 files, 38 tests.
- Added `tests/toolDiscoveryProviderFlow.test.ts`. It runs two actual `LoopIterationProcessor.processIteration()` calls with deterministic mocked model responses and checks schema payloads plus execution through the normal permission-aware executor for native function calling and prompt/XML calling — 2 tests passed.
- Added `tests/dynamicHookDiscoveryRefresh.test.ts`. The regression initially failed because a stale Agent active-tool cache still exposed and executed a removed hook after registry refresh. Added registry-version cache invalidation (`src/core/tools/toolRegistryVersion.ts`, `src/core/tools/index.ts`, `src/core/agent.ts`) and revalidated the Agent's current active catalog in `executeToolCall()` (`src/core/permissions.ts`). The test verifies no hook side effect occurs.
- Full-suite sharding then surfaced a related catalog-lifecycle edge case: the dynamic `wp` hook can enter the catalog during context building, and the old `ToolDiscoveryState` erased every discovered tool on any catalog fingerprint change. Replaced whole-catalog invalidation with per-tool name/schema signatures: adding an unrelated tool preserves existing discoveries, while a removed or schema-changed tool loses its discovery flag. Agent registry generation still resets discovery on explicit dynamic-hook refresh. `tests/tierToolsetResolution.test.ts`, `tests/dynamicToolDiscovery.test.ts`, and the refresh regression pass together.
- Added a mode-change reset regression to `tests/dynamicToolDiscovery.test.ts`.
- Expanded `tests/toolDiscoveryProviderFlow.test.ts` with real `Agent.sendMessage()` lifecycle tests: independent tasks return to the two discovery schemas, while a recognized continuation preserves a discovered schema. Added a dangerous `run_command` case to prove discovery does not bypass the regular permission callback; the callback denies execution and the tool implementation is never called. Existing cancellation/tier tests were run in the same guardrail verification batch.
- Latest combined guardrail verification: `bunx vitest run tests/dynamicToolDiscovery.test.ts tests/toolDiscoveryExecutionIntegration.test.ts tests/toolDiscoveryProviderFlow.test.ts tests/dynamicHookDiscoveryRefresh.test.ts tests/agentDiscoveryTierProjection.test.ts tests/agentAbortInterrupt.test.ts tests/yoloMode.test.ts tests/mcpYoloIntegration.test.ts` — 8 files / 75 tests passed.
- Current targeted command passed: `bunx vitest run tests/dynamicToolDiscovery.test.ts tests/toolDiscoveryExecutionIntegration.test.ts tests/toolDiscoveryProviderFlow.test.ts tests/dynamicHookDiscoveryRefresh.test.ts tests/toolDiscoveryFuzzy.test.ts tests/toolRegistryConsistency.test.ts tests/extensionChatToolFilter.test.ts tests/agentDiscoveryTierProjection.test.ts` — 8 files, 58 tests passed.
- `bun run build`, `bun run verify:extension-js` (8 files), `bun run wiki:validate` (9 wiki files / 24 links), and `git diff --check` passed after the implementation changes.
- Added `scripts/benchmark-tool-discovery.ts`. On the current declared toolsets, serialized schema measurements are: Master 48 tools / 34,914 bytes / 7,528 estimated tokens versus 2-tool bootstrap / 1,469 bytes / 329 estimated tokens (95.63% estimated reduction); Single/Superagent 67 tools / 67,575 bytes / 14,863 estimated tokens versus 329 bootstrap-token estimate (97.79% estimated reduction). A representative one-tool follow-up is 2,620 bytes / 574 estimated tokens.
- Benchmark numbers are serialized-schema estimates via `TokenTracker` / `cl100k_base`; they exclude system prompt, messages, provider overhead, tool results, and provider billing. The tests use deterministic mocked model responses; no live provider usage, real billed-token deltas, provider latency, or production task success rate has been measured.
- Workstream A remains partially complete: provider-loop behavior, refresh invalidation, lifecycle resets, permission guards, and serialized schema-size baseline are locally covered. Repeatable task latency/success metrics and live-provider compatibility remain release-gate gaps. The workspace/health slice is incremental and tested; keep wider provider refactors and production-parity claims gated by remaining evidence.

## 4. Workstream B — Introduce a capability-aware Project Provider contract

**Priority:** P1
**Depends on:** Workstream A test baseline
**Goal:** Unify the common project-operation boundary without rewriting every MCP tool or breaking local dispatch.

### Intended shape

Introduce a small type-level contract in src/core/project/; exact file names should be finalized after implementation audit. An illustrative API is:

    type ProjectProviderKind = "local" | "ssh";

    interface ProjectProvider {
      readonly kind: ProjectProviderKind;
      supports(operation: ProjectOperation): boolean;
      getWorkspaceInfo(context: ResolvedProjectContext): Promise<WorkspaceInfo>;
      healthCheck(context: ResolvedProjectContext, options?: HealthCheckOptions): Promise<ProjectHealth>;
      close?(context: ResolvedProjectContext): Promise<void>;
    }

This is illustrative, not a required exact signature. Prefer narrow file/search/exec/Git capability interfaces where needed. Avoid an all-powerful generic execute(operation, arbitraryArgs) function.


### Initial MCP operation/capability matrix

This records current policy boundaries. Runtime sets remain authoritative in src/core/mcp/mcpWorkspacePolicy.ts, src/core/mcp/mcpToolPolicy.ts, and src/core/project/projectAccessPolicy.ts.

| Operation group | Representative MCP tools | Current routing | Capability / gate |
|---|---|---|---|
| Global/session diagnostics | superagent_get_status, superagent_get_logs, superagent_server_health, superagent_get_token_usage | Process/session handlers | Existing tool classification/authentication; not implicitly re-targeted by projectId |
| Project registry | superagent_list_projects, superagent_get_project, superagent_register_project, superagent_update_project, superagent_remove_project | Project registry dispatcher | Read for inspection; mutations require existing dangerous-tool/Full YOLO guards |
| Project grants | superagent_list_project_access, superagent_grant_project_access, superagent_revoke_project_access | Project access policy | Authenticated identity; grant creation remains Full YOLO + dangerous-tool gated |
| Local + SSH shared provider operations | superagent_get_workspace, superagent_check_project_health, superagent_read_files, superagent_list_files, superagent_grep_search, superagent_find_files, superagent_write_files, superagent_exec_command, superagent_git_action | Typed ResolvedProjectContext and explicit ProjectProvider methods; guarded local handlers / standalone SSH dispatcher provide target mechanics | Read/write/execute/Git capability and MCP safety gates are checked before dispatch; unsupported SSH tools fail closed |
| Local + SSH operations not yet migrated into the provider contract | Worktree, planning, task/document, patch/edit, unlock and chain tools | Existing specialized workspace/chain handlers | Existing capability classifications remain authoritative; no generic provider executor added |
| Worktree/planning/document | superagent_manage_worktrees, superagent_get_current_task, superagent_manage_plan, superagent_update_tasks, superagent_read_document, superagent_office_cli | Existing workspace handlers | worktree, planning, read, or execute as defined by access policy; not yet migrated |
| Workspace Chain | superagent_list_workspace_chains, superagent_manage_workspace_chain, superagent_cross_workspace_exec | Chain-specific adapter/manager | chain capability and dedicated chain boundary; never coerce a chain URI into local/SSH |
| Browser, memory, remote-agent and other tools | Chrome/CDP, memory, tunnel and other runtime catalog names | Existing specialized handlers | Existing per-tool policy; do not assume project context applies unless workspace-scoped |


### Tasks

- [x] Enumerate MCP tools by global/session, project registry/grant, local+SSH shared, legacy project-scoped, Workspace Chain, and specialized-handler categories. See the Initial MCP operation/capability matrix above.
- [x] Define typed ResolvedProjectContext and ProjectOperation using the existing canonical router result and project metadata for the first migrated operations.
- [x] Implement the Local provider adapter for workspace metadata, read/list/search, write, execute, Git and shallow read-only health operations by delegating to existing guarded handlers. Dispatcher checks remain authoritative and the provider revalidates the canonical root.
- [x] Adapt standalone SSH workspace metadata, health, read/list/search, write, execute and Git actions to explicit provider methods while preserving remote realpath checks, no-interactive-auth behavior, and fail-closed dispatch. SSH operations continue to use the existing per-project dispatcher internally.
- [x] Keep Workspace Chain as a specialized adapter for topology/cross-node workflows; do not flatten chain operations into single-root file operations.
- [x] Migrate workspace-info/health, read/list/search, write/execute/Git vertical slices for local/SSH while preserving MCP tool names and public argument shapes.
- [x] Add conformance tests for local read/list/search/write/execute/Git and SSH mocked write/execute/Git, including protected paths, destructive-command denial, stale target invalidation, concurrent host routing and deferred teardown.
- [x] Preserve explicit unsupported-operation results. Regression tests verify an unsupported SSH operation fails closed and never dispatches to local execution.
- [ ] Complete live SSH host tests for authentication/SFTP/symlink behavior, transport interruption/recovery, and cancellation across simultaneous project operations; these cannot be claimed from mocks.
- [x] No Docker, Kubernetes, Codespaces, or marketplace provider was added in this phase.

### Exit criteria

- [x] Local and SSH use the same typed project context for workspace-info, health, read/list/search, write, command and Git operations.
- [x] Existing MCP tool names and required arguments remain backwards compatible; superagent_get_workspace retains its earlier response fields.
- [x] Provider selection does not grant permissions; read capability/session scope is checked before provider dispatch, and out-of-scope health denial does not return the target path.
- [x] Concurrent mocked SSH project calls retain host/root context; cleanup waits for in-flight calls, and unsupported SSH operations fail closed rather than using local handlers. Live-host behavior remains pending.
- [x] Chain-specific behavior remains routed through the dedicated chain adapter; Chain is deliberately not included in the local/SSH ProjectProvider interface.

### Execution log — 18 October 2026 (common-operation provider routing)

- The provider interface now exposes explicit methods for `workspace_info`, `health_check`, `read_files`, `list_files`, `grep_search`, `find_files`, `write_files`, `exec_command`, and `git_action`. The MCP dispatcher maps the named MCP operation to one of these typed methods after its existing project identity/capability/scope guards.
- `LocalProjectProvider` uses the existing guarded MCP handlers with a request-local async workspace context; it retains path-boundary checks, file locks, `.env`/`model-config.json` restrictions, Scoped YOLO, destructive command protections, and Git operation validation. It does not introduce a generic unrestricted command executor.
- `StandaloneSshProjectProvider` exposes the same named operation methods while using its existing registered-project SSH dispatcher for target parsing, remote SFTP realpath/root checks, protected file guards, destructive-command checks, and fail-closed behavior. An explicit per-method interface does not turn SSH remote-root validation into a shell sandbox: commands still run with the remote SSH account's OS privileges.
- Added provider test coverage for local write/execute/Git and protected `.env` denial; MCP dispatcher coverage confirms these calls actually flow through the provider contract; mocked SSH coverage validates write/execute/Git routing, `.env` and `model-config.json` denial, destructive command denial, target-retarget cache cleanup, and no local fallback for unsupported tools.
- Final full-suite verification after the provider, audit, session and discovery changes: `bunx vitest run --shard=1/5` through `--shard=5/5` — **335 test files discovered; 334 file passed and 1 fully skipped; 3,259 tests passed, 5 skipped, 0 failures**. A fresh build, extension verification, wiki validation and whitespace check also passed; see the consolidated Verification log.
- Live SSH host authentication, actual remote symlink behavior, interruption/reconnect behavior, and concurrent live-host tests are not available and must remain release gates.

### Verification

    bunx vitest run tests/mcpIndependentProjects.test.ts tests/mcpStandaloneSshProjectTools.test.ts tests/mcpProjectRouter.test.ts tests/mcpProjectAccessPolicy.test.ts
    bun run build

Include provider conformance tests in this command.

## 5. Workstream C — Project health and safe diagnostics

**Priority:** P1
**Depends on:** Workstream B's typed context; simple read-only local checks may be prototyped earlier.

### Proposed MCP tool

Implemented as superagent_check_project_health. It takes a required stable projectId and bounded timeout option, requires read access, and never installs dependencies, changes files, switches the workspace, or runs arbitrary package scripts. Workspace Chain diagnostics are not implemented and remain explicitly unsupported.

### Initial checks

- **Local:** registered/enabled status, root exists and is a directory, canonical root remains inside its registered boundary, Git repository/branch where safely discoverable, common manifests/lockfiles, and presence (not correctness) of common dependency directories.
- **SSH:** registered/enabled status, bounded connection/SFTP reachability, remote root canonicalization via realPath, and basic read-only metadata checks. Use strict timeouts; never prompt for credentials.
- **Chain:** not supported by this initial health tool. Integrate the existing chain configuration/topology diagnostics in a separate chain-aware adapter before reporting Chain health; do not connect to every node by default.
- **Common result:** projectId, provider type, check timestamp, per-check status, bounded message, duration, and remediation hints. Never return secrets or environment contents.

### Tasks

- [x] Specify input/output schemas and strict deadlines (timeoutMs is clamped to 1–15 seconds; SSH health returns unavailable when its deadline is exceeded).
- [x] Make shallow checks the default; health probes are read-only and do not install dependencies or run project scripts.
- [x] Use the project read capability and existing access policy; health success never grants write/execute authorization.
- [x] Return structured unavailable/degraded reports with per-check statuses when a probe fails instead of discarding all other results.
- [x] Test missing local roots, non-Git roots, healthy local diagnostics, and denied out-of-scope access without path disclosure.
- [x] Test stale SSH target changes, mocked SSH health timeout, and temporary-probe cleanup; local unhealthy/missing root and scope denial are covered.
- [ ] Test real SSH timeout/recovery, malformed live registry targets, and concurrent health checks against a real endpoint.
- [ ] Add Workspace Chain configuration/topology health through chain-specific diagnostics; the current health tool intentionally rejects Chain projects rather than treating them as local/SSH targets.
- [x] Document that manifest presence is informational only, is not a security scan, and does not prove the application runs.

### Exit criteria

- [x] Health checks are read-only and bounded; local checks return per-check results and mocked SSH checks return sanitized healthy/unavailable reports under a strict deadline. Live-SSH result consistency remains unverified.
- [x] Health error messages are sanitized and an out-of-scope request does not reveal the target path; live-host credential redaction remains an integration gate.

### Execution log — 18 October 2026 (initial provider and health slice)

- Added src/core/project/providers/types.ts and the initial ProjectProvider contract with typed ResolvedProjectContext, ProjectOperation, ProjectWorkspaceInfo, and structured ProjectHealthReport. The first supported operations are deliberately limited to workspace_info and health_check.
- Added LocalProjectProvider; it canonicalizes the registered root/workspace, denies root escape, and performs read-only root, workspace-boundary, Git-metadata, and common-manifest probes. A missing root produces an unavailable report, while absent Git/manifest metadata is informational (skipped), not a false failure.
- Adapted StandaloneSshProjectProvider for workspace metadata and health. Health uses a bounded deadline (clamped 1–15 seconds), remote root/workspace realPath checks, a generic failure report, and closes its cached connection on timeout. It disables interactive authentication as before. No live SSH endpoint was available; real-host timeout/recovery and SFTP behavior remain unverified.
- Added superagent_check_project_health as a safe MCP tool. It requires explicit stable projectId, is workspace-scoped, maps to the read capability, returns sanitized per-check statuses/messages, does not mutate files or install/run scripts, and refuses Workspace Chain health until chain-native diagnostics exist. Unauthorized health errors do not return the denied target path.
- Both providers re-read the current registry entry immediately before operation and fail closed if the project was removed, disabled, or retargeted after context resolution. Regression tests cover stale local contexts after target change and disable.
- Added MCP tests for healthy local diagnostics, missing-root unavailable, generic denial outside the session workspace, and the tool catalog increase to 70.
- Verification: bunx vitest run tests/projectProvider.test.ts tests/mcpServer.test.ts tests/mcpStandaloneSshProjectTools.test.ts tests/mcpProjectRouter.test.ts tests/mcpProjectAccessPolicy.test.ts — 5 files, 40 tests passed. bun run build passed at that point; a final rerun remains required after the next workstreams.
- Historical note: at the end of this initial slice, file/list/search/write/execute/Git and the broader conformance matrix were still pending. The later Workstream B execution log below supersedes that point-in-time status for the common operation set. Live SSH integration and Chain-specific health remain pending.

## 6. Workstream D — Project-aware audit context

**Priority:** P1
**Depends on:** Workstream B's canonical resolved context

### Tasks

- [x] Extend audit context with timestamp, tool, success, duration, session hash, resolved project ID, provider kind, required capability/action category, authorization-decision category, and normalized failure code.
- [x] Carry resolved context from dispatcher to logger per request. Tests cover explicit project IDs and implicit session-default routing without shared mutable audit state.
- [x] Preserve argument summarization/redaction and sanitize error summaries. Regression tests assert bearer/token values are not present in JSONL entries.
- [x] Record denied attempts and successful calls with normalized categories including capability_denied, protected_path, provider_unavailable, provider_timeout, and unsupported_operation; request-local decisions are correlated.
- [x] Keep audit writes non-throwing; the logger catches filesystem/rotation errors so audit I/O cannot break tool execution.
- [x] Add synchronous size-based rotation: 10 MiB current log and 5 numbered archives by default, configurable per logger. Older generations beyond configured retention are removed; deployments requiring longer retention must export archives. Each record append and rotation runs synchronously within the process.
- [x] Test audit metadata for implicit/explicit project selection and denied access; test health unavailable/timeout classification and the JSONL logger/rotation behavior.
- [x] Document fields and bounded retention in this roadmap. Default path remains ~/.superagent-r/mcp-audit.log.

### Exit criteria

- [x] Operators can identify target project/provider and normalized authorization outcome without storing file contents or credentials.
- [x] Audit success is derived from the MCP tool result (including isError and sanitized health-unavailable results), not simply HTTP transport acceptance or a presumed owner approval.

### Execution log — 18 October 2026 (audit context and rotation)

- `McpAuditInfo` and `McpServerOptions.onToolCall` carry a request correlation ID, hashed principal, resolved project/provider, capability, authorization decision and normalized error code. Context is local to each MCP tool call; implicit session-default routing is covered by dispatcher tests.
- The JSONL logger preserves safe argument summaries and redacts error summaries. It remains non-throwing on I/O failures. A logger instance rotates the current file before an append would exceed the default 10 MiB threshold and keeps five numbered archives by default (both settings can be configured). Rotation is synchronous within one process. Older archives beyond the retained count are deleted, so deployments with legal/compliance retention requirements must export archives to durable storage.
- Added `tests/mcpHttpTransport.test.ts` rotation coverage: 12 distinct records survive across current/numbered files, remain parseable JSONL, stay within configured file size, and preserve unique correlation IDs. Audit tests cover token redaction and explicit project metadata. MCP integration tests cover implicit/explicit project context and denied access.
- Logging records an authorization decision or operation outcome, not a separate owner approval. There is still no request-bound MCP approval workflow.

## 7. Workstream E — Session/provider lifecycle and action-approval audit

**Priority:** P1/P2
**Depends on:** Workstreams B and D

### Session/provider isolation

- [x] Add initialized-HTTP-session tests with separate workspace defaults, switching and implicit calls; credential mismatch cannot reuse an initialized session ID. MCP dispatcher tests cover explicit project targets and audit context. Grant revocation/disable has a separate existing-session regression.
- [x] Test overlapping operations across local and SSH projects using staggered async calls; mocked SSH project calls are verified to retain their own host/root.
- [x] Inspect the SSH provider's project-keyed connection cache. Each registered project has a separate target/config/proxy; in-flight reference counting defers disconnect until active operations release the connection. A health probe uses a temporary proxy.
- [x] Add idempotent provider cleanup on HTTP server shutdown and project disable/remove/target change; cleanup waits for in-flight operations. Real-host interrupted transport cleanup remains unverified.
- [ ] Check cancellation, file locks, long-running commands and activity events for project/session scoping. Document any intentionally global state and prevent cross-project cancellation or stale-lock cleanup.
- [x] Verify revocation and project disable take effect on the next MCP call in an already-created server/session; stale client tool schemas do not bypass dispatcher capability checks.

### Per-action approval — audit first, then implement only if missing

- [x] Map existing gates: safe-tool allowlist, allowDangerous, OAuth identity/scopes, project grants, Full YOLO/scope, and Agent/ToolExecutor plan or command approval. Local Agent approvals do not govern arbitrary HTTP MCP requests.
- [x] Identify the gap: dangerous MCP mutations are guarded by opt-in, project capability and scope/YOLO policy, but do not have a separate trusted per-action owner-confirmation channel in the HTTP server.
- [ ] Add a trusted local owner approval channel first; only then define pending approvals bound to principal/session, project ID, exact target/action, normalized argument digest, expiry, nonce and single-use status. Do not ship an unobservable or self-approvable MCP endpoint.
- [x] No trustworthy local owner approval channel is currently available to arbitrary HTTP MCP calls. The implementation retains the existing dangerous-tool allowlist and authorization gates; it does not introduce fake approval UI or self-approval.
- [x] No acting-model approval path was introduced. Request-bound approval/replay tests remain deferred until a trusted owner channel exists; current access remains governed by existing independent gates.

### Exit criteria

- [x] Session/server/project cleanup does not disconnect a provider connection while its operation is in flight (mocked regression). Live transport interruption remains pending.
- [x] Revoked or disabled project access is denied on the next call from the existing server/session.
- [ ] Per-action approval is intentionally not implemented until an out-of-band owner approval channel is added; do not claim this exit criterion complete.

### Execution log — 18 October 2026 (session/provider lifecycle and approval audit)

- Tests now cover concurrent initialized HTTP sessions with separate workspace state, credential mismatch when reusing a session ID, overlapping local workspace calls, simultaneous mocked SSH host calls, and next-call denial after project grant revocation/disable.
- The standalone SSH provider uses one cached config/proxy per registered project, request-time target validation, in-flight reference counting, deferred close, and a temporary proxy for health checks. Tests verify close waits for the active operation, target retarget closes the stale proxy, and health timeout does not disconnect the shared operation proxy.
- Added a defense-in-depth provider guard so direct SSH provider method calls also reject `.env` and `model-config.json` without local Full YOLO; this is in addition to the outer MCP safety boundary.
- Approval audit outcome: no trusted local owner approval UI/CLI channel was found for arbitrary HTTP MCP calls. Existing safe-tool defaults, `--allow-dangerous`, OAuth write scope, identity/project capability, and Full YOLO/scoped boundary remain the gates. Agent/ToolExecutor prompts are for local agent tool execution and are not an owner approval mechanism for HTTP MCP. No fake/self-approval endpoint was added. A true single-use request-bound approval flow remains deferred until a trusted operator channel exists.
- Remaining lifecycle gaps: cross-project cancellation, file-lock/activity-event isolation, and real SSH interruption/recovery need further tests. Real host access is unavailable here.

## 8. Workstream F — Real SSH integration and release gate

**Priority:** Required before calling standalone SSH production-verified
**Depends on:** Workstreams B and E

### Tasks

- [ ] Add an opt-in SSH integration suite against a disposable localhost container/VM or intentionally configured test host. Standard tests remain credential-free and do not require an internet host.
- [ ] Verify host-key checking and current SSH config resolution. Do not disable StrictHostKeyChecking to make tests pass.
- [ ] Exercise read, write, list/search, Git status and safe command execution under a temporary remote root; verify traversal and symlink escape denial for supported file operations.
- [ ] Run concurrent operations against two remote roots/hosts; verify connection/cache separation during disconnects and timeouts.
- [ ] Verify MCP never prompts for a password, secrets are not logged, and an unavailable host returns an explicit error without local fallback.
- [ ] Document prerequisites and exact invocation. Record this separately from mocked/unit test results.

### Release gate

- [x] Run focused tests per workstream.
- [x] Run bun run build, bun run verify:extension-js, bun run wiki:validate, git diff --check, and the full suite in five shards; results are in the latest Verification log.
- [x] Confirm disabled MCP tools remain disabled, safe-only sessions do not expose mutation tools, and discovery does not change authorization through existing MCP security/YOLO and discovery regression tests.
- [ ] Review changes for credentials, audit log artifacts, runtime data, skipped tests, temporary files and unrelated edits.
- [ ] Update README.md, CHANGELOG.md and docs/mcp/independent-projects.md only for behavior actually implemented and tested.
- [ ] Update this plan with exact results and make a Conventional Commit. Do not push unless explicitly requested.

## 9. Suggested execution order

1. **A — Finish discovery tests and benchmarks.** Close pending work in the existing plan; no new discovery architecture unless a failing test justifies it.
2. **B — Provider contract, narrow vertical slices.** Start with workspace info and health primitives, then file/search, followed by write/exec/Git.
3. **C + D — Health and project-aware audit context.** Use the provider contract and resolved context; keep health checks read-only.
4. **E — Session/provider lifecycle and approval audit.** Fix reproduced isolation defects; implement action approval only if a genuine gap and trustworthy operator channel are demonstrated.
5. **F — Real SSH integration and release gate.** Do not claim production readiness until external-host verification is recorded.

Do not combine all work into one giant refactor. Each subtask needs focused regression tests and must be independently reviewable.

## 10. Out of scope

- GUI Project Manager/dashboard.
- Provider marketplace, third-party provider plugins, Kubernetes, Docker provider, or Cloud IDE integrations.
- Rewriting Workspace Chain as a normal project provider.
- Replacing the MCP catalog with one unrestricted generic execution tool.
- Changing agent tiers, disabled orchestration tools, or default tool permissions.
- Automatic dependency installation, automatic project registration, or silent approval.
- Claiming live SSH security from mocks/unit tests alone.

## Verification log — latest local run, 18 October 2026

- `bun run build`: passed (TypeScript compilation).
- `bun run verify:extension-js`: passed; all 8 extension JavaScript files verified.
- `bun run wiki:validate`: passed; 9 wiki Markdown files and 24 internal links checked.
- `git diff --check`: passed after source changes and before this final roadmap-only update.
- Full test suite, sharded into five runs after the discovery lifecycle fix:
  - Shard 1/5: 67 files passed, 711 tests passed.
  - Shard 2/5: 67 files passed, 579 tests passed, 1 skipped test.
  - Shard 3/5: 67 files passed, 604 tests passed.
  - Shard 4/5: 66 files passed, 1 fully skipped file; 549 tests passed, 1 skipped test.
  - Shard 5/5: 67 files passed, 816 tests passed, 3 skipped tests.
  - **Aggregate: 335 test files discovered; 334 file passed and 1 fully skipped; 3,259 tests passed, 5 skipped, 0 failures.**
- Targeted provider test (`tests/projectProvider.test.ts`): 9 tests passed, covering local read/list/search/write/execute/Git, safety boundaries, health checks, and stale registry contexts. Mocked SSH provider tests (`tests/mcpStandaloneSshProjectTools.test.ts`): 8 tests passed, including destructive-command denial, protected-file denial, concurrent host isolation, stale-target cleanup, and health timeout isolation.
- Audit rotation targeted regression: passed with 12 JSONL records across the active file and numbered archives; every test archive stayed under the configured 420-byte limit. Default logger policy is a 10 MiB active file plus five numbered archives.
- Full suite and local build/docs gates are green. Live provider token/latency/task-success measurements and a real SSH host E2E were not run; they remain release gaps. Mocked provider tests are not substitutes for these external checks.
- Per-action approval was not implemented: no trusted out-of-band owner approval interface exists for arbitrary HTTP MCP requests, and a model-driven self-approval path would be unsafe.
- Local Conventional Commit `63820225` contains only the implementation files and this roadmap; unrelated pre-existing plan documents remain unstaged. No push was performed. Live SSH/provider verification and a trusted owner-approval channel remain open release gates.

## 11. Definition of done

This roadmap is complete only when discovery semantics are proven with multi-turn provider tests and real task outcomes; local and standalone SSH share a narrow typed routing/provider contract for migrated operations; health checks are read-only and bounded; audit events identify project/provider and authorization outcome while redacting secrets; session/provider cleanup and concurrency are tested; any action approval uses a trustworthy operator-controlled path; SSH integration has an explicit result; and full verification, documentation, changelog and commit details are recorded.
