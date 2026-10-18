# SuperAgent Hermes-Like Personal Agent — Development Plan

**Date:** 18 October 2026
**Status:** Implementation in progress — Phase 0 code gates are implemented locally and targeted regression checks pass; full-suite/live gates and later phases remain open
**Repository baseline observed:** \`d4923e62\` — \`feat: support independent MCP projects and SSH\`
**Companion audit:** \`docs/plans/2026-10-18-superagent-hermes-like-personal-agent-audit-plan.md\`

## 1. Goal

Evolve SuperAgent into a dependable personal AI agent that can remember relevant context, learn reusable workflows from verified experience, perform scheduled work safely, delegate complex tasks, and preserve task continuity across CLI, t-line, messaging gateways, and MCP.

This initiative must extend existing SuperAgent systems rather than replacing them or cloning Hermes implementation details.

## 2. Principles

1. **Audit before adding:** map the current implementation and its tests before changing a subsystem.
2. **Safety before autonomy:** background jobs and learned workflows never bypass permission, project-boundary, protected-file, or approval controls.
3. **Scope every memory and action:** bind user/project/session/task identities explicitly; do not depend on project-name text for authorization.
4. **Learn from evidence, not assumptions:** successful task completion, test results, user feedback, and provenance inform learning; Markdown validity alone is not proof.
5. **Reuse current systems:** build on RMemory, Selfdev, skill synthesis, daemon scheduler, subagents, gateway, MCP project providers, and dynamic tool discovery.
6. **Preserve compatibility:** keep public tool names and CLI behavior unless a tested migration requires a change.
7. **Prove end-to-end behavior:** subsystem unit tests are necessary but do not prove the full personal-agent workflow.
8. **Protect the current worktree:** unrelated modifications must not be reset, staged, committed, or overwritten as part of this initiative.

## 3. Scope and Non-Goals

### In scope

- Safe memory retrieval and storage across user, project, session, and task scopes.
- Automatic, bounded memory recall during task bootstrap.
- Evidence-linked candidate skills with evaluation, review, versioning, outcome metrics, and rollback.
- Least-privilege scheduled execution with durable run history and recovery behavior.
- Reliable multi-agent delegation and multi-project provider routing.
- Consistent task/session status and authorization across supported channels.
- End-to-end evaluation, diagnostics, documentation, and rollout gates.

### Out of scope for the initial implementation

- Rewriting the agent loop or replacing the existing provider framework.
- Rebuilding existing memory, Selfdev, cron, gateway, or MCP capabilities from scratch.
- Giving learned skills permission to alter security rules or approve their own actions.
- Automatically retrying unknown/non-idempotent work after a crash.
- Adding providers/channels merely to match a feature checklist without an established use case.

## 4. Phase 0 — Safety and Memory Correctness (P0)

**Objective:** Resolve critical correctness and autonomy risks before adding more independent behavior.

### Tasks

- [x] Add regression tests for daemon approval behavior, memory path traversal, model-migration data preservation, project memory isolation, and embedding failure.
- [ ] Audit existing permission/approval flows in Agent, ToolExecutor, MCP project grants, and daemon routes before introducing any new approval primitive.
- [x] Replace daemon's unconditional approval callback with a per-job read-only allowlist and explicit additional grants. Approval-required calls fail closed and ambient YOLO cannot override the daemon profile.
- [x] Bind each job to a normalized workspace, check that it exists at execution, canonicalize it before running, and re-apply the per-job tool policy.
- [x] Constrain scenario-memory reads to top-level Markdown files under `scene_blocks`; reject absolute paths, traversal, nested paths and symlink escapes after canonical path resolution.
- [x] Make embedding-index migration modify only known index artifacts. Preserve persona/scenario files and unknown user data, and stage old indexes for rollback until replacement health probes succeed.
- [x] Fix project-memory write/search scope mismatch with stable `projectId` metadata. Explicit global and identity-bearing legacy records remain readable; ambiguous legacy `[project]` records and conversation rows without project identity stay quarantined rather than being guessed.
- [x] Replace silent constant-vector embedding fallback with explicit errors, safe degraded-state diagnostics, reset logic and provider-level retry regression coverage. `tests/rmemoryRecovery.test.ts` now covers index initialization failure, degraded diagnostics, blocked access before reset, and successful write after reset.
- [x] Add the read-only `rmemory_status` diagnostic for provider/model/dimensions, index readiness, migration state, and degraded mode.

### Acceptance criteria

- [x] A scheduled job cannot obtain blanket approval solely because it runs headlessly (daemon regression tests pass).
- [x] Memory scenario path escape cases fail closed (traversal, absolute path, separator and symlink cases covered).
- [x] Index migration preserves persona/scenario files and unrelated user data (including unknown `.db` artifacts).
- [x] Structured project-memory scope and project identity/storage behavior are covered by focused memory tests; full live-provider isolation remains unverified.
- [x] Embedding failure is visible, does not silently create normal-looking search data, and recovers through the tested `resetRMemoryInstance()` path.
- [x] TypeScript build and focused regression checks pass (latest relevant batch: 23 files, 282 tests, including explicit legacy-memory migration, tool registry/tier resolution, memory isolation/schema, Agent/Selfdev lifecycle, task evidence, distiller correlation, and shell/tool regressions). Full Vitest suite remains unverified because orchestration timed out before a final aggregate result was returned.

## 5. Phase 1 — Scoped Persistent Memory and Automatic Recall (P1)

**Objective:** Make SuperAgent automatically use the right memory without requiring the model to remember to call a search tool every time.

### Tasks

- [x] Define the canonical versioned v1 memory metadata schema in `src/core/memoryRecord.ts`, including stable logical ID, memory type, global/project scope and canonical project ID, optional session/task identity, allowlisted provenance, bounded evidence references, timestamps, and validation state. The same helper is used by `rmemory_save`, `/memory add`, HTTP atomic-memory endpoints, and shared-memory RMemory sync.
- [x] Keep safe metadata serialization allowlisted; focused tests verify that credentials and raw evidence references do not leak through inspect/export output. Existing atomic upsert behavior preserves prior creation time and unknown metadata fields.
- [x] Add dry-run-first migration for legacy atomic memories with exact `[global]` or `[project:<canonical-project-id>]` prefixes. Migration writes and validates canonical v1 metadata before deleting a legacy source; conflicts and ambiguous/unmarked rows remain untouched. Actual migration is exposed by `rmemory_migrate_legacy` and requires interactive owner confirmation.
- [ ] Keep these concepts distinct: global user preferences, project knowledge, session/episodic history, task-local working state, approved advisory lessons, and procedural skills.
- [x] Enforce scope before or during retrieval for structured memories and project-tagged conversation history; keep a defense-in-depth post-filter before automatic injection.
- [x] Use canonical stable project identity; folder basenames and text mentions are not authorization boundaries.
- [x] Harden the existing task-bootstrap recall hook with project scope, global-only shared preferences, an untrusted-memory notice, and bounded persona/scenario/memory payloads (fixed caps; configurable token budgeting remains open).
- [x] Classify Agent task terminal outcomes explicitly: only a terminal iteration without error/abort, pending plan approval, or incomplete goal status returns `completed`; max-iteration, pending-plan, error and abort paths stay `incomplete`/failed/aborted. Checklist status and Selfdev terminal event follow this result; only a recorded `task_completed` can trigger auto-distillation.
- [x] Link recognized, standalone test/build command outcomes to a task using actual numeric exit codes; persist only bounded summary/metadata and attach only evidence IDs confirmed as stored to the terminal task event.
- [ ] Extend task outcome summaries with changed-file summaries, unresolved blockers, and additional verification providers while preserving project/session provenance.
- [x] Add scope-aware inspect, update/upsert, and bounded export paths for project plus global memories; expose confirmed deletion only to Master/Superagent and fail closed without interactive owner approval. Regression tests verify project isolation and metadata redaction.
- [ ] Add retention policy plus reindex/rebuild and backup/restore behavior with explicit scope semantics.
- [ ] Surface conflicting or stale memories with provenance; do not silently promote one into a higher-trust instruction.
- [ ] Make memory unavailability a controlled degraded state that does not fabricate recall or prevent unrelated work.

### Acceptance criteria

- [x] A new task automatically retrieves scoped relevant memory with bounded context overhead.
- [x] Project memories for two distinct projects remain isolated at atomic-memory and automatic-recall boundaries; add full concurrent-session end-to-end coverage later.
- [x] Explicit global atomic preferences remain available without exposing another project's scoped memories.
- [x] Recalled items expose bounded scope/version/validation/source tags. Stable metadata schema and safe provenance labels are available; retrieval-quality metrics and a broader evidence-aware recall ranking remain open.
- [ ] Retrieval quality, latency, and prompt-token overhead are measured against a repeatable fixture.

## 6. Phase 2 — Evidence-Based Self-Improving Skills (P1)

**Objective:** Evolve the existing skill synthesizer into a controlled learning lifecycle that can demonstrate workflow improvement.

### Tasks

- [ ] Map all current skill discovery, synthesis, activation, execution, and cache-refresh entry points before altering behavior.
- [x] Carry task IDs and terminal status through Selfdev events, record recognized test/build results only from actual process exit codes, and link only persisted evidence IDs to the terminal event. Raw command text and stdout/stderr are not stored in these evidence events.
- [ ] Extend task trajectory metadata with error/recovery summaries, model/provider/mode, skill version, project-specific applicability, and user feedback while redacting secrets and sensitive arguments.
- [ ] Change synthesis to create a versioned candidate artifact rather than immediately treating every generated \`SKILL.md\` as active and proven.
- [ ] Attach evidence IDs, applicability conditions, preconditions, expected outputs, verification steps, risk classification, and known limitations.
- [ ] Validate candidate content for secrets, unsafe commands, permission escalation, path assumptions, malformed metadata, unsupported generalization, and duplicate/conflicting workflows.
- [ ] Create replayable evaluation fixtures in isolated temporary workspaces; do not blindly run generated instructions against a user's live repository.
- [ ] Define lifecycle states such as candidate, evaluated, active/approved, failed, superseded, and retired.
- [ ] Reuse Selfdev evidence/provenance and review/audit concepts where possible instead of creating a duplicate approval system.
- [ ] Require approval for activation when a skill can modify files, execute commands, access sensitive data, or exceed an explicitly configured low-risk policy.
- [ ] Track invocations separately from effectiveness: task success/failure, validation results, retries/iterations, regressions, latency/cost where available, and user feedback.
- [ ] Add promote, revise, compare versions, rollback, disable, and retire operations.
- [ ] Keep user memories, advisory Selfdev lessons, and executable skills as different entities connected by evidence links.
- [ ] Add a review/refinement workflow that proposes changes with evidence and evaluation results; it must not change permission policy or self-approve risky skills.

### Acceptance criteria

- [ ] A synthesized skill is not marked proven merely because its Markdown validates.
- [ ] Every active skill version is traceable to evidence, evaluation results, and its approval/policy decision.
- [ ] A failed or regressed skill can be disabled or rolled back without deleting its audit history.
- [ ] Metrics distinguish usage frequency from measured outcomes.
- [ ] Learning cannot elevate permissions, bypass approvals, or promote untrusted content to privileged instructions.

## 7. Phase 3 — Durable Always-On Execution (P1)

**Objective:** Make scheduled and background work explainable, bounded, and safe through failure/restart.

### Tasks

- [ ] Add a durable per-run ledger separate from scheduled-job definitions.
- [ ] Store run ID, job ID, attempt number, timestamps, state, project binding, execution-policy snapshot, redacted output/reference, and interruption/failure reason.
- [ ] Reconcile stale \`running\` records during startup as interrupted/unknown; require explicit retry policy before repeating non-idempotent work.
- [ ] Add bounded retries/backoff, deadlines, cancellation, idempotency behavior where possible, and resource/concurrency limits.
- [ ] Validate loaded job definitions and use atomic persistence/recovery for job configuration.
- [ ] Re-check project grants, allowed capabilities, and target identity at each scheduled run.
- [ ] Allow jobs to refer to approved skill versions rather than implicitly using whatever skill version happens to be active later.
- [ ] Make notification destinations explicit and record delivery errors without losing the underlying task result.
- [ ] Add read-only scheduler diagnostics for readiness, next runs, stale runs, failures, limits, and recovery decisions.

### Acceptance criteria

- [ ] Same-job and global concurrency limits remain enforced.
- [ ] Crash/restart tests produce a clear terminal/interrupted status and never silently repeat a risky action.
- [ ] Each run records which permissions/policy and project it used.
- [ ] Failed notification delivery is visible and does not erase the durable run outcome.
- [ ] Run status/results can be queried by a stable run ID.

## 8. Phase 4 — Multi-Agent and Multi-Project Reliability (P1/P2)

**Objective:** Make delegation and project routing reliable enough for autonomous development tasks.

### Tasks

- [ ] Complete and reconcile the current MCP provider/hardening roadmap and Dynamic Tool Discovery's pending provider-level tests. Do not create duplicate provider contracts or discovery APIs.
- [ ] Maintain a tool capability matrix for global/session, local-only, local+SSH, and Workspace Chain-only operations.
- [ ] Add provider conformance tests for root normalization, read/write boundaries, unsupported operations, timeouts, cancellation, cleanup, and concurrent calls across projects.
- [ ] Resolve project/provider identity once per tool call and pass typed context into the provider; avoid global active-project or process working-directory mutation.
- [ ] Ensure unsupported SSH/provider operations fail closed and never fall back to the local checkout.
- [ ] Define a child-task contract: objective, target project/worktree, authorized capabilities, expected artifacts, acceptance tests, budget/deadline, and report schema.
- [ ] Require structured subagent reports covering changed files, checks run, failures, unresolved risks, and evidence.
- [ ] Improve cancellation propagation, dead-child handling, bounded retries/replanning, write-conflict handling, and merge validation.
- [ ] Preserve isolated worktrees and validate the aggregate diff before accepting a merged result.
- [ ] Measure representative delegated tasks against sequential execution before increasing default parallelism.

### Acceptance criteria

- [ ] Local and standalone SSH operations use consistent, explicit resolved project context.
- [ ] No unsupported operation silently executes on another target.
- [ ] A child result is accepted only when its artifacts and acceptance checks validate.
- [ ] Dynamic schema discovery retains the authorization model and passes supported provider/mode/cancellation tests.

## 9. Phase 5 — Consistent Personal-Agent Experience Across Channels (P2)

**Objective:** Present one agent identity and durable task state across the interfaces SuperAgent already supports.

### Tasks

- [ ] Define canonical user/channel/session/task/project identities. Never treat a display name or message text as a security principal.
- [ ] Map incoming channel sessions to the correct authenticated identity and authorized target project.
- [ ] Reuse the same task status, memory scope, permission and approval policy across CLI, t-line, supported messaging adapters, and MCP.
- [ ] Provide status, pause, resume, cancel, inspect-result, and approve/deny-pending-action operations where supported; return a durable task/run ID.
- [ ] Redact output before sending it through messaging channels; keep full sensitive logs in local, permission-checked records.
- [ ] Validate actual channel configuration and health; do not equate an implemented adapter with a configured/operational integration.
- [ ] Test continuing a task from another supported channel while preventing another identity from inspecting or controlling it.

### Acceptance criteria

- [ ] Supported channels can inspect the same authorized durable task state.
- [ ] Channel switching does not change project boundaries, permissions, or approval requirements.
- [ ] A disabled or failed channel does not lose the underlying task record or result.

## 10. Phase 6 — End-to-End Evaluation and Rollout (P2)

**Objective:** Prove the combined system using repeatable scenarios and clear release gates.

### Tasks

- [ ] Create a versioned suite with at least 10 stable scenarios covering preference recall, project-only memory, session recall, continuation, dynamic discovery, permission denial, candidate-skill generation, skill evaluation/promotion, interrupted scheduled runs, and multi-project routing.
- [ ] Use deterministic fixtures for reproducibility and real provider-level multi-turn tests to prove behaviors mocks cannot establish.
- [ ] Record task completion, tool-selection errors, authorization violations, memory recall quality, skill effectiveness, retries, latency, provider-reported token use where available, and schema size.
- [ ] Do not present static schema-token estimates as billed-token savings or as proof of task success.
- [ ] Define gates for build, focused regression suites, security tests, documentation/wiki validation, and full-suite runs when practical.
- [ ] Roll out behavior changes behind explicit configuration flags when compatibility or unattended behavior may change.
- [ ] Document diagnosis, migration, recovery, rollback, and opt-out procedures.
- [ ] Update README, MCP docs, skill docs, and wiki only after the relevant phase is verified.

### Acceptance criteria

- [ ] Evaluation results record commit, provider/model, configuration, test fixtures, and limitations.
- [ ] No known critical authorization or cross-project isolation regression is accepted.
- [ ] Skill and memory improvements are measured through outcomes, not just activity counts.
- [ ] Existing CLI/t-line/MCP/gateway interfaces remain compatible or have documented migration.
- [ ] Release gates pass on the final implementation commit.

## 11. Dependencies and Coordination

Coordinate with these existing plans; update or link them rather than duplicating their scope:

- \`docs/plans/2026-10-18-superagent-hermes-like-personal-agent-audit-plan.md\` — audit findings and evidence.
- \`docs/plans/2026-10-18-superagent-mcp-provider-and-hardening-roadmap.md\` — current MCP provider hardening sequence.
- \`docs/plans/2026-10-18-mcp-provider-architecture-and-hardening-plan.md\` — provider architecture details.
- \`docs/plans/2026-10-14-dynamic-tool-discovery-single-multi-plan.md\` — schema discovery and pending end-to-end proof.
- \`docs/plans/2026-10-14-selfdev-default-on-development-plan.md\` and \`docs/plans/2026-10-14-selfdev-next-improvements-plan.md\` — Selfdev evidence and review lifecycle.
- \`docs/plans/2026-10-14-multiprocess-batch-runtime-plan.md\` — bounded process/batch runtime.
- \`docs/plans/2026-10-14-test-health-remediation-plan.md\` — broader repository test health.
- \`docs/plans/2026-10-18-mcp-independent-projects-beyond-chain-plan.md\` — independent local/SSH projects.

The root \`implementation_plan.md\` and \`task.md\` were observed to be used by a separate Muse MCP/chat workstream. Do not overwrite them for this initiative; use this dedicated plan as the source of truth unless a deliberate task switch is made.

## 12. Overall Definition of Done

- [ ] Relevant user and project memories are recalled automatically with strict scope isolation and provenance.
- [ ] Memory failure/migration is visible, recoverable, and preserves unrelated user data.
- [ ] Scheduled work uses least privilege and has durable, explainable run records.
- [ ] Skills are versioned candidates, evaluated against evidence, reviewed under policy, measured, and reversible.
- [ ] Selfdev, session memory, user/project memory, and procedural skills have clear semantics linked by evidence.
- [ ] Delegation and multi-project/SSH routing have conformance and end-to-end regression coverage.
- [ ] Supported channels share authorized task/session state without leaking project data.
- [ ] End-to-end metrics show improvement without weakening permission/approval boundaries.
- [ ] Build, relevant tests, security checks, docs validation, and agreed release gates pass.

## 13. Reference

Official Hermes material is a capability reference, not a requirement to copy its architecture:

- https://github.com/hermes-agent-org/hermes
- https://hermes-agent.nousresearch.com/docs/user-guide/features/overview/
- https://hermes-agent.nousresearch.com/docs/user-guide/features/cron/
- https://hermes-agent.nousresearch.com/docs/user-guide/features/tools/
- https://hermes-agent.nousresearch.com/docs/guides/work-with-skills/
