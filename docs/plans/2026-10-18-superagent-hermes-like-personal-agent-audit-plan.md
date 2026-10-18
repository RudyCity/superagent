# SuperAgent as a Hermes-Like Personal Agent — Audit & Implementation Plan

**Date:** 18 October 2026
**Status:** Audit completed; implementation plan created; implementation not started
**Repository:** D:\backup from pc asus\Documents Development\superagent
**Observed HEAD:** d4923e62 — feat: support independent MCP projects and SSH
**Scope:** Build on SuperAgent's existing architecture; do not clone Hermes or rebuild existing capabilities.

## 1. Executive Summary

SuperAgent already has most of the building blocks needed for a personal autonomous agent: a terminal agent runtime, progressive tool-schema discovery, RMemory, searchable session history, skill synthesis, a self-development evidence/review pipeline, a cron daemon, messaging adapters, subagents, worktrees, MCP, SSH projects, and a desktop client.

The gap is not primarily a lack of features. The gap is that these systems are not yet proven as one coherent lifecycle:

1. Remember useful facts and decisions with reliable project/session boundaries.
2. Retrieve the right memories automatically when starting or continuing a task.
3. Convert successful task trajectories into candidate procedural skills.
4. Evaluate skills against repeatable tasks and track whether they actually improve outcomes.
5. Promote or update skills only after validation and an appropriate approval policy.
6. Continue scheduled/background work safely across failures and restarts.
7. Coordinate subagents and multiple projects without losing execution scope.
8. Present consistent memory, task status, permissions, and delivery across CLI, t-line, Telegram/other gateway channels, and MCP.

The recommended sequence is **safety and memory correctness → coherent memory lifecycle → evaluated skill learning → durable automation → multi-agent reliability → channel parity → end-to-end evaluations**. Do not begin by adding many new tools or copying Hermes command names.

## 2. Audit Method and Current Verification

### 2.1 What was inspected

- Repository identity, current branch, recent commits, and working-tree state.
- Existing plans for Dynamic Tool Discovery, Selfdev, multi-process execution, and MCP provider hardening.
- Agent runtime and context/tool-schema path: src/core/agent.ts, src/core/agent/ContextBuilder.ts, src/core/agent/LoopIterationProcessor.ts, src/core/agent/ToolExecutor.ts, and src/core/tools/toolDiscoveryState.ts.
- RMemory implementation and tools: src/core/rmemoryUtil.ts and src/core/tools/rmemoryTools.ts.
- Skill synthesis and usage statistics: src/core/skills/skillSynthesizer.ts, src/core/skills/skillTracker.ts, and the corresponding tests.
- Selfdev evidence, distillation, review, and injection: src/core/selfdev/eventStore.ts, distiller.ts, reviewService.ts, injector.ts, feedback.ts, and maintenance.ts.
- Daemon scheduling and channel gateway: src/core/daemon/daemonScheduler.ts, src/core/daemon/daemonTypes.ts, and src/core/gateway/gatewayManager.ts.
- MCP project/provider roadmap, the existing project registry/router/access-policy and standalone SSH provider, plus the dynamic discovery roadmap.
- Targeted regression tests for the areas most relevant to the proposed design.

The MCP server development skill (mcp-builder) was activated before planning. Its guidance to audit the current server, keep schemas discoverable, use actionable error responses, preserve security boundaries, and validate realistic tool-use workflows is reflected below.

### 2.2 Verification performed during this audit

- TypeScript build: **bun run build — passed**.
- Focused test batch A: **5 test files, 17 tests passed**:
  - tests/dynamicHookDiscoveryRefresh.test.ts
  - tests/toolDiscoveryProviderFlow.test.ts
  - tests/skillSynthesizer.test.ts
  - tests/daemonScheduler.test.ts
  - tests/rmemoryUtil.test.ts
- Focused test batch B: **5 test files, 61 tests passed**:
  - tests/rmemoryTools.test.ts
  - tests/agentDiscoveryTierProjection.test.ts
  - tests/toolDiscoveryExecutionIntegration.test.ts
  - tests/selfdevAgentLifecycle.integration.test.ts
  - tests/selfdevAndGatewaySuite.test.ts

These results show those targeted checks pass on the current working tree; they do **not** establish full-suite or production-level parity. The complete Vitest suite was not run during this audit.

### 2.3 Working-tree preservation

The repository has pre-existing local modifications and untracked files, including the dynamic-hook registry-version/cache-invalidation work, provider-flow and refresh tests, a benchmark script, and two MCP provider/hardening plan documents. This audit did not reset, stage, commit, or overwrite those changes. The new plan is intentionally a separate file.

The existing Dynamic Tool Discovery plan still documents provider-level parity and broader lifecycle benchmarks as pending. The newly present focused tests passing are useful new evidence, but should not be treated as completing all pending items without reconciling the plan against current HEAD and test coverage.

## 3. Current-State Audit

### 3.1 Foundations that already exist — reuse them

| Capability | Existing implementation | Audit conclusion |
|---|---|---|
| Agent runtime and context construction | src/core/agent.ts and src/core/agent/* | Reuse the current loop; do not replace the agent runtime to imitate another project. |
| Progressive tool discovery | src/core/tools/toolDiscoveryState.ts, toolDiscoveryTools.ts, ContextBuilder and LoopIterationProcessor | Implemented for the core path. The current worktree adds registry-version invalidation and provider-level regression coverage; broader provider/mode/cancellation parity still needs evidence. |
| Persistent memory and embeddings | src/core/rmemoryUtil.ts and src/core/tools/rmemoryTools.ts | Present, with correctness, scoping, migration, and degraded-mode issues requiring attention. |
| Session history and retrieval | src/core/historySearch.ts, agent history management, RMemory conversation search | Present. Needs consistent boundaries and better integration with task bootstrap/recall. |
| Procedural skill synthesis | src/core/skills/skillSynthesizer.ts | Present, deterministic, and structurally validated. It is not yet a measured skill-learning lifecycle. |
| Skill usage statistics | src/core/skills/skillTracker.ts | Present, but primarily counts usage/synthesis and timestamps; it does not measure whether a skill improved task outcomes. |
| Self-development evidence pipeline | src/core/selfdev/eventStore.ts, collector.ts, distiller.ts, candidateStore.ts, reviewService.ts, injector.ts and feedback.ts | A comparatively mature base already exists: workspace-scoped evidence, validation/redaction, candidate lessons, human review/audit, and bounded advisory injection. Extend rather than rebuild it. |
| Scheduled/background jobs | src/core/daemon/daemonScheduler.ts and daemon commands/routes | Persistent job definitions, cron parsing, concurrency limits, run status, and gateway notification exist. Stronger execution authorization, crash recovery, delivery, and run history are needed. |
| Messaging gateway | src/core/gateway/gatewayManager.ts and adapters | Webhook, Telegram, Discord, and Slack adapter abstractions are present. Configuration and end-to-end identity/session/permission parity need live verification. |
| Multi-agent execution | src/core/masterAgent.ts, src/core/tools/subagentTools.ts and worktree support | Existing orchestration is marked experimental in README; improve isolation, handoff contracts, cancellation, and evaluation rather than starting over. |
| MCP and multiple projects | Project registry/router/access policy, standalone SSH provider, Workspace Chain adapters and MCP transport/session registry | Independently registered local/SSH projects are an existing foundation. The current MCP provider/hardening roadmap is a dependency, not work to duplicate. |
| Desktop and remote-agent paths | t-line integration, Muse tunnel/chat tools, Chrome automation | These are useful channels/capabilities to integrate under consistent task and memory identity, not prerequisites to rewrite. |

### 3.2 Findings requiring priority attention

#### F-01 — Autonomous daemon execution currently supplies unconditional approval

**Evidence:** src/core/daemon/daemonScheduler.ts, defaultHeadlessRunner, passes an approval callback that always returns true to Agent.

**Risk:** A scheduled prompt can potentially approve actions that would otherwise require a user decision. This is too broad for a personal agent that is expected to keep working unattended. A user enabling a cron job should not implicitly authorize every destructive command, sensitive file access, network action, or cross-project operation.

**Required direction:** Introduce a per-job execution policy tied to a specific workspace/project and a limited set of capabilities. Default to least privilege. Destructive/high-impact operations must remain denied or require an explicit approval mechanism bound to the intended job, action, target, and identity. Add tests proving that a job cannot inherit an unrestricted approval callback.

#### F-02 — Project-scoped RMemory save and search use incompatible labels

**Evidence:** src/core/tools/rmemoryTools.ts. The save path writes the default project prefix as [project], while project-only search filters for [project:projectName] or [global].

**Risk:** Newly saved project memories may not match project-only retrieval as intended. Existing tests assert that [project] is written, but do not exercise a save-then-search round trip for a specific project.

**Required direction:** Replace free-form content-prefix scoping with structured metadata where practical: scope type, canonical project identity, and optionally session identity. Add backward-compatible handling for historic records and an integration regression proving project A cannot be mistaken for project B. Use stable project identity rather than basename alone where possible.

#### F-03 — RMemory model migration can remove unrelated files from the memory directory

**Evidence:** src/core/rmemoryUtil.ts, checkAndPerformDbMigration(), receives the shared global memory data directory; when model/dimension metadata changes, it removes every entry other than metadata.json.

**Risk:** The same directory is also used by persona.md and scene_blocks. A migration can therefore delete data unrelated to the vector database. Current migration tests only assert removal of stale DB files, not preservation of persona/scenario data.

**Required direction:** Migrate only known vector-index database artifacts and their model-specific metadata. Preserve persona.md, scene_blocks, and unknown user data. Prefer creating a new index and swapping it into place only after successful initialization; keep a recoverable backup and add a regression test that changes model/dimensions while asserting non-index data survives.

#### F-04 — Scenario-memory file reads need path confinement

**Evidence:** src/core/rmemoryUtil.ts, MemoryClient.readScenario(), combines the memory root and supplied relative path and then reads it; src/core/tools/rmemoryTools.ts exposes the supplied path through rmemory_read_cos. The current path handling does not prove the resolved target remains inside the intended scene_blocks directory.

**Risk:** A malformed or prompt-injected path may escape the intended scenario folder and disclose other local files to the agent.

**Required direction:** Resolve and canonicalize the target; allow only the documented relative scene_blocks paths; reject absolute paths, traversal segments, and symlink escapes; verify containment after resolving. Add traversal, encoded traversal, absolute path, and symlink regression tests. Do not rely on a UI-level or prompt-level restriction.

#### F-05 — Embedding failures can silently degrade retrieval quality

**Evidence:** src/core/rmemoryUtil.ts, OptimizedLocalTextEmbeddingProvider, catches initialization/embedding errors and can return fixed low-information vectors; RMemory initialization also caches a failed state for the current process.

**Risk:** The agent may receive misleading “successful” search results or poor retrieval instead of knowing memory is unavailable. A transient configuration/model failure can leave memory disabled for the rest of the process.

**Required direction:** Represent embedding/index readiness and failure explicitly. Do not silently persist fixed-vector substitutes as normal embeddings. Return actionable degraded-state diagnostics, provide a deliberate retry/reset lifecycle after configuration changes, and test recovery after a model/provider error.

#### F-06 — Skill synthesis has no measured promotion lifecycle

**Evidence:** src/core/skills/skillSynthesizer.ts extracts tool names, command patterns, error-recovery snippets, and assistant-message first lines; it validates basic Markdown/frontmatter structure and writes directly into the workspace .agents/skills directory. src/core/skills/skillTracker.ts records execution count and timestamps, not task success or failure.

**Risk:** A structurally valid synthesized skill is not necessarily a reliable or safe skill. A trajectory can contain unverified steps, partial work, misleading error-recovery assumptions, or instructions that should not be generalized. Immediate placement in the discoverable skill directory blurs the distinction between a draft and a proven reusable procedure.

**Required direction:** Add a lifecycle of candidate → test/evaluation → approved/activated → monitored → revised/retired. Preserve existing synthesis as a candidate generator, but do not automatically activate a new or modified skill solely because Markdown validation passed. Bind each skill version to its evidence, test cases, results, and approval/provenance record.

#### F-07 — Selfdev lessons and procedural skills are two disconnected learning systems

**Evidence:** src/core/selfdev/* supports evidence collection, deterministic candidate distillation, review/approval, feedback, backup/restore, and bounded low-trust prompt injection. Procedural skills are separately generated and tracked by src/core/skills/*.

**Risk:** The agent can capture a guideline as a lesson without establishing whether it should become a reusable workflow, or generate a skill without linking it to the evidence and outcome that justified it. The system cannot reliably answer which learned item caused an improvement or regression.

**Required direction:** Keep facts/preferences, approved lessons, and procedural skills as distinct types, but link them through source evidence and task outcomes. Reuse Selfdev's evidence validation, workspace scope, review audit, and human approval patterns when adding skill promotion; do not create a second competing review system.

#### F-08 — Persistent memory exists, but project/session isolation relies too heavily on text heuristics

**Evidence:** RMemory uses a shared local vector database; project-only memory/conversation search adds project labels to the query and post-filters retrieved text. The conversation search path also infers relevance from the project name appearing in message content.

**Risk:** Similar project names, missing tags, top-k truncation before post-filtering, or old records can cause valid memories to be missed or unrelated memories to appear. Textual mention of a project is weaker than structured ownership metadata.

**Required direction:** Add explicit scope metadata to memory records and apply filtering at retrieval/index-query time, not only after global top-k retrieval. Define documented defaults for global user preferences, project knowledge, session transcripts, and task-local working context. Add two-project/two-session isolation tests and backwards-compatible record migration.

#### F-09 — Scheduled jobs need recoverable execution records and safer restart semantics

**Evidence:** src/core/daemon/daemonScheduler.ts persists job definitions/status in a JSON file and protects against same-process overlap. Run state is stored on the job object; there is not a dedicated durable per-run ledger with attempt IDs, approval profile snapshots, resumable checkpoints, and clear handling for a job found in running state after a process crash.

**Risk:** After an abrupt shutdown, operators may not know whether an operation completed, whether to retry it, or whether repeating it is safe. Notifications and log output alone are not a sufficient run history.

**Required direction:** Add durable run records with queued/started/completed/failed/cancelled/interrupted states, attempt IDs, idempotency policy, bounded retries/backoff, deadlines, and redacted diagnostic output. Reconcile stale running states on boot and require explicit retry semantics for potentially non-idempotent jobs.

#### F-10 — The agent needs an end-to-end evaluation contract, not just unit coverage

**Evidence:** Existing subsystem tests are meaningful and the targeted tests run during this audit passed, but the existing dynamic discovery plan still calls provider-level task completion, cancellation/authorization paths, and end-to-end performance evidence pending. There is not yet one shared evaluation suite proving the full memory → plan → tools → task outcome → skill learning loop.

**Risk:** Unit tests can pass while context selection, model tool selection, permissions, and task continuation fail when joined across providers, modes, channels, and projects.

**Required direction:** Establish a reproducible scenario suite with real multi-turn model/provider flows where possible, deterministic mocks where necessary, stable fixtures, explicit capability expectations, and metrics for success/failure, latency, tool-schema payload, token use where reported, and safety violations. Mark estimates as estimates and do not infer billed-token savings from schema size alone.

## 4. Target Architecture and Design Rules

### 4.1 Memory types and data flow

Use separate, explicit types rather than one undifferentiated memory bucket:

- **User memory:** stable preferences and cross-project instructions explicitly safe to generalize.
- **Project memory:** architecture, decisions, conventions, environment facts, known bugs, and operational notes for one canonical project ID.
- **Session/episodic memory:** searchable user/agent conversations and completed-task summaries, linked to a session ID and project where applicable.
- **Procedural memory:** skills describing how to perform a repeatable task, with evidence and versioned evaluation results.
- **Working context:** current task plan, discoveries, files touched, approvals, blockers, and next step; expires or is compacted when the task finishes.

Each stored item should carry at least a stable ID, type, scope, source/evidence reference, creation/update time, optional confidence/freshness, and validation status. Never treat retrieved memories or learned text as higher-priority instructions than trusted system/developer policy. Redact secrets before persistence and provide explicit inspect/edit/delete/export paths.

### 4.2 Task bootstrap and recall

At the start of a new task:
1. Resolve the target project and current permission/capability context.
2. Load concise user-level preferences and trusted project instructions.
3. Retrieve a small, relevant set of memories using structured scope filters and a bounded token budget.
4. Inspect recent related sessions, existing plans/tasks, and known blockers when relevant.
5. Build an execution plan and keep references to which memories influenced it.

Do not inject the full memory corpus into the prompt. Recall should be relevance-filtered, scope-safe, compact, and explainable. If retrieval is unavailable, the task can continue with a visible degraded-state note rather than fabricated memory results.

### 4.3 Learning loop

Use completed task trajectories as **evidence**, not automatic truth:

1. Collect a minimal, redacted trajectory containing the request type, relevant tool/action metadata, errors and recovery, final validation results, feedback, and task completion state.
2. Distill one or more candidate facts/lessons/skills; deduplicate and retain the evidence references.
3. Validate candidate structure, secrets, path/permission assumptions, applicability, and scope.
4. Run the skill against a controlled evaluation fixture or replayable task when possible.
5. Require configured approval for new capabilities or risky actions; safe low-risk metadata updates may use an explicit policy only after evidence exists.
6. Publish a version, track actual outcomes and regressions, and allow rollback/retirement.
7. Periodically review stale/conflicting items; never auto-delete conflicting knowledge or auto-escalate permissions.

The skill lifecycle should build on Selfdev's current candidate/approved/retired pattern. Learned content remains advisory and cannot change safety policy, permissions, or approval gates.

### 4.4 Automation and execution policy

Every background job must bind to:
- a stable project/workspace target;
- an execution profile and explicit capability allowlist;
- model/provider configuration policy;
- time, token/cost, iteration, and concurrency limits where supported;
- cancellation/deadline policy;
- delivery destination and privacy policy;
- retry/idempotency behavior;
- auditable run state and output redaction.

No job may gain additional access merely because it is scheduled, started by a trusted channel, or running in Full YOLO mode elsewhere. Any approval must be explicit and bound to the intended action and context. Avoid duplicating authorization mechanisms; first map the existing Agent/ToolExecutor, MCP project grants, and approval code.

### 4.5 Multi-agent and multi-project boundaries

- Keep tool discovery agent-scoped; discovery must never grant authorization.
- Resolve project/provider context once for a call and pass typed context to providers.
- Do not use process-global current-project mutation or working-directory changes for routing.
- Unsupported provider operations must fail closed rather than falling back to the local checkout.
- Each subagent needs a task contract, target scope, permitted tools, completion criteria, cancellation path, and structured report.
- Cross-project and SSH operations need explicit grants and independent audit context.
- Keep Workspace Chain as specialized orchestration, not a substitute for independent projects.

## 5. Phased Implementation Roadmap

### Phase 0 — Safety and memory correctness blockers (P0)

**Goal:** Make autonomous work safe to exercise and stop known memory correctness/data-loss failures.

Tasks:
- [ ] Add regression tests reproducing F-01 through F-05 before changing behavior.
- [ ] Replace daemon's unconditional approval callback with a bounded, explicit per-job capability/approval policy; default-deny high-impact operations.
- [ ] Add path-confinement checks to scenario memory reads and prove absolute/traversal/symlink escape attempts fail closed.
- [ ] Limit index migration cleanup to known vector-index artifacts; preserve persona/scenario data and test failure/rollback behavior.
- [ ] Reconcile project memory write/search labels and introduce structured scope/project metadata with compatibility handling for legacy labels.
- [ ] Make embedding errors observable and recoverable; stop silently accepting constant substitute vectors as normal memory embeddings.
- [ ] Add non-destructive diagnostics for memory readiness, active model/dimensions, migration status, and degraded retrieval.
- [ ] Review daemon routes and channel invokers to ensure remote requests cannot broaden job capabilities or change the intended target silently.

Exit criteria:
- No scheduled task receives blanket approvals by default.
- Path escape tests fail closed.
- A model/dimension change preserves persona and scenario files.
- A save → project-only search round trip succeeds in the correct project and is excluded from another project.
- Embedding failure is visible and does not silently produce plausible-looking normal results.
- Existing focused tests plus new regressions pass; build passes.

### Phase 1 — Coherent scoped memory and automatic task recall (P1)

**Goal:** Make memory useful without relying on the model to guess when to call a memory tool.

Tasks:
- [ ] Define a stable memory record schema and migration strategy for user, project, session, and task-local scopes.
- [ ] Use canonical project identities, not only project basenames or arbitrary labels embedded in content.
- [ ] Enforce scope during retrieval/index filtering rather than only after global top-k search.
- [ ] Integrate compact, relevant recall into the task-bootstrap/context construction path, with a strict token budget and trusted-source precedence.
- [ ] Summarize completed task outcomes into episodic memory only when the task has a clear completion/verification boundary.
- [ ] Link task summaries to project/session IDs, test/build results, files changed, and known follow-up work; redact secrets.
- [ ] Add inspect, update, delete, export, retention, and rebuild/reindex workflows with clear scope semantics.
- [ ] Handle conflicting or stale memories by surfacing provenance/confidence and requesting review rather than silently selecting one as authoritative.

Evaluation:
- [ ] Test two projects with similar names and two concurrent sessions; assert no cross-project leakage and no scope misrouting.
- [ ] Test preference recall across projects while keeping project-specific decisions isolated.
- [ ] Measure recall precision/usefulness, prompt token overhead, retrieval latency, and graceful behavior when memory is disabled/unavailable.

Exit criteria:
- New independent tasks automatically consult relevant scoped memory without injecting the whole corpus.
- The agent can explain the source/scope of recalled items.
- Memory data can be inspected/exported/deleted without deleting unrelated index or scenario content.

### Phase 2 — Self-improving skills with evidence and evaluation (P1)

**Goal:** Upgrade existing skill synthesis from “generate a Markdown file” into a controlled, measurable learning lifecycle.

Tasks:
- [ ] Map every existing skill entry point and execution hook before modifying the workflow; retain current public commands/tools for compatibility.
- [ ] Extend trajectory metadata to capture task completion, validation/test results, failed attempts, recovery steps, user feedback, model/provider/mode, project, and skill version while redacting secrets.
- [ ] Make synthesis produce a candidate artifact separate from active/discoverable skills.
- [ ] Attach source evidence, applicability conditions, expected inputs/outputs, preconditions, risk level, and verification steps to each candidate.
- [ ] Add candidate review/validation: path and command safety, secret leakage, permission escalation, unsupported assumptions, duplicate/conflicting skills, and malformed metadata.
- [ ] Create replayable evaluation fixtures for suitable workflows; isolate test workspaces and do not blindly execute a candidate against the user's real project.
- [ ] Add versioned lifecycle states: candidate, evaluated, approved/active, failed, superseded, retired.
- [ ] Require user/operator approval for activation where a skill can write files, execute commands, access sensitive data, or change behavior beyond an explicitly configured low-risk policy.
- [ ] Track skill invocation count plus success/failure, task completion, regression rate, retries/iterations, latency/cost where available, and feedback.
- [ ] Support promote, revise, compare versions, roll back, disable, and retire.
- [ ] Connect Selfdev lessons to candidate skill proposals through evidence links, but keep factual memories, approved advisory lessons, and executable procedural skills as distinct entity types.
- [ ] Add a /refine-style review workflow that recommends changes and presents evidence; do not auto-change permissions or silently activate risky skills.

Exit criteria:
- Synthesized skills are not automatically considered proven because their Markdown passes validation.
- A candidate can be traced to source events and task outcomes.
- Activation requires passing the configured checks and approval policy.
- Usage metrics can distinguish frequency from effectiveness.
- A regression can be associated with a specific skill version and rolled back.

### Phase 3 — Reliable always-on scheduling and resumable work (P1)

**Goal:** Make background tasks trustworthy across failures, restarts, and different delivery channels.

Tasks:
- [ ] Add a durable per-run execution ledger separate from the scheduled-job definition.
- [ ] Track run IDs, attempt numbers, start/end times, execution policy snapshot, terminal state, redacted output reference, and interruption cause.
- [ ] On restart, detect stale running states and mark them interrupted/unknown; never automatically repeat a non-idempotent operation without an explicit retry policy.
- [ ] Add bounded retry/backoff, timeouts, cancellation, idempotency keys where applicable, and concurrency/resource limits.
- [ ] Validate and version job definitions before load; use atomic writes/backup on job-store replacement.
- [ ] Add one-shot and relative-time schedules in addition to existing cron expressions only if they can share the same durable job lifecycle safely.
- [ ] Allow a job to reference approved skill versions and project IDs; re-check permissions at execution time.
- [ ] Keep delivery targets explicit and test Telegram/webhook/other adapters without swallowing all notification failures silently.
- [ ] Add a read-only diagnostics command for scheduler readiness, next runs, stale jobs, last errors, and recovery decisions.

Exit criteria:
- A simulated crash does not leave ambiguous or silently auto-repeated work.
- Same-job overlap and maximum-concurrency limits remain enforced.
- Job permissions are checked on every run and cannot drift from the configured project/policy.
- Run history explains exactly what happened and what is safe to retry.

### Phase 4 — Multi-agent delegation and project-provider conformance (P1/P2)

**Goal:** Improve the existing experimental multi-agent mode and complete multi-project reliability.

Tasks:
- [ ] Complete the existing provider-hardening roadmap and reconcile Dynamic Tool Discovery's remaining end-to-end gaps; do not fork duplicate provider contracts or discovery tools.
- [ ] Build a capability matrix for global/session, local-only, local+SSH, and chain-only tools.
- [ ] Add provider conformance tests for root normalization, boundaries, supported/unsupported operations, cancellation, timeouts, cleanup, and parallel calls across projects.
- [ ] Give each delegated task a contract: objective, project/worktree, allowed tools/capabilities, expected artifacts, acceptance tests, deadline/budget, and reporting schema.
- [ ] Require structured child reports with changed files, commands/tests run, failures, unresolved risks, and evidence; do not treat a completed subagent response alone as proof of success.
- [ ] Add bounded retries/replanning, cancellation propagation, dead-child handling, and safeguards against duplicate concurrent edits to the same file.
- [ ] Preserve isolated worktrees and validate the aggregate diff after merge; rollback or stop on failed acceptance criteria.
- [ ] Measure delegation usefulness against sequential execution on representative tasks before increasing parallelism.

Exit criteria:
- Local and standalone SSH targets share typed resolved project context for supported operations.
- Unsupported operations fail closed with actionable errors.
- Child completion is accepted only after result/artifact validation.
- Provider-native and prompt-based tool discovery have equivalent multi-turn behavior for the supported providers tested.

### Phase 5 — Consistent channel and personal-agent experience (P2)

**Goal:** Make SuperAgent feel like one persistent agent across terminal, desktop, messaging, and MCP.

Tasks:
- [ ] Define canonical user, channel, session, task, and project identities; map incoming channel sessions to the correct identity without using display names as security principals.
- [ ] Ensure each channel exposes only the capabilities and project targets authorized for that channel identity.
- [ ] Keep task status, approvals, memory, and run history consistent across CLI, t-line, Telegram/Discord/Slack/webhook, and MCP where each surface supports them.
- [ ] Implement clear operations for status, pause, resume, cancel, inspect result, and approve/deny a pending action; return a durable task/run ID.
- [ ] Make background reports concise and link to full local records when available. Never send raw secrets or unrestricted logs to chat channels.
- [ ] Verify actual provider/channel configuration in the running installation; do not assume an adapter is operational just because the abstraction exists.
- [ ] Test multi-channel continuation and authorization: the same user can resume the intended task, while a different identity cannot access it.

Exit criteria:
- A task started from one supported channel can be inspected/continued from another channel where configured.
- Project/session boundaries and approval policy remain consistent across channel changes.
- Failed/disabled channel delivery is visible without losing the durable task result.

### Phase 6 — Evaluation, rollout, and operational quality (P2)

**Goal:** Prove the joined system with repeatable scenarios and staged rollout.

Tasks:
- [ ] Create a versioned evaluation suite of at least 10 stable, realistic read-oriented and low-risk development scenarios before adding destructive scenarios.
- [ ] Cover: preference recall, project-only recall, session search, plan continuation, tool discovery, tool authorization, skill candidate generation, skill evaluation/promotion, failed job recovery, and multi-project routing.
- [ ] Use deterministic fixtures/mocks for reproducibility and provider-level tests for real multi-turn behaviors; document which claims each type can and cannot prove.
- [ ] Capture task completion, incorrect-tool rate, safety/authorization violations, memory recall quality, skill effectiveness, retries, latency, token usage where reported, and schema size.
- [ ] Keep static schema-token estimates separate from billed provider usage and total task success.
- [ ] Add regression budgets and release gates for build, focused tests, security checks, wiki/docs validation, and the full suite where runtime permits.
- [ ] Roll out behind explicit configuration flags if behavior changes can surprise existing users; provide diagnostics and rollback instructions.
- [ ] Update README, skill docs, MCP docs, wiki, and plans only after each phase has been verified.

Exit criteria:
- Evaluation results are reproducible and tied to a commit/model/provider/configuration.
- No known critical authorization or cross-project leakage regression is accepted.
- Every promoted skill has evidence and a measurable verification result.
- Existing CLI, t-line, MCP, and gateway flows retain documented backward compatibility.

## 6. Dependencies and Existing Plans

Do not recreate or overwrite these workstreams; coordinate with them:

- docs/plans/2026-10-18-superagent-mcp-provider-and-hardening-roadmap.md — current MCP verification/provider hardening roadmap.
- docs/plans/2026-10-18-mcp-provider-architecture-and-hardening-plan.md — provider architecture and hardening detail.
- docs/plans/2026-10-14-dynamic-tool-discovery-single-multi-plan.md — dynamic schema discovery; reconcile remaining evidence after the current focused tests.
- docs/plans/2026-10-14-selfdev-default-on-development-plan.md — Selfdev default-ON and evidence/review hardening.
- docs/plans/2026-10-14-selfdev-next-improvements-plan.md — existing Selfdev improvement backlog.
- docs/plans/2026-10-14-multiprocess-batch-runtime-plan.md — bounded batch/process-runtime architecture.
- docs/plans/2026-10-14-test-health-remediation-plan.md — known broader test-health work.
- docs/plans/2026-10-18-mcp-independent-projects-beyond-chain-plan.md — independent projects rather than forcing every workflow through Workspace Chains.

Before implementation begins, compare each proposed task with the current content and status of these documents. If a task is already implemented or tracked, update its existing plan or link to it instead of creating a duplicate. Preserve the current dirty worktree and keep changes scoped to the explicitly selected workstream.

## 7. Recommended Implementation Order

1. Phase 0 safety/correctness fixes and regression tests.
2. Finish the open provider-level Dynamic Tool Discovery and MCP hardening checks.
3. Phase 1 structured memory scoping, migration safety, and task-bootstrap recall.
4. Phase 2 candidate-based skill learning and outcome evaluation.
5. Phase 3 durable, least-privilege scheduled execution.
6. Phase 4 orchestration/provider conformance.
7. Phase 5 cross-channel task continuity.
8. Phase 6 end-to-end evaluation and release gates.

This ordering intentionally places memory and autonomous execution reliability before self-improvement. A system that learns quickly but recalls the wrong project, silently loses memory files, or runs scheduled destructive commands with blanket approvals is not a reliable personal agent.

## 8. Definition of Done for the Overall Initiative

- [ ] Relevant user preferences and project knowledge are recalled automatically with strict scope isolation and auditable provenance.
- [ ] Memory store/index migrations preserve unrelated user data and failures are visible/recoverable.
- [ ] Background jobs enforce per-job least-privilege capabilities and have durable, explainable run records.
- [ ] Skills are generated as candidates, validated/evaluated, versioned, approved under policy, measured against outcomes, and reversible.
- [ ] Selfdev lessons, memory, session history, and procedural skills have distinct semantics but linked evidence.
- [ ] Multi-agent delegation and local/SSH project routing have conformance and end-to-end regression coverage.
- [ ] CLI, t-line, messaging gateway, and MCP use consistent identities, task status, and authorization to the extent supported.
- [ ] Evaluation metrics demonstrate improvement without weakening tool authorization, approval gates, or project boundaries.
- [ ] Build, relevant tests, security tests, documentation checks, and the agreed release gates pass on the final commit.

## 9. Hermes Reference Material

Use official Hermes documentation as a capability reference, not as a requirement to duplicate its implementation or UX:

- Features overview (memory, context, checkpoints, scheduling, and delegation): https://hermes-agent.nousresearch.com/docs/user-guide/features/overview/
- Memory versus skills and persistent recall patterns: https://hermes-agent.nousresearch.com/docs/guides/work-with-skills/
- Skill workflows: https://hermes-agent.nousresearch.com/docs/guides/work-with-skills/
- Scheduled tasks and skill-backed cron jobs: https://hermes-agent.nousresearch.com/docs/user-guide/features/cron/
- Toolsets and integrations: https://hermes-agent.nousresearch.com/docs/user-guide/features/tools/
- CLI automation, refine/review, session continuity: https://hermes-agent.nousresearch.com/docs/reference/slash-commands/
- Hermes repository: https://github.com/hermes-agent-org/hermes

**Audit conclusion:** SuperAgent does not need a rewrite. It needs a safety-first integration roadmap that closes concrete memory and background-execution correctness gaps, then connects its existing RMemory, Selfdev, skill synthesis, daemon, multi-agent, MCP, and gateway capabilities into a tested feedback loop.

## 10. Implementation Follow-up — 2026-10-18

The audit status and observed HEAD at the top of this file are historical snapshot facts (`d4923e62`); implementation follow-up ran against `main` at `2b624517` and remains uncommitted.

- Implemented local hardening for headless daemon approval, per-job tool grants, workspace checks, scenario path confinement, safe index migration/rollback, structured project memory, project-tagged conversation history, scoped bounded auto-recall, and read-only `rmemory_status` diagnostics.
- Historical audit validation at the time of that snapshot: `bun run build` passed; 10 focused regression/integration test files passed with 72 tests.
- Implementation follow-up after that audit added init-failure/reset recovery, project-scoped HTTP/CLI/shared-memory paths, scoped inspect/export/delete, and automatic-recall provenance tags. Latest follow-up validation: `bun run build` passed; 12 focused files passed with 110 tests.
- Full Vitest suite remains unverified: the full-suite orchestration call timed out before returning a completed result. Older atomic/conversation/shared-memory records lacking unambiguous project identity remain quarantined until reviewed/re-saved or migrated.
- Remaining gates before closing Phase 0 include full-suite verification and live provider/daemon recovery checks; Phase 1 evidence/task-linked memory schema and retrieval-quality metrics remain open.
- Phases covering task outcome summaries, provenance-rich memories, skill lifecycle evaluation/promotion, durable daemon run ledger, multi-agent delegation, cross-channel continuity, and overall end-to-end evaluation remain open.
