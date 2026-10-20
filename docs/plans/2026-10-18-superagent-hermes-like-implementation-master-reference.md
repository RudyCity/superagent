# SuperAgent Hermes-Like Personal Agent — Canonical Implementation Reference

- **Created:** 2026-10-18
- **Status:** Phase 0 safety gates and bounded Phase 1 memory quality/review implementation completed locally; full local test inventory passes in batches; live-provider evaluation remains follow-up
- **Repository:** D:/backup from pc asus/Documents Development/superagent
- **Audit baseline branch / HEAD:** main / 2b624517 (feat: harden MCP project providers and discovery)
- **Latest implementation baseline:** main / d12e3c12 (feat: harden memory lifecycle and MCP access)
- **Next Phase 1 plan:** docs/plans/2026-10-18-superagent-hermes-like-phase-1-memory-quality-and-review-plan.md
- **Companion evidence:** docs/plans/2026-10-18-superagent-hermes-like-personal-agent-audit-plan.md
- **Detailed phase checklist:** docs/plans/2026-10-18-superagent-hermes-like-personal-agent-development-plan.md

> **Purpose:** This is the single implementation reference for evolving SuperAgent into a dependable Hermes-like personal AI agent. It consolidates the audited gaps, defines the implementation order and acceptance gates, and clarifies which existing systems must be extended rather than rebuilt.

---

## 1. Executive Decision

Do **not** rewrite SuperAgent from scratch and do not clone Hermes internals. Keep the existing agent runtime, provider framework, dynamic tool discovery, RMemory, Selfdev, skill synthesis, daemon, gateway, multi-agent orchestration, MCP, project providers, SSH, and t-line integrations.

The primary engineering goal is to make these existing capabilities operate as **one safe, scope-aware, evidence-driven task lifecycle**:

1. Resolve the user's task, target project, session identity, and permitted capabilities.
2. Recall only relevant, trusted, correctly scoped context.
3. Plan and execute through the existing permission-aware agent/tool paths.
4. Verify the resulting changes or outcome and preserve a durable task record.
5. Distill verified experience into candidate memories, lessons, or skills.
6. Evaluate and review candidates before promotion.
7. Continue scheduled and background work with explicit authority, recoverable run state, and reliable delivery.
8. Provide consistent status and policy across CLI, t-line, supported messaging channels, and MCP.

**Implementation order:** safety and memory correctness → scoped memory/task bootstrap → evidence-based skill learning → durable automation → reliable multi-agent/project coordination → channel parity → end-to-end evaluation and release.

No later phase may bypass an unresolved safety gate from an earlier phase.

## 2. Baseline and Audit Evidence

### 2.1 Repository baseline

The current checkout was rechecked on 2026-10-18:

- Branch: `main`
- HEAD: `2b624517`, `feat: harden MCP project providers and discovery`
- Branch tracking: `main...origin/main`
- Registered feature worktrees: none
- Working tree: three untracked planning documents are present; do not overwrite, reset, stage, or commit them as a side effect of unrelated work.

The three observed untracked documents are:

- `docs/plans/2026-10-18-mcp-provider-architecture-and-hardening-plan.md`
- `docs/plans/2026-10-18-superagent-hermes-like-personal-agent-audit-plan.md`
- `docs/plans/2026-10-18-superagent-hermes-like-personal-agent-development-plan.md`

The two existing Hermes documents record baseline `d4923e62`; that is historical audit context, not the latest implementation baseline. This document uses the later observed HEAD above. Preserve historical evidence in the older documents; do not silently rewrite an old snapshot to suggest it was performed against a different commit.

### 2.2 Baseline verification before implementation changes

- `bun run build`: **passed** (TypeScript build exited with code 0).
- Focused regression run: **8 files, 51 tests passed**:
  - `tests/daemonScheduler.test.ts`
  - `tests/rmemoryTools.test.ts`
  - `tests/rmemoryUtil.test.ts`
  - `tests/skillSynthesizer.test.ts`
  - `tests/selfdevAgentLifecycle.integration.test.ts`
  - `tests/toolDiscoveryProviderFlow.test.ts`
  - `tests/projectProvider.test.ts`
  - `tests/mcpIndependentProjects.test.ts`
- A full `bun x vitest run` was attempted, but the tool invocation timed out before a final result was captured. **The full suite is not currently verified by this recheck.** Do not report it as passing or failing.
- The existing MCP hardening roadmap records earlier test runs and outstanding live-provider/SSH/cancellation gates. Treat those as historical evidence until rerun against the current HEAD.

### 2.3 Existing foundations to reuse

| Capability | Primary implementation areas | Direction |
|---|---|---|
| Agent runtime, context, execution loop | `src/core/agent.ts`, `src/core/agent/*` | Extend; no wholesale loop replacement |
| Progressive/dynamic tool discovery | `src/core/tools/toolDiscoveryState.ts`, `toolDiscoveryTools.ts`, `toolRegistryVersion.ts`, agent context/loop | Keep discovery separate from authorization; finish provider/mode and live-evaluation evidence |
| Persistent memory and conversation recall | `src/core/rmemoryUtil.ts`, `src/core/tools/rmemoryTools.ts`, history search | Correct safety, scoping, migration, degraded-mode behavior and automatic recall |
| Self-development evidence/review | `src/core/selfdev/*` | Reuse its evidence validation, workspace scope, review/audit and feedback patterns |
| Skill creation and statistics | `src/core/skills/skillSynthesizer.ts`, `skillTracker.ts` | Keep synthesis as candidate generation; add evaluation, lifecycle, provenance and rollback |
| Scheduled/background execution | `src/core/daemon/*`, daemon routes/commands | Add least-privilege profiles, durable per-run ledger and recovery |
| Multi-agent orchestration | `src/core/masterAgent.ts`, `src/core/tools/subagentTools.ts`, worktree support | Improve isolation, contracts, cancellation and reports; do not rebuild |
| MCP and project routing | `src/core/mcp/*`, `src/core/project/*`, standalone SSH provider | Reuse provider abstraction; keep chain orchestration distinct from independent projects |
| Channels and remote integrations | `src/core/gateway/*`, Muse/WebSocket/Telegram, t-line | Unify identity, task state, authorization and delivery semantics |

### 2.4 Current execution status — 2026-10-18

The implementation follow-up against the historical audit baseline `2b624517` was committed and pushed to `main` as `d12e3c12` (feat: harden memory lifecycle and MCP access). The merged batch includes Hermes-like memory/task lifecycle work and MCP policy/server hardening. Build plus 23 focused test files / 282 tests passed; the complete Vitest suite and live-provider end-to-end gates remain unverified.

**Implemented and verified in commit `d12e3c12` (Phase 0 gates plus bounded Phase 1 memory lifecycle foundations; full-suite gates remain open):**

- **F-01 — daemon least privilege:** removed unconditional headless auto-approval; the daemon denies approval-gated calls, disables inherited ambient YOLO, and sets a per-job tool allowlist. `ToolExecutor` rejects non-allowlisted tools before calling the underlying executor. Job workspace paths are resolved, checked as existing directories at execution, canonicalized, and explicit extra grants can be supplied via `--allow-tools`.
- **F-02 — scenario path confinement:** scenario reads permit only top-level Markdown files directly inside `scene_blocks`; absolute paths, traversal, nested paths and symlink escapes fail closed. Reads use a file descriptor, reject non-regular files and use `O_NOFOLLOW` where supported.
- **F-03 — migration data preservation:** migrations touch only known RMemory index artifacts and keep user/persona/scenario/unknown data intact. Deferred migrations stage prior indexes and metadata until the replacement index passes embedding and insert-delete health probes; failed initialization attempts rollback.
- **F-04 — project-safe memory:** atomic memories use structured `scope`/`projectId` metadata and stable project IDs rather than project basename markers; physical memory IDs are namespaced per project to avoid collisions when semantic IDs are reused. Conversation records are project-tagged; automatic recall and conversation search default to the active project. Explicit global atomic preferences remain available. Ambiguous legacy `[project]` atomic records and conversation entries without a project identity are quarantined from project-scoped retrieval rather than guessed into a project.
- **F-05 — honest degraded mode:** embedding fallback vectors were removed; model/provider errors are surfaced, initialization status is exposed through read-only `rmemory_status`, and reset clears failed-init state and cached indexes for retry.
- **Canonical memory record metadata:** `src/core/memoryRecord.ts` now defines and validates v1 records with stable `memoryId`, memory type, scope/project identity, optional session/task IDs, provenance, bounded evidence references, timestamps, and validation status. `rmemory_save`, `/memory add`, HTTP atomic-memory endpoints, and shared-memory RMemory sync use the same builder. Inspect/export output stays allowlisted and omits arbitrary evidence references; `updateAtomic` preserves existing `createdAt` and unknown existing metadata. Exact-prefix legacy migration is now available as a dry-run-first, owner-confirmed operation; ambiguous rows remain quarantined. Review transitions and retrieval-quality measurements remain open.
- **Honest terminal task state:** `runAgentLoop()` now returns an explicit completion result. Max-iteration exits, pending plan approval, terminal tool/advisor errors, aborted tasks, and goals without `GOAL_COMPLETE` cannot be recorded as completed; checklist items remain unchecked unless completed, and Selfdev auto-distillation runs only after a `task_completed` event was successfully recorded.
- **Task-scoped verification evidence:** standalone recognized test/build commands emit a short event using their real numeric process exit code, never raw command/output. Start, evidence and terminal events share a task ID, terminal events reference only evidence IDs that were successfully stored, and failure/success distillation avoids pairing different task IDs in a long-lived session. Support for other verification providers and richer task summaries remains open.
- **Legacy atomic-memory migration:** rmemory_migrate_legacy defaults to preview, accepts only exact [global] and active-project [project:<canonical-project-id>] prefixes, confirms before writing, verifies the versioned target before deleting a legacy source, and preserves ambiguous records and content conflicts.
- **Memory lifecycle utilities:** added `rmemory_inspect` and bounded `rmemory_export` for active-project plus optional global atomic memories. Added `rmemory_delete`, restricted to Master, Superagent, and single-agent tiers and requiring interactive owner confirmation; non-interactive execution fails closed. CLI and HTTP deletes are scope-aware and require interactive/explicit confirmation. Export and inspection serialize only an allowlisted metadata subset, with project-isolation regression coverage.
- **Bounded bootstrap recall:** both task-start recall (`HistoryCompactor`) and compaction-time recall (`RMemoryStrategy`) pass the canonical project ID, filter scope before injection, include bounded scope/version/validation/provenance tags, cap memory item size and label recalled text as untrusted reference data. Conversation capture now carries the same project identity.
- **HTTP and shared-memory isolation:** `/api/memory` routes derive project identity from the active workspace, scope list/search/save/delete, require `confirm=true` for deletes, and quarantine ambiguous legacy project rows. Shared-memory upsert now keys by scope plus canonical project path so same-key findings in different projects do not overwrite each other; ambiguous legacy entries remain hidden from project-scoped reads.
- **CLI parity:** `/memory add/search/delete` uses canonical project scope, search shows safe provenance fields, and permanent deletion fails closed without interactive owner confirmation.
- **Canonical record schema:** introduced shared v1 schema/builder/validator; all four current atomic-memory write paths use it. Evidence references have bounded shapes and inspect/export omits raw evidence references and unapproved metadata fields.
- **Init-failure recovery regression:** added `tests/rmemoryRecovery.test.ts` to force an RMemory initialization failure, verify degraded diagnostics, confirm calls stay blocked until `resetRMemoryInstance()` is called, prove a subsequent write succeeds after reset, and test inspect/export/delete isolation.

**Latest verification run:**

```text
bun run build
bun x vitest run tests/memoryRecord.test.ts tests/memoryRoutes.test.ts tests/workspaceMemory.test.ts tests/RMemoryStrategy.test.ts tests/historyCompactorMemory.test.ts tests/memoryCommand.test.ts tests/rmemoryTools.test.ts tests/rmemoryRecovery.test.ts tests/rmemoryUtil.test.ts tests/daemonScheduler.test.ts tests/toolExecutorParallel.test.ts tests/mcpProjectAccessPolicy.test.ts tests/mcpServer.test.ts tests/agent.test.ts tests/selfdevAgentLifecycle.integration.test.ts tests/selfdev/distiller.test.ts tests/taskEvidence.test.ts tests/commandLogger.test.ts tests/shellToolsPortLock.test.ts tests/sshToolsFull.test.ts tests/stopAndSteer.test.ts tests/toolRegistryConsistency.test.ts tests/tierToolsetResolution.test.ts
```

- TypeScript build: **passed**.
- Focused regression/integration tests: **23 files, 282 tests passed**.
- `git diff --check`: passed after implementation and documentation reconciliation.
- Full Vitest suite: **attempted, but the orchestration call timed out before a final result was captured**. Do not describe the full suite as passing or failing.

**Latest Phase 1 continuation (2026-10-18; working tree, not yet committed):**

- Implemented type-aware RMemory freshness, conflict-aware recall, memory review/quarantine, previewable revision/history/restore, retention review, explicit owner-selected legacy mapping, and scope-aware HTTP and CLI paths. The schema remains v1 with optional validated metadata additions.
- Added persisted task-summary preview/save that verifies the terminal event and same-task evidence, redacts credentials, and persists only as candidate/unverified after owner confirmation.
- Added `memory-recall-v1` deterministic fixture and precision/recall regression tests, plus atomic same-key conflict pair marking/resolution with reviewer/time/reason metadata and rollback.
- Final local verification of the current working tree: `bun run build` passed; all 342 local test/spec files passed when run in 14 batches (**3,344 passed, 5 skipped, 0 failed**); extension JavaScript verification passed (8 files); wiki validation passed (9 files / 24 links); `git diff --check` passed after the final documentation update.
- `bun run verify:all` itself timed out before reporting an exit code, so its wrapper is not marked passed. Its component checks were completed separately. Live-provider end-to-end evaluation is still follow-up work.
- Implementation and plan updates remain uncommitted in the working tree. The existing edits to this master reference were preserved and reconciled, not reset.

## 2.5 Phase 3 Continuation — Current Local Implementation Status (2026-10-19)

The detailed execution record is docs/plans/2026-10-20-superagent-hermes-like-phase-3-memory-and-autonomous-learning.md, Section 14. Current local work extends daemon reliability through a SQLite run ledger, atomic job-file recovery, startup interruption reconciliation, deadlines/AbortSignal propagation, a bounded queue, idempotency-gated retries, and immutable skill-pin validation. Bootstrap memory recall now applies lifecycle/scope filtering, and memory-derived prompt context is redacted and character-bounded. The memory-recall-v1 benchmark now has 10 deterministic cases.

The latest local gate is a successful TypeScript build plus focused regression batches documented in the Phase 3 plan. The full Vitest suite and live-provider end-to-end checks have not been run for this continuation, and the changes remain uncommitted. Do not treat this as release completion.

Still-open Phase 3 gates include a broader execution-entry-point capability-policy audit, interactive file-lock respect, autonomous retention maintenance, an evidence-linked skill-learning bridge and revision protocol, CLI/HTTP/MCP run diagnostics, and positive pinned-skill/live-provider verification. Phase 2's independent skill replay/effectiveness/adversarial review gates also remain open.

## 3. Critical Findings at Historical Audit Baseline — Reconcile Against Current Execution Status

The findings below were captured at the historical audit baseline `2b624517`; do not read this heading as asserting every item remains unresolved today. The implementation record in Section 2.4 documents completed changes and their verification on the later `d12e3c12` baseline and current local Phase 1 working tree. Items not explicitly closed by that evidence remain follow-up gates.

### F-01 — Headless daemon auto-approves permissions (P0)

**Evidence:** `src/core/daemon/daemonScheduler.ts`, `defaultHeadlessRunner()` constructs `Agent` with an approval callback that returns `true`.

**Required change:**
- Remove blanket approval from headless execution.
- Introduce a versioned per-job execution profile bound to a specific workspace/project and identity.
- Express permitted capabilities explicitly; use least privilege and deny high-impact operations by default.
- Ensure scheduled status, gateway source, multi-agent mode, or another session's YOLO state cannot widen a job's access.
- Audit all invokers and the existing Agent/ToolExecutor/MCP authorization paths before adding a new approval primitive.
- If a trusted out-of-band approval mechanism is not available, fail closed for actions needing human approval. A model-generated confirmation is not owner approval.

**Acceptance:**
- A scheduled task cannot modify protected files, run a high-impact command, access another project or widen capabilities without a narrowly scoped policy/approval.
- Negative tests prove unauthorized operations never reach the underlying executor.
- Existing interactive and MCP permission behavior remains compatible.

### F-02 — Scenario-memory reads lack canonical path confinement (P0)

**Evidence:** `src/core/rmemoryUtil.ts`, `MemoryClient.readScenario()` joins the shared memory directory with the supplied path and reads the result without proving it remains under `scene_blocks`.

**Required change:**
- Resolve and canonicalize the intended `scene_blocks` root and candidate path.
- Accept only documented relative scenario paths; reject absolute paths, traversal, unexpected subdirectories, and symlink escapes.
- Verify containment after canonical resolution and avoid check-then-use races where feasible.
- Keep read errors actionable but do not leak contents of blocked paths.

**Acceptance:**
- Tests cover `..` traversal, absolute paths, mixed separators, encoded or normalized traversal where applicable, and symlinks pointing outside the allowed directory.
- All escape cases fail closed on supported platforms.

### F-03 — RMemory model/index migration can delete unrelated files (P0)

**Evidence:** `checkAndPerformDbMigration()` in `src/core/rmemoryUtil.ts` removes every directory entry other than `metadata.json` when migration is needed.

**Required change:**
- Limit cleanup to explicitly known vector-index artifacts and their model-specific metadata.
- Preserve `persona.md`, `scene_blocks/`, user files, and unknown entries.
- Prefer creating a new index in a staging path and swapping only after successful initialization.
- Keep backup/rollback behavior and make incomplete migration status observable.

**Acceptance:**
- Changing model name or dimensions never deletes persona/scenario/unknown files.
- Failed initialization leaves a recoverable index and does not publish misleading success metadata.

### F-04 — Project memory write/search scopes are inconsistent (P0)

**Evidence:** `src/core/tools/rmemoryTools.ts` saves the default project scope using `[project]`, while project-only search looks for `[project:<projectName>]` or `[global]`. Conversation scoping also relies on project-name text.

**Required change:**
- Define versioned, structured memory metadata: stable ID, memory type, scope, canonical project ID, optional session/task ID, provenance, timestamps, and validation state.
- Keep backward-compatible reads for legacy text-prefixed records.
- Update writes and queries together; apply scope before/during retrieval rather than relying only on global top-k followed by text filtering.
- Use stable registered project identity where available, not just a directory basename.
- Separate user-level preferences from project, session, and task memory.

**Acceptance:**
- Save → search round trips succeed in project A and do not leak to project B, including projects with identical basenames.
- Global user preferences remain available across projects without returning unrelated project-specific items.
- Legacy records have a documented, tested compatibility/migration path.

### F-05 — Embedding failure silently returns substitute vectors (P0)

**Evidence:** `OptimizedLocalTextEmbeddingProvider` in `src/core/rmemoryUtil.ts` catches failures and can return vectors filled with `0.001`; initialization failure can also disable memory for the rest of a process.

**Required change:**
- Do not persist or present constant substitute vectors as normal embeddings.
- Expose explicit ready/degraded/unavailable states with actionable diagnostics.
- Make retry/reset after configuration or model recovery deliberate and testable.
- Ensure search/write tools distinguish no-result from unavailable or failed retrieval.

**Acceptance:**
- Embedding/model failure surfaces as a clear error or degraded-state result.
- Failure does not create plausible-looking normal search results.
- A corrected provider/model can recover through a tested retry/reset path without restarting unless restart is intentionally required and documented.

### F-06 — Synthesized skills activate without outcome evaluation (P1)

**Evidence:** `synthesizeSkill()` validates Markdown and writes directly to `.agents/skills/<name>/SKILL.md`; `skillTracker.ts` primarily records counts and timestamps.

**Required change:**
- Preserve the current synthesizer as a candidate generator.
- Add lifecycle states: `candidate → evaluated → approved/active → monitored → revised/superseded/retired`.
- Store evidence references, applicability/preconditions, skill version, expected results, verification procedure, evaluation results, and approval provenance.
- Evaluate in isolated fixtures/worktrees where practical; never blindly execute synthesized steps against a user's live workspace.
- Measure outcomes separately from invocation counts and support disable/rollback while retaining audit history.
- Reuse the existing Selfdev candidate/review/audit primitives rather than creating a competing approval system.
- Learned content cannot change authorization policy, grant itself access, or approve its own risky operations.

**Acceptance:**
- A Markdown-valid skill is not automatically considered proven.
- Every active version is traceable to evidence, tests/evaluation and its approval decision.
- Failed/regressed skills can be disabled or rolled back with audit history preserved.

### F-07 — Daemon run state is not durable enough for recovery (P1)

**Evidence:** job definitions/status are persisted, but complete per-run attempt history, recovery decisions, idempotency and crash reconciliation are not yet established as one durable ledger.

**Required change:**
- Introduce a separate appendable/persisted run ledger with run/attempt IDs and states such as queued, started, completed, failed, cancelled and interrupted.
- Record start/end times, policy snapshot, target project/workspace, bounded/redacted output, error category and delivery status.
- Define deadline, concurrency, retry/backoff and idempotency policy per job.
- On boot, reconcile stale running records. Do not automatically repeat uncertain non-idempotent work.
- Make cancellation and notification failures observable.

**Acceptance:**
- A process restart leaves enough information to explain the last run and make a safe retry decision.
- Overlapping runs remain bounded and cancellation reaches the active execution path.
- Sensitive data is not written to the ledger or gateway notifications.

### F-08 — No shared end-to-end personal-agent evaluation contract (P1)

**Evidence:** meaningful subsystem tests exist, but the full memory → task planning → tool execution → verified outcome → learning lifecycle is not established by one repeatable evaluation suite. Full-suite success was not verified in this recheck.

**Required change:**
- Create deterministic fixtures and realistic multi-turn scenarios with mock and live-provider tiers clearly distinguished.
- Measure task success/failure, tool selection, permission violations, memory precision/leakage, latency, retries/iterations, and token usage where providers report it.
- Label schema-size or token savings estimates as estimates; never infer billed savings without provider-reported data.
- Include interruption, cancellation, provider failure, restart, and cross-project isolation.
- Run the documented release gate against the current HEAD.

**Acceptance:**
- CI/test commands and expected outcomes are documented and reproducible.
- Live-provider, SSH-host, and channel checks are explicitly marked unverified until actually executed.
- All P0 acceptance gates pass before autonomous rollout.

## 4. Target Architecture and Guardrails

### 4.1 Task lifecycle

The desired runtime behavior is a cohesive lifecycle layered over existing subsystems:

```text
Task received
    ↓
Resolve identity, project, session and capability policy
    ↓
Recall bounded, trusted, scope-safe context
    ↓
Plan and obtain required approvals
    ↓
Discover authorized tools → execute via guarded handlers
    ↓
Verify actual outcome and record task/run state
    ↓
Return useful result and unresolved blockers
    ↓
Distill evidence into candidate memory / lesson / skill
    ↓
Evaluate → review/approve → version and monitor
```

This is a logical lifecycle, not a mandate to create one monolithic class or replace the current agent loop. Keep boundaries explicit and reuse existing modules.

### 4.2 Memory types

Keep distinct concepts distinct:

- **User memory:** stable preferences safe to generalize across projects.
- **Project memory:** architecture, decisions, conventions, environment facts and known defects for one canonical project.
- **Session/episodic memory:** conversation/task history linked to a session and project where applicable.
- **Task working state:** current plan, changes, approvals, validation, blockers and next step; compact or expire it deliberately.
- **Advisory lesson:** reviewed guidance grounded in evidence.
- **Procedural skill:** repeatable workflow with versioned evaluation and activation state.

Retrieved memory and learned text are untrusted data, never higher-priority instructions. Redact secrets before persistence and expose supported inspect/update/delete/export/retention paths.

### 4.3 Tool and provider boundaries

- Tool discovery controls which schemas are visible; **discovery is not authorization**.
- Resolve project/provider context once per call and pass typed context to the provider.
- Never use process-global current-project mutation or `process.chdir()` as a routing mechanism.
- Unsupported provider operations must fail closed; never fall back silently to the local checkout.
- Preserve existing MCP identity, grants, capability checks, protected-file checks and audit behavior.
- Keep Workspace Chain as optional multi-node orchestration, distinct from independently registered projects.
- Treat SSH root/path checks as file-operation boundaries, not as an OS-level sandbox for arbitrary remote shell commands.
- Do not introduce duplicate tool aliases, public API breaks or new approval frameworks without an explicit compatibility/architecture review.

### 4.4 Learning and autonomy rules

- Evidence can suggest changes; it cannot authorize actions.
- Skill or memory promotion must not self-approve.
- Never let a scheduled job inherit authority from interactive YOLO mode or another project/session.
- Default to least privilege and explicit project binding.
- Do not auto-retry unknown/non-idempotent work after a crash.
- Every long-running task needs a visible status, cancellation route, bounded resource policy and recoverable result.
- Channel identity is not automatically an authorization grant; document the trust level of each invocation path.

## 5. Phased Implementation Plan

Each phase must be delivered as code/tests/docs with a recorded result. Do not mark a phase complete from implementation alone; its acceptance criteria and regression tests must pass.

### Phase 0 — Safety and memory correctness (P0, first)

**Work items**
1. Rebase the audit mentally and operationally on current HEAD; inspect current permissions and tests before editing.
2. Add regression tests reproducing F-01 through F-05 before behavior changes.
3. Implement per-job daemon capabilities/approval behavior and explicit project binding.
4. Confine scenario-memory paths to the approved directory.
5. Make RMemory model/index migration preserve non-index data and support safe rollback.
6. Correct project memory storage/retrieval and add structured scope metadata with legacy compatibility.
7. Replace constant-vector fallback with observable failure/degraded behavior and recovery.
8. Add read-only diagnostics for memory provider/model/dimensions, index readiness, migration and degraded state.
9. Audit daemon CLI/API/gateway entry points for permission widening or target changes.

**Exit gate**
- All F-01–F-05 tests pass.
- No daemon receives blanket approval by default.
- Scenario path escape tests fail closed.
- Model/dimension migration preserves all non-index files.
- Project A/B save-search isolation holds.
- Embedding failures are explicit and recoverable.
- Build and focused regression suites pass.

### Phase 1 — Scoped memory and automatic task recall (P1)

**Work items**
1. [x] Define the v1 memory record schema in `src/core/memoryRecord.ts` and route all current atomic-memory write paths through its builder; add dry-run-first migration for exact legacy scope prefixes; ambiguous records stay quarantined for manual review.
2. [x] Introduce canonical project/session/task metadata and retrieval-time scope enforcement; recognized test/build outcomes now link to task IDs. Additional evidence sources and review transitions remain open.
3. Add bounded recall at the task-bootstrap/context-building boundary after target and policy resolution.
4. Retrieve only relevant items under a configurable context/token budget; expose provenance.
5. [x] Gate terminal task state on the Agent loop outcome, prevent incomplete/failed/aborted task distillation, and link successfully persisted test/build exit-code evidence IDs to terminal events. Remaining: richer redacted summaries, change/blocker evidence, and other verification providers.
6. Add conflict/staleness handling, retention and explicit inspect/update/delete/export/reindex workflows.
7. Make memory-disabled or unavailable behavior graceful and truthful.

**Exit gate**
- New tasks automatically recall relevant user/project context without loading the full corpus.
- Similar-name projects and concurrent sessions remain isolated.
- User preferences can be recalled across projects.
- Recall provenance is inspectable.
- Recall usefulness, latency and context/token overhead have reproducible measurements.

### Phase 2 — Evidence-based skill learning (P1)

**Current implementation record:** docs/plans/2026-10-19-superagent-hermes-like-phase-2-skill-lifecycle-implementation.md captures the bounded candidate/evaluation/approval lifecycle increment. Candidate storage, persisted evidence checks, explicit CLI activation gates, version comparison/rollback/disable/retirement, and initial effectiveness counters are implemented and focused tests pass. **Phase 2 remains in progress** until sandboxed replay and broader per-version evaluation gates below are verified.

**Work items**
1. Map all discovery, injection, synthesis, activation and cache-refresh entry points.
2. Extend task evidence with verified terminal state, build/test output, errors/recovery, project/mode/provider, user feedback and redacted skill/action metadata.
3. Persist synthesized skills as candidates until evaluation/approval policy permits activation.
4. Add isolated/replayable fixtures and a versioned evaluation result.
5. Reuse Selfdev review, evidence and audit patterns.
6. Track invocation and effectiveness separately: success, failure, regression, retry count, latency/cost where available.
7. Implement approve/promote, revise, compare, rollback, disable and retire flows.
8. Prevent skills from altering permission rules, bypassing approvals or consuming untrusted prompt text as privileged instructions.

**Exit gate**
- Active skills have traceable evidence, evaluation and approval provenance.
- Failed candidate workflows do not silently activate.
- Effectiveness metrics are separate from usage counters.
- Rollback/retirement preserves history.

### Phase 3 — Durable scheduled/background execution (P1)

**Work items**
1. Define a durable per-run ledger separate from job definitions.
2. Snapshot target project and execution profile at run creation and verify them again at execution.
3. Add explicit timeout/deadline, cancellation, retry/backoff, concurrency and idempotency semantics.
4. Reconcile interrupted runs on startup without unsafe implicit retries.
5. Make delivery results and failures part of run state.
6. Redact output and credentials in storage/logging.

**Exit gate**
- Restart/recovery scenarios are tested and operationally explainable.
- Cancellation and bounded concurrency work.
- Unauthorized operations fail closed.
- Non-idempotent retries require an explicit policy.

### Phase 4 — Multi-agent and multi-project reliability (P1/P2)

**Work items**
1. Inventory current master/subagent/task/worktree contracts and preserve current tool/provider APIs.
2. Give each delegated task a target project, objective, allowed capabilities, required artifacts, completion tests, timeout/cancellation route and structured report.
3. Bind memory, logs, checklist, locks and Git changes to session + project + worktree identity.
4. Make failed, partial and cancelled agent results explicit to the parent; do not imply success from process exit alone.
5. Test parallel operation across unrelated local projects and SSH projects.
6. Verify provider-level behavior and resource limits; keep chain-specific logic separate.

**Exit gate**
- No cross-project path or memory leakage under parallel work.
- Unsupported provider capabilities fail closed.
- Parent agents can distinguish success, failure, partial completion and cancellation.
- Concurrent edits/locks and cleanup are tested.

### Phase 5 — Consistent channels and always-on operation (P2)

**Work items**
1. Define common task/session identity and status contracts for CLI, t-line, gateway, daemon and supported MCP flows.
2. Audit which channel operations are read-only, mutating, privileged or unattended.
3. Enforce per-channel identity and policy; never treat a message arriving through a channel as blanket approval.
4. Provide status/result delivery with redaction, size limits, retries and visible failure state.
5. Integrate memory bootstrap and task records without duplicating entire conversation histories across stores.

**Exit gate**
- Supported channels report consistent target, status, authorization and completion evidence.
- Remote or scheduled calls cannot broaden local/project permissions.
- Notification failure is visible without corrupting task outcome state.

### Phase 6 — Evaluation, rollout and release gate (required)

**Work items**
1. Build a repeatable end-to-end scenario set covering new task, follow-up, recall, provider/tool use, verification and candidate learning.
2. Add negative tests for permission denial, secret/path protection, cross-project access, unavailable memory, provider outage, cancellation and restart recovery.
3. Benchmark native and prompt/XML tool-discovery paths with mocked providers and separately identified live providers.
4. Run `bun run build`, focused regression suites, complete Vitest suite in a sufficiently long-lived process, plus applicable repository checks such as extension/wiki validation where relevant.
5. Capture exact commands, commit SHA, test counts, skipped tests, duration, limitations and live-environment gaps.
6. Update relevant wiki/README/docs only after behavior is implemented and verified; do not document planned behavior as shipped.

**Exit gate**
- All Phase 0 safety criteria pass.
- End-to-end cases are reproducible and meet defined success/safety thresholds.
- No known permission, data-loss or project-boundary regression remains open.
- Live-only requirements are either verified or explicitly declared release blockers / unsupported.

## 6. Implementation Workflow and Definition of Done

For each phase or independently reviewable change:

1. **Recheck:** confirm HEAD, worktree and relevant existing code/tests. Identify related pending plan work before editing.
2. **Reproduce:** add a failing regression for the behavior being fixed.
3. **Plan a bounded patch:** list exact files, behavior change, migration/compatibility needs, tests and rollback.
4. **Implement:** preserve public behavior unless a tested migration requires a change.
5. **Validate:** run focused tests first, then relevant integration suites, build and repository gates.
6. **Review:** inspect the final diff for scope leaks, secret exposure, authorization bypass, accidental destructive cleanup and unrelated changes.
7. **Record evidence:** update this reference checklist and relevant subsystem plan with commands/results, commit SHA, limitations and follow-up work.
8. **Deliver:** report changed files, behavior, tests passed/failed/not run, remaining risks and whether commit/push was performed. Do not imply commit/push unless actually done.

### Worktree and Git rules

- Use an isolated feature worktree for parallel or risky changes when practical.
- Do not reset, clean, stage, overwrite or commit unrelated user changes.
- Stage explicit file paths only.
- Do not bundle the existing untracked audit/MCP plans into commits that do not own them.
- No phase is considered shipped until tests and documentation match the actual implementation.
- Do not commit or push unless explicitly requested.

### Definition of Done for the overall initiative

- [ ] P0 autonomy/memory safety gates are implemented and tested.
- [ ] User/project/session/task memory scopes are explicit, backward compatible and isolated.
- [ ] New tasks recall bounded relevant context automatically.
- [ ] Skill learning is evidence-linked, evaluated, reviewable and rollback-capable.
- [ ] Background runs have explicit least-privilege policy and durable recovery semantics.
- [ ] Multi-agent and multiple-project execution preserve scope, cancellation and audit context.
- [ ] Supported channels expose consistent task/permission/completion semantics.
- [ ] End-to-end and negative evaluations are reproducible on a declared baseline.
- [ ] README/wiki/status descriptions are reconciled with verified behavior.
- [ ] No critical release gate is silently skipped.

## 7. Relationship to Existing Plans

This file is the **canonical initiative-level implementation reference**. It sets ordering, global guardrails and phase exit criteria; it does not replace subsystem-level implementation details.

| Document | Role / required handling |
|---|---|
| `2026-10-18-superagent-hermes-like-personal-agent-audit-plan.md` | Evidence and detailed findings. Keep as audit record; link new findings to current HEAD when revisited. |
| `2026-10-18-superagent-hermes-like-personal-agent-development-plan.md` | Detailed checklist for the overall initiative. Reconcile task status with this document before implementation. |
| `2026-10-18-superagent-hermes-like-phase-1-memory-quality-and-review-plan.md` | Next bounded Phase 1 increment: reviewable updates, conflict/freshness policy, retention, task summaries, and recall evaluation. Use as the immediate implementation plan after confirming the current test baseline. |
| `2026-10-18-superagent-mcp-provider-and-hardening-roadmap.md` | Owns MCP provider/discovery hardening gates, including live provider, cancellation and SSH evidence. Do not duplicate provider implementation here. Its baseline/status must be refreshed before claiming completion. |
| `2026-10-14-dynamic-tool-discovery-single-multi-plan.md` | Owns dynamic tool-discovery provider/mode/performance verification. Keep the discovery implementation already present; close remaining evidence gaps. |
| `2026-10-14-selfdev-default-on-development-plan.md`, `2026-10-14-selfdev-next-improvements-plan.md` | Existing Selfdev behavior and follow-up work. Reuse review/evidence concepts and reconcile overlap with the skill lifecycle. |
| `2026-10-14-multiprocess-batch-runtime-plan.md` | Owns batch process-pool and remaining Agent IPC details. Do not redesign it as part of memory work. |
| Existing MCP independent-project plans | Continue to own registry/provider/SSH/chain details. Independent projects are not the same feature as Workspace Chain. |

When a subsystem plan and this document differ, follow the newest verified source code and test evidence; then reconcile the documents explicitly. Never mark a task complete only because it appears in a roadmap or a prior status report.

## 8. Immediate Next Actions at Creation (Historical)

Execute these actions in this order before broad feature work:

1. Reconcile the two existing Hermes plan files with this canonical reference and current HEAD `2b624517`; retain their historical baseline statements as historical evidence.
2. Select **Phase 0** as the active implementation phase.
3. Add/confirm failing regressions for F-01 through F-05 without modifying unrelated existing work.
4. Fix and validate one risk area at a time, starting with daemon permission behavior and memory path/data-preservation protections.
5. Re-run focused tests and build after each bounded change; update full-suite status only after obtaining a completed result.
6. Once all Phase 0 exit criteria pass, proceed to Phase 1. Do not start skill auto-promotion or increase unattended autonomy ahead of the safety gates.

**Status at creation:** This file is a plan/reference document only. It does not claim any of the implementation work above has been completed.

## 9. Current Next Actions

1. Keep the RMemory init-failure/reset and metadata-preservation regressions in the suite; rerun them whenever memory bootstrap or upsert behavior changes.
2. Maintain the complete test gate: the current local inventory of 342 test/spec files passed in 14 batches (3,344 passed, 5 skipped, 0 failed). The combined `bun run verify:all` wrapper timed out without an exit code; individual component gates were verified separately.
3. Treat `docs/plans/2026-10-18-superagent-hermes-like-phase-1-memory-quality-and-review-plan.md` as the completed, bounded implementation record for memory quality/review. The next improvement slice should expand the deliberately small labeled retrieval fixture and perform live-provider/end-to-end evaluation.
4. Keep task summaries candidate/unverified until a separate owner review. Keep ambiguous legacy rows unchanged until the owner explicitly chooses a scope and confirms a mapping; never infer ownership from basename or content mention.
5. Phase 2's bounded lifecycle increment is recorded in docs/plans/2026-10-19-superagent-hermes-like-phase-2-skill-lifecycle-implementation.md. Next gates are sandboxed replay execution, richer task/provider/error/recovery/user-feedback evidence, per-version effectiveness/regression metrics, and adversarial safety testing; do not mark Phase 2 complete from static checks alone.
6. Phase 1 automatic recall still needs live-provider/end-to-end evaluation. The Phase 3 implementation record now includes TASK-301–318 as bounded local implementation slices: durable daemon ledger, safe scheduler, bounded retries, positive end-to-end pinned-skill scheduler test, memory governance/retention, and read-only CLI run diagnostics. The subsequent full Vitest run exited 0 (3,506 passed, 5 skipped; 364 suites passed, 1 skipped), with build and 8 extension JavaScript checks passing. After TASK-307 mutation and entry-point hardening, an additional focused 101/101 tests on 11 suites passed. The full-suite failures were repaired (OpenAI explicit-key fallback, Muse readiness registry, and outdated Muse/Telegram test expectations). Live provider-backed E2E remains unverified. The bounded TASK-307 source audit passed. Follow the acceptance audit at docs/plans/2026-10-20-superagent-hermes-phase-3-local-acceptance-audit.md for remaining live RMemory/skill revision/MCP OAuth/staging sign-offs; do not label the overall migration production-ready before those gates are demonstrated.
7. Preserve unrelated working-tree changes; perform a final diff-check, status review, and explicit acceptance before considering commit/push.

8. Phase 4 now has a bounded local first increment for delegated report outcomes and offline RMemory adapter validation: `docs/plans/2026-10-20-superagent-hermes-phase-4-delegation-outcome-implementation.md`. The change preserves explicit blocked/partial/failed/cancelled reports, flags unverified completion separately, requires passing tests plus a completed declaration for early termination, and adds isolated project-scoped learning/recall adapter checks. Full-suite local verification exited 0: 369 suites passed, 1 skipped; 3,535 tests passed, 5 skipped. Build/extension/wiki checks and a separate 58/58 focused batch passed. **Do not mark Phase 4 complete**: cross-project/SSH delegation contracts, artifact proof, resource limits, provider outage and cancellation integration are still open. Phase 3 production-only gates remain pending.

9. Phase 4 CLI Bridge cross-project boundary hardening is recorded in `docs/plans/2026-10-20-superagent-hermes-phase-4-cli-bridge-workspace-isolation.md`. Background job IDs and interactive session IDs are now workspace scoped; explicit child cwd is allowed, sibling/parent/symlink escapes and foreign artifact paths are rejected. Focused tests passed (74/74 on 5 suites), and final full Vitest exited 0 (370 suites passed, 1 skipped; 3,540 tests passed, 5 skipped). Phase 4 live SSH/OAuth/provider/parallel-lock acceptance remains open.


10. Phase 4 CLI Bridge bounded artifact evidence is documented in `docs/plans/2026-10-20-superagent-hermes-phase-4-cli-artifact-evidence.md`. `delegate.start` accepts 1–12 explicitly declared file outputs, snapshots their pre-run SHA-256, and reports `artifacts_verified` only after exit 0 plus a new/changed file for **every** claim. Unknown exit-zero work remains `unverified`; missing/unchanged/oversized claims yield `verification_failed`. Canonical per-process output claims block colliding concurrent writers. Local build/extension/wiki validation and final full Vitest passed (370 suites passed, 1 skipped; 3,548 tests passed, 5 skipped; 0 failed). A separate 97/97 focused regression passed. This is local file-change evidence, not semantic correctness; remote SSH/OAuth/staging and cross-process locks still block full Phase 4 certification.


11. Phase 4 has a bounded same-host independent-process output-claim increment: `docs/plans/2026-10-20-superagent-hermes-phase-4-cross-process-artifact-claims.md`. A per-canonical-artifact exclusive lockfile (atomic `wx`, owner token, rollback on contention) prevents cooperating SuperAgent processes from claiming the same expected output, even when their config dirs differ. Stale claims remain fail-closed on crash because child CLIs may survive their parent. This is not a multi-host broker, mandatory OS sandbox, or transactional shared job registry; operator-gated orphan recovery and distributed SSH/provider validation remain open.


12. Phase 4 lock diagnostics and the tunnel setup unit-test timeout fix: the workspace-scoped, read-only CLI Bridge action delegate.claims exposes claim health without unlocking orphaned writes or exposing owner tokens. See docs/plans/2026-10-20-superagent-hermes-phase-4-cross-process-artifact-claims.md. The tunnel installation unit suite now uses a synthetic offline subprocess instead of npm global installation. This does not satisfy live SSH/OAuth, shared multi-writer metadata or production staging acceptance.


13. Cross-process claim diagnostics and deterministic tunnel installation unit tests passed final local full regression (371 passed suites, 1 skipped; 3,554 passed tests, 5 skipped, exit 0) on 2026-10-20. Locked output status is inspectable only from its authorized workspace, but orphaned locks still require manual child-process verification before recovery. This is local acceptance, not production certification.

14. Phase 4 per-job multi-writer metadata: see `docs/plans/2026-10-20-superagent-hermes-phase-4-cli-job-shards.md`. Immutable per-job snapshots prevent shared-config `jobs.json` lost updates and avoid rewriting foreign live jobs; compacting history and post-crash orphan reconciliation remain open.
