# Dynamic Tool Discovery for Single and Multi Mode

**Date:** 14 October 2026
**Status:** Initial rollout and runtime-dispatch fix implemented; focused regressions pass, full provider-level parity remains pending
**Repository inspected:** `D:\\backup from pc asus\\Documents Development\\superagent`
**Branch / HEAD observed:** `main` / `3e97835a`

## 1. Goal

Reduce the tool-schema payload sent to the model in Single Mode and Multi Mode. Initially expose only the existing tool-discovery entry points, then expose the full schemas for tools that the model explicitly discovers and needs.

The intended model-facing sequence is:

1. Discover relevant capabilities with `get_tools` (existing canonical schema: `list_tools`).
2. Request exact schemas with `describe_tools` (existing canonical schema: `describe_tool`).
3. Make the selected tools available to the model on the next model iteration and execute them through the existing permission-aware path.
4. Retain the selected schemas for the current task/continuation, and reset or invalidate them at well-defined task, tier, or capability boundaries.

This is **progressive exposure of schemas**, not removal or unloading of implementation code. The internal registry and all authorized capabilities remain available to the runtime.

## 2. Codebase Findings

### F1. Tool discovery already exists; do not recreate it

- `src/core/tools/toolDiscoveryTools.ts` defines `list_tools` and `describe_tool`.
- `list_tools` supports fuzzy filtering and returns tool names with short descriptions.
- `describe_tool` returns a selected tool's description and JSON parameter schema, and can describe more than one name in a call.
- The same module exports `getToolsTool` and `describeToolsTool` as aliases of those definitions.
- `src/core/tools/index.ts` resolves `get_tools` to `list_tools` and `describe_tools` to `describe_tool` through `TOOL_ALIASES`. These are currently resolver aliases, not separately registered model-facing tools.
- Existing tests: `tests/toolDiscoveryFuzzy.test.ts` and `tests/toolRegistryConsistency.test.ts`.

**Implication:** Reuse the existing discovery API and preserve aliases. The first implementation should keep the existing canonical schema names `list_tools` and `describe_tool`; exposing aliases as separate native schema names would be a distinct compatibility change and is not required for staged discovery.

### F2. Current mode-aware discovery is filtering, not progressive loading

- `src/core/tools/toolsets.ts:309-357` implements `withModeAwareDiscoveryTools()`.
- It replaces the two discovery definitions with wrappers whose catalog is restricted to the supplied toolset. This correctly keeps extension-dependent Chrome tools hidden in non-extension mode.
- The wrapper then returns the entire supplied toolset plus the two discovery tools. It does **not** hide other schemas from the model.
- `tests/extensionChatToolFilter.test.ts` covers extension-mode filtering and the mode-aware listing behavior.

**Implication:** Extend the existing boundary carefully. Do not describe `withModeAwareDiscoveryTools()` as already providing staged tool loading.

### F3. Single and Multi server sessions choose different tier toolsets

- `src/server.ts:101-160` implements `createAgentForMode()`.
- For non-extension clients, Multi Mode starts with `masterToolset`; Single Mode starts with `superagentToolset`. Both are filtered to exclude the 12 extension-dependent tools, then wrapped by `withModeAwareDiscoveryTools()`.
- Multi Mode sets `agent.tier = "master"` and `agent.isMultiAgent = true`; Single Mode sets `agent.tier = "single"`.
- `src/core/agent.ts:416-465` selects and caches active tools. The active-tools cache currently has a five-second TTL. Single and Superagent tiers receive `superagentToolset`; Master receives `masterToolset`; Subagents have their own specialized toolsets.
- The normal CLI/non-server path also relies on `Agent.getActiveTools()`, so a change made only in `createAgentForMode()` would be incomplete.

**Implication:** Implement at the shared agent/schema-construction boundary, covering server and non-server execution paths, while preserving the tier-specific catalog.

### F4. The complete active schema list is currently sent on every model iteration

- `src/core/agent/ContextBuilder.ts:99-124` obtains `agent.getActiveTools()`, maps the tools to schema definitions, and may apply request-category filtering.
- `src/core/agent/LoopIterationProcessor.ts:137-158` obtains active tools and builds provider-native schemas; the schemas are sent through `streamText()` at approximately line 179. Prompt-based tool calling also builds its instructions from the filtered schemas in `ContextBuilder.ts:598-608`.
- Consequently, the current schema payload is the full eligible toolset (or its category-filtered subset), not just the two discovery schemas.

**Implication:** The progressive-exposure policy must be applied consistently to native tool calling and prompt-based tool calling on every loop iteration.

### F5. Execution has existing authorization and safety gates that must remain authoritative

- `src/core/agent/ToolExecutor.ts` enforces batch shapes, plan approval, master write boundaries, dangerous-command approval, sensitive-file/out-of-bounds checks, and ordered barriers around mutations and stateful tools.
- `src/core/permissions.ts:1390-1437` resolves a tool from the internal registry and checks that the current agent's active toolset permits that canonical tool name before execution. Actual execution and event hooks follow only after these checks.
- `src/core/tools/index.ts:369-396` resolves registered tools and compatibility aliases.
- `src/core/tools/toolsets.ts` explicitly defines separate Master, Superagent, and specialized Subagent toolsets.

**Implication:** Discovery must never grant a capability. A tool can become model-visible only when it belongs to that agent's already-authorized tool catalog. Keep the existing execution and tier guards in place.

### F6. A runtime-context dependency needs adjustment

- `src/core/agent/ContextBuilder.ts:284-310` currently infers whether shell, write, network, and subagent capabilities are enabled by checking the schemas in `filteredToolDefs`.
- With discovery-only bootstrap schemas, those checks would incorrectly report that capabilities are disabled merely because their schemas have not been exposed yet.

**Implication:** Separate **authorized runtime capabilities** from **schemas currently exposed to the model**. The runtime notice must not confuse “not discovered yet” with “not allowed.”

### F7. Dynamic tool and context lifecycle require cache invalidation

- `src/core/agent.ts` caches active tools for five seconds.
- `src/core/tools/index.ts:468-539` reloads dynamic hooks and updates the global registry/toolsets.
- Agent modes, RMemory availability, workspace-chain state, and client mode can change which tools are eligible.

**Implication:** Selected schema state must be agent-scoped rather than stored in a global mutable set. Cache invalidation must account for toolset/tier changes and dynamic registry refreshes; the existing TTL alone is not a reliable discovery-state invalidation policy.

### F8. Existing performance estimates are not a current baseline

`docs/plans/2026-10-13-tools-optimization-plan.md` records earlier estimates of 48 Master and 68 Superagent tool entries and describes staged loading as deferred work. Those figures were recorded against an earlier repository revision, not verified as current counts for HEAD `3e97835a`.

The working tree already contained many modified and untracked files during this inspection. Capture a fresh, read-only baseline on the implementation branch; do not infer current metrics from the older plan or overwrite existing work.

## 3. Recommended Design

### 3.1 Bootstrap with two discovery schemas

For Single Mode and the Multi Mode Master/Superagent agents, expose only:

- `list_tools` — existing compatibility alias: `get_tools`
- `describe_tool` — existing compatibility alias: `describe_tools`

The initial schemas should be concise. Do not send the descriptions or parameter schemas of ordinary tools until selected by discovery.

This rule applies to **model-visible schemas**, not the runtime registry, authorization catalog, or internal module imports.

### 3.2 Description should activate a schema for the next iteration

Make discovery agent-scoped:

- `list_tools` searches only the agent's authorized catalog and returns concise matching names/descriptions. Listing alone does not expose complete schemas.
- `describe_tool` accepts one or more names; it returns complete schemas only for tools present in that agent's authorized catalog.
- A successful describe request records those permitted tool names in that agent's discovered-schema set.
- On the next model iteration, provide the two bootstrap schemas plus the full schemas for the selected tools. Keep discovered schemas available for the same task and its continuations.
- Clear task-scoped discoveries when an independent top-level task starts; invalidate or revalidate them when tier, client-mode eligibility, or registered tool definitions change.
- If an unrecognized or unauthorized name is requested, return a clear unavailable result and do not add it to the discovered-schema set.

Because the loop rebuilds its schemas each iteration, this approach can retain normal provider-native function calling. It should not require a generic `execute_tool` proxy.

### 3.3 Keep catalog visibility separate from schema visibility

Use three distinct concepts:

1. **Authorized catalog:** all tools this agent is allowed to use, sourced from its existing tier/client-mode filtered toolset.
2. **Discovered schemas:** the subset requested through `describe_tool` and currently retained for the task.
3. **Model-visible schema list:** bootstrap discovery tools plus discovered schemas, with no unauthorized entries.

Do not use global `allTools` as the discovery catalog for a restricted agent. The existing standalone discovery definitions currently read from the global registry when unwrapped; make sure the new behavior uses the agent-scoped authorized catalog in both server and CLI paths.

### 3.4 Reuse the current execution pipeline

Do not execute described tools from inside `describe_tool`, and do not route arbitrary tool names through a new generic dispatcher. The model should call a discovered tool by its normal canonical name in a subsequent iteration.

Retain existing tier allowlists, `ToolExecutor` validation, permission checks, file-batch constraints, dangerous-command gates, hooks, cancellation, logs, and current ordered/concurrent scheduling behavior. Schema discovery is not authorization and must not change side-effect policies.

### 3.5 Correct capability reporting

Refactor the runtime notice so that “Shell / Write / Network / Subagents” is derived from authorized runtime capabilities, not merely from the schemas exposed to the current model call. Where useful, distinguish:

- capability permitted for this agent,
- schema not yet discovered,
- capability not permitted in this mode/tier.

This avoids telling the model to switch modes or claiming an operation is disabled when its schema is simply not exposed yet.

### 3.6 Support native and prompt-based tool calling equally

Apply the same model-visible schema list to:

- provider-native tool definitions in `LoopIterationProcessor`,
- prompt-based tool instructions built by `ContextBuilder`,
- payload-size and token estimates used by context compaction.

A successful discovery in one turn must cause the selected schemas to be present on the next applicable model request regardless of calling strategy.

## 4. Implementation Phases

### Phase 0 — Baseline and constraints

- [x] Recorded repository HEAD (`3e97835a`) and inspected the pre-existing dirty working tree; no unrelated changes were reverted.
- [x] Captured a directional serialized-schema baseline using the existing TokenTracker with `cl100k_base`: Master declared toolset 48 entries / 7,298 estimated schema tokens; Superagent declared toolset 67 entries / 14,631 estimated schema tokens. The two discovery schemas total 1,156 serialized bytes / 262 estimated tokens.
- [ ] Representative end-to-end task latency, provider-billed token usage, and tool-selection success have not been benchmarked.
- [x] Traced execution context: discovery wrappers are stored per Agent, while `getActiveTools()` still returns the full authorized catalog and existing execution permission checks remain authoritative.

### Phase 1 — Agent-scoped discovery state and authorization catalog

- [x] Added `src/core/tools/toolDiscoveryState.ts` with per-Agent discovery state, catalog fingerprinting, reset, scoped listing/describing, and schema projection.
- [x] Integrated with `Agent.getActiveTools()` and model-visible schema selection; tool implementations and the complete execution catalog remain intact.
- [x] Discovery wrappers use each Agent's already-filtered authorized catalog across server and non-server paths.
- [x] Preserved tier, client eligibility, RMemory, and workspace-chain filters. Describing a name outside the current catalog does not activate it.
- [x] Discovery resets for recognized independent top-level tasks, mode switches, catalog fingerprint changes, and Agent disposal. Dynamic catalog changes are detected on the next active-tool/schema projection.

### Phase 2 — Progressive schema exposure

- [x] Master, Single, and Superagent worker tiers expose only `list_tools` and `describe_tool` before discovery.
- [x] Successful descriptions activate only successfully resolved, authorized names for the next model request; previously discovered schemas remain visible while the catalog is unchanged.
- [x] Reused existing multi-name descriptions and fuzzy discovery logic.
- [x] Preserved resolver aliases without registering duplicate model-visible schema names.
- [x] System guidance explicitly instructs the model to call canonical advertised schema names; unknown/unavailable names do not activate schemas.

### Phase 3 — Prompt, runtime capability notice, and cache lifecycle

- [x] Added tool-discovery instructions to the system prompt, including canonical names and no-repeat guidance.
- [x] Runtime shell/write/network/subagent capability notices derive from the full authorized catalog, not currently visible schemas.
- [x] Native tool definitions, prompt-based tool instructions, XML parsing, and context payload accounting now use the model-visible schema projection.
- [x] Defined lifecycle behavior for independent requests, recognized continuations, mode switches, catalog changes, memory/workspace eligibility changes, and disposal.

### Phase 4 — Regression and security validation

- [x] Unit tests cover discovery-only bootstrap projection for Master, Single, and Superagent worker tiers, while specialized Subagents retain their current configured toolsets.
- [x] Tests verify listing does not activate schemas, describing activates only requested permitted names, reset clears discovery state, and catalog changes invalidate stale schemas.
- [x] Tests verify an out-of-catalog name does not become model-visible and that the full authorized catalog remains available for runtime checks.
- [x] Regression integration tests run the actual `executeToolCall()` dispatcher: describing a tool activates its Agent-local discovery state, the schema appears in the next projection, and the matching Agent-local implementation executes in Single and Multi worker tiers; unauthorized registered tools remain blocked.
- [x] Existing tier, mode, extension-filter, alias, and registry-consistency regression suites pass.
- [x] Native and prompt-based schema-building paths use the same projected schemas in implementation; `toolDefs` for prompt/XML parsing is restricted to model-visible schemas.
- [ ] Full provider-level, multi-turn tool-calling integration tests covering authorization prompts, cancellation, and end-to-end task completion remain pending. The existing `tierToolsetResolution.test.ts` was preserved unchanged after a `sendMessage()` test timed out; separate direct tier/schema tests were added in `agentDiscoveryTierProjection.test.ts`.
- [ ] A dedicated dynamic-hook refresh integration test remains pending.

### Phase 5 — Benchmark and rollout

- [x] Captured a static serialized-schema baseline comparison. Master estimate: 7,298 to 262 schema tokens (96.4% fewer); Superagent estimate: 14,631 to 262 (98.2% fewer). These are directional schema estimates, not billed-token or task-latency measurements.
- [x] Direct Agent/tool-state tests verify two-schema bootstrap and progressive authorized schema visibility.
- [x] `bun run build` and the focused regression suite passed: 6 test files, 53 tests.
- [ ] Provider-level task success, follow-up payload, latency, and failure-rate benchmarks remain pending. A feature flag/fallback was not added; provider parity must be tested before claiming production rollout is fully verified.

## 5. Acceptance Criteria

1. Single Mode and Multi Mode bootstrap requests expose only `list_tools` and `describe_tool` as tool schemas for the targeted agent tiers.
2. The model can search the authorized catalog, request one or more exact schemas, and call those tools normally on a following iteration.
3. Describing a tool never grants permission; the agent cannot execute a tool outside its existing tier/client-mode authorization.
4. All existing plan, file, shell, privacy, approval, cancellation, audit, and subagent safeguards remain effective.
5. Server-backed sessions and the normal CLI path exhibit the same discovery semantics, subject only to their already-existing client-mode/tier differences.
6. Runtime capability notices remain truthful when schemas have not yet been discovered.
7. Schema payload and token estimates show a measurable reduction on the first request, with no unacceptable regression in tool-selection success or end-to-end task completion.
8. Existing aliases and discovery behavior remain compatible; no duplicate registry names are introduced.

## 6. Out of Scope

- Deleting, consolidating, or renaming existing tool implementations.
- Replacing all tools with one unrestricted generic execution tool.
- Changing Master/Superagent/Subagent responsibilities or granting new permissions.
- Exposing extension-dependent, workspace-chain, memory, dynamic-hook, or other restricted tools outside their current eligibility.
- Claiming performance gains before collecting the Phase 0 baseline.

## 7. Inspection and Verification Notes

- Findings and implementation were grounded in `src/core/tools/toolDiscoveryTools.ts`, new `src/core/tools/toolDiscoveryState.ts`, `src/core/tools/toolsets.ts`, `src/core/tools/index.ts`, `src/core/tools/types.ts`, `src/core/agent.ts`, `src/core/agent/ContextBuilder.ts`, `src/core/agent/LoopIterationProcessor.ts`, `src/core/agent/ToolExecutor.ts`, `src/core/permissions.ts`, `src/server.ts`, and the cited tests.
- Verification: `bun run build` passed. Focused regression run passed 6 files / 53 tests: `dynamicToolDiscovery.test.ts`, `agentDiscoveryTierProjection.test.ts`, `toolDiscoveryFuzzy.test.ts`, `toolRegistryConsistency.test.ts`, `extensionChatToolFilter.test.ts`, and `multiModeAudit.test.ts`.
- Static serialized-schema estimates: Master 48 declared tools, 33,853 bytes / 7,298 estimated tokens versus the two-schema bootstrap 1,156 bytes / 262 estimated tokens (96.4% token-estimate reduction); Superagent 67 declared tools, 66,502 bytes / 14,631 estimated tokens (98.2%). These estimates use the existing `TokenTracker`/`cl100k_base` over serialized schemas, not actual provider billing or end-to-end task measurements.
- Runtime follow-up on 14 October 2026 found that `executeToolCall()` always invoked the global registry implementation instead of the Agent-scoped active definition. That bypassed the wrapped `describe_tool`, so its per-Agent discovery state was never updated despite successful tool output. Dispatch now uses the current Agent's authorized active tool when available; focused dispatcher regressions pass for Single and Multi worker tiers.
- Re-verification after the dispatch fix: focused regression tests passed 7 files / 57 tests, including `toolDiscoveryExecutionIntegration.test.ts`. `bun run build` is currently blocked by unrelated pre-existing dirty MCP configuration/type changes that produce `McpServerConfig` union-property TypeScript errors in MCP command/manager/tool and server-route files; the compiler reported no error in `permissions.ts`.
- The full Vitest suite and provider-level end-to-end discovery/execution were not run. A `sendMessage()`-based test in the original `tierToolsetResolution.test.ts` timed out at 30 seconds during earlier verification. That file remains unchanged; provider-level integration and dynamic-hook refresh checks are still pending.
- The worktree had many pre-existing modified/untracked files at inspection time. Those changes were preserved. No broad commit was created to avoid including unrelated in-progress changes.
