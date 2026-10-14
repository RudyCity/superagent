# Self-Development (Selfdev) — Default-ON Development Plan

- **Date:** 2026-10-14
- **Status:** Core implementation complete 2026-10-14; full monorepo verification remains partially unconfirmed because the whole-suite run exceeds the execution limit.
- **Scope:** SuperAgent Self-Development Engine
- **Primary goal:** Make Selfdev enabled by default in new installs and after the one-time upgrade migration, while keeping learning bounded, workspace-scoped, auditable, and safe.

## Implementation Progress (2026-10-14)

### Completed and verified so far

- Default-ON configuration contract plus a one-time persisted-config migration, explicit `userOptOut`, and tested enable/disable persistence across cache reloads.
- Workspace-keyed collector cache with a bounded number of workspace entries, and a regression test that records isolated events for two workspaces in one process.
- Real SQLite-backed Agent lifecycle integration tests prove start → completed/failed/aborted ordering; two concurrent multi-agent sessions are isolated by workspace and session. Terminal timestamps are forced monotonically after start, and distillation is detached only after terminal persistence.
- Per-workspace single-flight automatic distillation, a minimum new-event threshold, sanitized runtime counters, and evidence validation during distillation and approval.
- Candidate-store preservation for candidate/active/retired lifecycle metadata, plus conservative stale-lock recovery that reclaims only a positively verified dead local process lock.
- Active-lesson validation on prompt injection, production telemetry for actual injection, explicit `selfdev feedback` controls, read-only `selfdev doctor` / `selfdev metrics`, and evidence/provenance inspection via `selfdev inspect <lesson_id>` and `/selfdev inspect <lesson_id>`.
- Conservative token-overlap hints tag near duplicates for human review; they never auto-merge, reject, or activate candidates. Evidence IDs and approval actor/time remain visible provenance.
- Filter-first injection validation preserves strict validation for only eligible active lessons in the exact workspace. A repeatable synthetic before/after benchmark is available in `scripts/bench-selfdev.ts`.
- Documentation and help are updated. No commit was created, and pre-existing unrelated working-tree changes were preserved.

### Validation results

- TypeScript build: passed after the lifecycle, near-duplicate, evidence-inspection, and injection hot-path changes.
- Latest focused Selfdev + Agent run: **16 test files, 194 tests passed**. This includes all files under `tests/selfdev`, the new six-case `tests/selfdevAgentLifecycle.integration.test.ts`, `tests/selfdevAndGatewaySuite.test.ts`, Agent/abort/workspace-cache/optimization tests, and mode-switching tests. One integration test holds the Selfdev writer open and verifies `sendMessage` resolves independently; SQLite tests poll for eventual event persistence and verify ordering.
- Broader root-suite sampling, run as alphabetical batches to keep test execution bounded: five completed batches covering 125 root test files returned **1,160 passing tests and 9 failures**. Batch 1: 23/25 files passed (201 tests passed, 4 failed) — three `tests/agentPlanContent.test.ts` assertions are affected by fallback to the existing root `implementation_plan.md`, and one `tests/askQuestionRobustness.test.ts` agent-loop test timed out at 30 seconds (also reproduced when run alone). Batch 2: 25/25 passed (243 tests). Batch 3: 23/25 files passed (337 tests passed, 5 failed) — four `tests/cliBridgeTool.test.ts` assertions received injected active-artifact instructions in session prompts, and one `tests/CompactionStrategy.test.ts` assertion saw pinnedCount 2 instead of 1. Batches 4 and 5 each passed 25 files (134 and 245 tests respectively). A further batch of 25 files (indices 125–149) exceeded the execution timeout and did not return a complete report. The following 20-file batch (indices 150–169) had 18 files pass with 145 tests passed and 2 failures in `tests/museMultiProjectWatch.test.ts` and `tests/museWebSocketTransport.test.ts` (tool calls did not report success in multi-project workspace routing). These root-suite failures are outside Selfdev changes and are retained as known repository verification issues, not silently ignored.
- Active-profile CLI smoke passed in separate CLI processes: default ON, doctor all checks OK, metrics storage available, disable persisted, and enable cleared opt-out. The current status/doctor/metrics check again reports enabled, config v1, no opt-out, all doctor checks OK, storage available, and zero events/lessons for the inspected workspace.
- Latest synthetic benchmark (Bun 1.4.2 / Windows x64): single event write p50/p95 **0.120/0.165 ms**; batch write per event **0.050/0.081 ms**. With a 500-lesson store and 5 active lessons, p95 dropped from **1.852 ms** before the filter-order optimization to **0.833 ms** after it (**55.0% faster**). The current structurally validated path is 12.7% above the reference that did not validate every lesson. The 500-candidate / zero-active path p95 is 0.829 ms.
- Full `bun x vitest run --exclude tests/multiModeAudit.test.ts` exceeded the execution tool time limit before returning. The earlier selected run of `tests/multiModeAudit.test.ts` still has an unrelated assertion mismatch: it expects an old multi-file edit error string, but current behavior reports that single-file multi-replacement is disabled in both modes.
- The active profile is migrated to enabled (config v1, no explicit opt-out). The long-running SuperAgent was not restarted to avoid interrupting the active connector session.

### Remaining limitations / explicit deferrals

- The complete monorepo suite has not produced one conclusive pass/fail result through this tool's execution limit. Relevant Selfdev/Agent suites and the build pass.
- A calibrated numeric confidence score is intentionally deferred until a curated evaluation set can validate its meaning; provenance inspection instead shows evidence coverage, source signals, workspace, and approval actor/time without pretending the score is a probability.
- No prompt-store cache was added: current p95 is below 1 ms for the reference and 0.833 ms after filter-first validation on this synthetic fixture, and caching would require robust invalidation for external edits. Optional semantic/embedding-based dedupe, cross-task pattern modeling, relevance ranking, retention/export, per-workspace learning-policy UI, reversible audit-log revisions, and broad storage fault-injection remain separate follow-up work rather than being partially exposed.

## 1. Current State

The existing implementation already contains the main Selfdev pipeline:

- At the start of this implementation, `src/core/selfdev/types.ts` and `src/core/config/selfdevConfig.ts` defaulted Selfdev to OFF. The default is now ON and persisted settings use the versioned migration described below.
- `src/core/selfdev/selfdevAgent.ts` connects agent lifecycle events to the event store, injects approved lessons into prompts, and can distill event history into candidate lessons.
- `src/core/selfdev/distiller.ts` sanitizes generated lesson text, rejects selected authority-escalation patterns, deduplicates candidate lessons, and does not activate lessons.
- `src/core/selfdev/reviewService.ts` controls the candidate → active → retired lifecycle. Approval is a separate operation.
- `src/core/commands/selfdevCliHandler.ts` exposes `status`, `doctor`, `metrics`, `enable`, `disable`, `list`, `inspect`, `review`, `distill`, `approve`, `feedback`, `reject`, and `retire`; the slash command also supports `inspect` and the same key operational controls.

The initial runtime check on 2026-10-14 showed Selfdev disabled, with zero active and candidate lessons. That observation predates the code changes. A separate CLI-process smoke test now verifies the persisted profile migrated to config version 1 with Selfdev enabled and no explicit opt-out. The long-running SuperAgent process was not restarted, to avoid interrupting the active connector session; it must be reloaded/restarted to run the newly built hooks.

## 1.1 Bottleneck and Correctness Audit

The table below records **baseline risks found before implementation began**; it is not a claim that every row remains unfixed. Current implementation status is tracked in the progress section above. Measurements are synthetic and should not be generalized beyond the recorded runtime and workload.

| Priority | Finding in current implementation | Impact | Planned treatment |
|---|---|---|---|
| P0 | `getCollector()` initializes one module-level collector with `workspace: process.cwd()`, while task hooks pass `this.workingDirectory || process.cwd()`. The event validator requires the input workspace to match the store workspace. `resetSelfDevCollector()` has no callers in `src/` or `tests/`. | Events can silently fail to record when an agent's working directory differs from the process CWD, and the collector can remain bound to the first workspace. This threatens learning correctness, not only speed. | Replace the single workspace-bound collector with safe workspace-aware lifecycle management, or explicitly pass a workspace-scoped store per operation. Test two workspaces in one process and workspace switching. |
| P0 | Task completion in `src/core/agent.ts` calls `recordSelfDevEvent(...)` without awaiting it and immediately calls `maybeAutoDistill(ws)`. | Distillation may query the event store before the completion event has persisted, producing a timing race and inconsistent evidence. | Order persistence before distillation, while keeping the overall Selfdev work non-blocking for the user-facing task. Add a deterministic regression test. |
| P1 | `maybeAutoDistill()` runs at every task completion, reads up to 50 events, reads the candidate store, scans existing lessons, and may acquire a file lock/write JSON each time. | Repeated work and file-lock contention can grow with task frequency and candidate-store size. | Add per-workspace single-flight/coalescing, a minimum new-event threshold, and/or a configurable interval. Keep manual `distill` immediate. Benchmark before choosing defaults. |
| P1 | `injector.ts` opens and parses the JSON lesson store whenever a prompt injection block is built; the accepted file-size bound is up to 16 MiB although at most five lessons are injected. | Repeated file I/O and full JSON parsing may add prompt-build latency as the store grows. | Measure prompt-build p50/p95; then consider a version-aware cache with invalidation on approve/edit/retire/store updates, safe fallback on external changes, and strict workspace scoping. |
| P1 | `eventStore.ts` uses synchronous SQLite calls; each event in a batch is inserted and read back individually, and retention pruning runs on every batch write. | CPU/event-loop blocking and avoidable database round trips may affect responsiveness when collection volume increases. | Add realistic benchmark fixtures. Consider a prepared-statement batch path, fewer read-backs, and less frequent retention pruning without weakening atomicity or retention bounds. Do not introduce async complexity without measured benefit. |
| P1 | `CandidateStore` uses a lock file that fails fast if it already exists and explicitly does not reclaim stale locks after a crash. | A crashed process can leave Selfdev candidate writes blocked until manual intervention. | Add owner metadata (PID, start time, host/process identity where meaningful) and a conservative stale-lock recovery protocol. Never steal a lock from a live owner based on age alone. Test process crashes and concurrent writers. |
| P1 | Several Selfdev integration paths catch errors and return silently; `maybeAutoDistill()` returns `0` both when nothing is eligible and when an error occurs. | It is difficult to distinguish healthy inactivity from broken persistence, lock contention, rejected events, or distillation errors. Debugging depends on reproducing the failure. | Add bounded counters and safe last-error codes/timestamps. Keep raw prompts, event bodies, secrets, and full file paths out of telemetry. Make status distinguish skipped/no work from failure. |
| P2 | `FeedbackTracker` and its schema exist, but code search found no production call sites in `src/`; current usage is test-only. | The engine cannot yet reliably measure which lessons were injected, applied, helpful, or harmful, so it cannot assess lesson value from outcomes. | Wire telemetry into injection and explicit feedback/outcome paths with idempotency, then use it for reporting and review recommendations. Do not automatically approve lessons from these scores. |
| P2 | Candidate deduplication is deterministic but based on normalized statements; it does not establish whether different wording captures the same underlying lesson. | Semantically overlapping lessons may consume the small prompt budget and dilute useful guidance. | Add conservative near-duplicate detection, starting with deterministic token/phrase similarity; keep ambiguous cases as candidates for human review. Avoid a required embedding service unless measurements justify it. |

### Bottleneck verification method

For each optimization, collect a baseline and compare after the change using the same workload:

- Task-completion overhead attributable to Selfdev: p50 and p95.
- Prompt-context construction time with Selfdev disabled, enabled with no lessons, and enabled with five active lessons.
- Event record latency for single and batch writes, with retention pruning included.
- Distillation duration, events scanned, candidate-store bytes read/written, lock wait/failure count, and candidates created.
- Event capture success/failure counts, redaction counts, duplicate suppression counts, and evidence-validation rejection counts.
- Memory growth during repeated prompt construction and repeated completion/distillation cycles.
- Behavior with two workspaces, concurrent agents, a storage error, and a stale lock.

Avoid setting arbitrary speed targets before baseline collection. First establish correctness and baseline; then define budgets from measured results. Any optimization must retain workspace isolation, atomic writes, limits, redaction, approval requirements, and non-blocking primary task execution.

## 1.2 Feature Upgrade Backlog

These are proposed product features beyond switching the default on. Deliver them in priority order, and keep the safety invariants above.

### P0 — Reliability before more autonomy

- **Workspace-aware collector lifecycle:** correctly record events for each agent workspace, including workspace switches and single/multi-agent sessions.
- **Ordered event pipeline:** ensure task completion/failure evidence is persisted before distillation consumes it; add idempotency keys or equivalent duplicate protection where necessary.
- **Distillation coordinator:** one active distillation per workspace, bounded work, cancellation/shutdown handling, retry/backoff for transient store contention, and manual-trigger priority.
- **Explicit evidence validation:** production candidate creation must validate that cited evidence exists, belongs to the same workspace, and supports the proposed lesson. Do not weaken validation when migrating old configuration.
- **Failure visibility:** report categorized failure reasons and health counters without exposing sensitive content.

### P1 — Measurable, useful learning

- **Selfdev Doctor:** add a `selfdev doctor` diagnostic command to check effective config, migration/opt-out state, SQLite access, candidate-store parsing/permissions, lock health, workspace binding, and recent sanitized errors. It must be read-only by default; any cleanup or repair requires an explicit action.
- **Learning metrics:** add `selfdev metrics` to report events captured, events rejected/redacted, distillation runs and duration, candidates proposed/approved/rejected/retired, active lesson count, and injected/applied/helped/harmed counts.
- **Evidence inspection:** add a command to inspect a candidate's supporting events and rejection reasons with secret redaction and workspace checks; avoid dumping raw secrets or unrestricted message history.
- **Lesson feedback loop:** wire the existing `FeedbackTracker` to record injection and supported explicit outcomes. Expose signals as review hints only. Do not infer that a lesson helped merely because the task succeeded.
- **Lesson confidence/provenance:** track evidence count, source types, approval actor/time, and a transparent confidence/reliability summary. Confidence must not bypass human approval.
- **Prompt budget and relevance:** rank active lessons by workspace, task relevance, proven outcome signals, recency, and approval state; preserve strict limits (currently at most five lessons and 280 characters per statement unless a new measured budget is justified).
- **Safe near-duplicate detection:** identify likely duplicates before adding candidates and explain why an item was flagged rather than silently merging unrelated lessons.
- **Retention and export:** provide documented retention/backup/export operations for events and lessons with schema versioning and secret redaction. Disabling Selfdev must not erase stored learning.

### P2 — Advanced development capabilities, gated by evidence

- **Configurable learning policy:** per-workspace controls for collection, distillation cadence, prompt injection, retention, and privacy. Global opt-out always takes precedence.
- **Reversible lesson revisions:** preserve an audit trail of revisions, approvals, rejection/retirement reasons, and allow rollback via a new candidate/re-approval rather than silently restoring stale approval.
- **Pattern learning across tasks:** detect recurring failure → verified fix and repeated user corrections across sessions, while requiring independent evidence and avoiding cross-workspace mixing.
- **Context-aware activation suggestions:** recommend lessons for particular task types or agent tiers; activation remains human-approved.
- **Selfdev evaluation suite:** curated fixtures representing common failures, successful fixes, prompt injection attacks, secret-bearing content, workspace collisions, duplicate lessons, and harmful lessons. Score precision, recall, redaction, false positives, and false negatives before changing distillation logic.
- **Optional semantic models:** only evaluate embeddings or an LLM-based grader behind an opt-in/configurable provider after deterministic pipeline benchmarks show a clear need. Enforce cost limits, data-boundary rules, timeouts, and deterministic fallback.

## 2. Desired Product Behavior

### Default-on behavior

1. Fresh installations start with Selfdev enabled.
2. Installations upgraded from the legacy configuration receive a one-time default-ON migration.
3. Event collection and approved-lesson prompt injection are enabled by default.
4. Automatic distillation may create **candidate** lessons from bounded, available event history.
5. A candidate never becomes active automatically. Only an explicit review/approval operation may activate a lesson.
6. The user can disable Selfdev using the existing `selfdev disable` command. That opt-out must persist across restarts and future config normalization.
7. Re-enabling uses `selfdev enable` and clears the explicit opt-out marker.
8. Selfdev remains best-effort: a Selfdev storage, distillation, or injection failure must not stop the primary agent task.

### Explicitly out of scope

- Automatically approving candidate lessons.
- Allowing lessons to grant new permissions, change security policy, or override system/developer instructions.
- Replacing the existing event store or lesson JSON store in this project.
- Reworking the MCP tunnel, Telegram, or other unrelated integrations.
- Claiming that Selfdev has learned a useful lesson merely because the engine is enabled.

## 3. Configuration and Upgrade Design

### 3.1 Default config

Update the default configuration so that:

- `enabled: true`
- `collectionEnabled: true`
- `injectionEnabled: true`
- `redactSecrets: true` remains mandatory and cannot be disabled
- Existing retention and batch limits remain bounded
- Invalid persisted boolean types continue to fail closed rather than being truthiness-coerced

Ensure `normalizeSelfDevConfig(undefined)` resolves to enabled, and that partial settings inherit the new defaults without mutating the frozen default object.

### 3.2 One-time legacy migration

Changing the default alone is insufficient for persisted legacy settings. Add a versioned default-on migration and an explicit opt-out marker, for example `userOptOut` plus a migration version.

Migration contract:

1. A legacy configuration without the new opt-out marker is upgraded once to the default-ON state and receives the migration marker.
2. A call to `selfdev disable` records an explicit opt-out. Future startups and config writes must keep Selfdev disabled.
3. A call to `selfdev enable` clears the opt-out and enables Selfdev.
4. The migration is idempotent and must not repeatedly flip a user setting.
5. Invalid configuration must not silently become enabled just because the default is ON.
6. Tests must cover absent settings, partial settings, old persisted `enabled: false`, new explicit opt-out, explicit enable, malformed booleans, and repeated migration.

**Compatibility note:** legacy configurations contain only `enabled: false` and do not record whether it was generated by the old default or intentionally chosen by a user. Under the requested default-ON migration, those legacy values will be treated as the old default and enabled once. Release notes and the status output must make this behavior clear; users can use `selfdev disable` to opt out under the new scheme.

### 3.3 Centralize setting transitions

Implement enable/disable semantics in a single configuration boundary rather than relying on each command to update flags independently. CLI commands, slash commands, settings writes, and migration code must agree on the effective state and opt-out marker.

## 4. Runtime Learning Pipeline

### 4.1 Event collection

- Verify all current lifecycle event hooks operate in both single-agent and multi-agent sessions.
- Confirm collection checks the effective Selfdev setting and `collectionEnabled`.
- Keep per-workspace retention, batch-size limits, event validation, and deduplication.
- Redact secrets before persistent storage; do not log raw event payloads or credentials.
- Prevent duplicate collector instances or duplicate event recording when workspaces/sessions change.
- Fail safely when the history database is unavailable.

### 4.2 Candidate distillation

- Verify automatic distillation is actually invoked at the intended lifecycle point and is not merely implemented as an unused helper.
- Keep distillation bounded to a limited recent event window and a capped number of candidates per run.
- Preserve deduplication, secret redaction, suspicious instruction/authority-escalation rejection, and workspace scoping.
- Validate that candidate evidence IDs refer to real events in the same workspace. Prefer enforcing known evidence for production Selfdev; tests should prove that missing or cross-workspace evidence cannot create an approvable lesson.
- Make retries safe: repeated distillation must not multiply identical candidates.
- Distillation failure should be observable in status/diagnostics without exposing source content or breaking the task.

### 4.3 Lesson approval and prompt injection

- Only lessons with `status: active` may enter the prompt injection block.
- Candidate and retired lessons must never be injected.
- Keep a review/approval step before activation, with version-conflict protection.
- Editing an active lesson must invalidate its prior approval and return it to candidate status.
- Filter lesson injection to the exact active workspace; never leak lessons between workspaces.
- Treat lesson text as untrusted data. It may guide workflow preferences but cannot change authority, access controls, secret handling, or system-level instructions.
- Respect `injectionEnabled` separately from collection and the master enabled switch.

### 4.4 Single and multi mode

- Use the same core lifecycle and safety invariants in single-agent and multi-agent mode.
- Confirm events include enough session/workspace context to avoid mixing unrelated runs.
- Verify that subagent activity does not create uncontrolled duplicate events or allow a subagent-created candidate to become active automatically.
- Keep behavior deterministic when a multi-agent session falls back to single-agent execution.

## 5. Status, Diagnostics, and User Controls

Update `selfdev status` and slash-command status output to report, at minimum:

- Effective enabled state
- Event collection state
- Prompt injection state
- Default-on migration version/state
- Whether Selfdev is disabled by explicit user opt-out
- Active workspace and store path
- Active, candidate, and retired lesson counts
- Safe indication of recent collection/distillation errors, where available

Do not print secrets, raw event payloads, or full sensitive task content. Status output must distinguish “engine enabled” from “has active lessons” and “last distillation succeeded.”

Keep the existing control surface working:

- `selfdev enable`
- `selfdev disable`
- `selfdev status`
- `selfdev list`
- `selfdev review`
- `selfdev distill`
- `selfdev approve`
- `selfdev reject`
- `selfdev retire`

Disabling should stop new collection, distillation, and prompt injection without deleting prior events or lessons. Deletion/retention changes are separate operations and must not be implicit in `disable`.

## 6. Implementation Phases

### Phase 1 — Configuration contract and migration

- Change defaults to ON.
- Add explicit opt-out and one-time migration state.
- Centralize enable/disable transitions.
- Ensure old and partial JSON settings normalize deterministically.
- Add tests for migration idempotency and opt-out persistence.

**Progress:** Implemented and covered by focused configuration tests. The active-profile CLI migration smoke test reports config version 1, Enabled Yes, Explicit Opt-out No; sequential CLI processes confirmed that `disable` persists and `enable` clears the opt-out.

**Exit criteria:** tests prove fresh defaults are ON, legacy configuration migrates once, and a new explicit opt-out survives restart/config writes.

### Phase 2 — Pipeline correctness

- Audit the task lifecycle hooks in `src/core/agent.ts` and their invocation paths.
- Confirm collection and automatic distillation run in the intended places.
- Confirm all paths remain non-blocking and errors are safely handled.
- Add idempotency, workspace-isolation, and event-evidence checks where missing.

**Progress:** Workspace-aware collectors, terminal-outcome recording, start-before-terminal ordering, per-workspace distillation coalescing, a new-event threshold, and evidence validation are implemented. The SQLite-backed Agent integration suite verifies eventual completed/failed/aborted persistence, monotonically ordered timestamps, and workspace/session isolation. A deliberately delayed writer proves `sendMessage` resolves without waiting for Selfdev storage. The detached sidecar waits for task-start before writing the terminal event and schedules automatic distillation only after the terminal write succeeds; aborts skip distillation.

**Exit criteria:** the relevant lifecycle, workspace isolation, coalescing, and evidence regression tests pass.

### Phase 3 — Safety and approval boundaries

- Audit redaction and validation for both persisted events and generated lesson fields.
- Test the escalation filter with adversarial lesson proposals.
- Prove only active, approved lessons are injected.
- Prove edit/review/version conflicts invalidate stale approvals.
- Prove lessons cannot cross workspace boundaries or grant authority.

**Progress:** Candidate/active/retired lesson persistence is preserved; approval checks evidence when a trusted event store is supplied; injector validates lesson records and only injects active lessons for the exact workspace. Existing redaction, distiller, review, and injector tests pass. Adversarial and evidence coverage will continue to grow with the evaluation suite.

**Exit criteria:** security-focused tests pass; no candidate is activated or injected without explicit approval.

### Phase 4 — Single/multi integration and diagnostics

- Test single-agent and multi-agent configuration paths.
- Verify status output explains effective state, migration, opt-out, and lesson counts.
- Ensure disabling works immediately for subsequent events and prompt construction.
- Verify a Selfdev outage does not fail an ordinary task.

**Progress:** Status reports config version/explicit opt-out; `selfdev doctor`, `selfdev metrics`, `selfdev feedback`, and `selfdev inspect` are available in CLI/slash-command surfaces. Real parallel Agent instances with distinct workspaces/sessions are now exercised in the lifecycle integration suite and their SQLite events are verified separately.

**Exit criteria:** focused single/multi integration tests pass and status accurately reports state.

### Phase 5 — Bottleneck remediation and feature upgrades

Complete the verified P0 correctness items before shipping optional enhancements:

- Fix workspace-aware event collection and the completion-event/distillation ordering race.
- Add per-workspace distillation single-flight/coalescing and a measured cadence/threshold.
- Add safe diagnostics and distinguish “no eligible work” from operational failure.
- Establish baseline performance fixtures, then optimize event-store batch writes, prompt injection reads, and lesson-store locking only where profiling confirms a bottleneck.
- Add `selfdev doctor` and `selfdev metrics` with read-only diagnostics by default.
- Wire feedback telemetry and candidate evidence verification; add confidence/provenance and near-duplicate hints without auto-approval.
- Add fault-injection tests for stale locks, storage failures, workspace switching, concurrency, and shutdown/restart.

**Progress:** Workspace and completion-order issues are addressed; auto-distillation is coalesced and thresholded; stale locks are reclaimed only when an old local owner PID is confirmed dead; runtime counters, doctor/metrics, injection tracking, explicit feedback, provenance inspection, conservative near-duplicate review hints, and repeatable benchmarking exist. The filter-order optimization reduces p95 prompt-injection time from 1.852 ms to 0.833 ms (55.0%) with a synthetic 500-lesson store / five active lessons. Single-event write p50/p95 is 0.120/0.165 ms, batch per-event 0.050/0.081 ms, and the current 500-candidate/no-active prompt path is 0.626/0.829 ms. A calibrated confidence score and broader fault-injection / semantic evaluation work remain intentionally deferred; see the limitations at the top of this plan.

**Exit criteria:** P0 correctness and the supported default-on scope have focused regression coverage, the eligible-only validation optimization has same-runtime before/after measurements, and unfinished advanced features remain explicitly deferred rather than partially exposed.

### Phase 6 — Documentation and rollout

- Update Selfdev documentation and CLI help with default-ON behavior, one-time migration semantics, opt-out instructions, privacy boundaries, new diagnostic/metrics commands, and the feature roadmap.
- Include upgrade notes about legacy `enabled: false` handling and explain that active lessons still require explicit approval.
- Run focused tests, performance benchmarks, then the relevant full test suite and TypeScript build.
- Inspect `git diff` to ensure unrelated working-tree changes are not altered.

**Progress:** `docs/selfdev.md`, CLI help, and this plan describe default-ON semantics, migration, opt-out, privacy/safety boundaries, evidence inspection, diagnostics, metrics, feedback, and benchmark methodology. The TypeScript build and focused Selfdev/Agent suites pass; the complete monorepo suite still exceeds the runner time limit, and the unrelated `multiModeAudit.test.ts` assertion mismatch is documented separately.

**Exit criteria:** documentation matches verified behavior, build succeeds, focused tests pass, performance measurements are recorded, and unresolved repository-wide verification is reported honestly.

## 7. Test Plan

Update and extend the existing tests rather than replacing them.

### Configuration and migration

- `tests/selfdev/settings.test.ts`
- `src/core/config/selfdevConfig.ts` normalization coverage

Required cases: default ON, partial configuration, legacy migration, migration idempotency, explicit opt-out, explicit re-enable, invalid values, bounded numeric settings, mandatory redaction.

### Event collection and distillation

- `tests/selfdev/collector.test.ts`
- `tests/selfdev/eventStore.test.ts`
- `tests/selfdev/distiller.test.ts`
- `tests/selfdev/candidateStore.test.ts`
- `tests/selfdev/candidateConcurrency.test.ts`

Required cases: disabled mode is a no-op; enabled mode records bounded events; safe behavior on storage errors; secret redaction; authority-escalation rejection; workspace scoping; evidence validity; deduplication under repeated/concurrent distillation.

### Lessons and injection

- `tests/selfdev/injector.test.ts`
- `tests/selfdev/reviewService.test.ts`
- `tests/selfdevAndGatewaySuite.test.ts`

Required cases: active lessons only; exact workspace matching; opt-out stops injection; candidate never auto-activates; approval and retirement work; editing an active lesson invalidates approval.

### Integration and modes

- Add or extend tests around `src/core/agent.ts` lifecycle hooks.
- Extend `tests/multiModeAudit.test.ts` or focused agent integration tests for single/multi behavior.
- Verify existing mode-switching behavior remains unaffected.

### Bottleneck and feature validation

Add focused tests/benchmarks for the newly identified issues and features:

- Workspace binding: initialize agents for workspace A and B within one process; verify each event is persisted under the correct workspace and workspace changes do not reuse stale state.
- Completion race: verify the `task_completed` event exists before automatic distillation reads its evidence set.
- Distillation coordinator: concurrent completion hooks for one workspace should coalesce, not run unbounded duplicate distillation; different workspaces must remain isolated.
- Error observability: induce database read/write failures, invalid lesson-store JSON, and lock contention; status/doctor must identify the category without exposing secrets.
- Stale lock recovery: simulate both a dead lock owner and a live owner; reclaim only a safely verified stale lock.
- Injection performance: benchmark no lessons and five active lessons against growing candidate-store sizes; verify cache invalidation after approve/edit/retire and external file changes.
- SQLite performance: compare single and batch event writes, including retention pruning, with representative event volumes; check atomicity and retention semantics.
- Feedback metrics: duplicate injections/outcomes must not inflate counts; “helped” and “harmed” require explicit evidence/user signal rather than inference from task success.
- Candidate quality: test exact duplicates, conservative near-duplicates, insufficient/cross-workspace evidence, prompt-injection-like text, secret-bearing events, and lessons that attempt to change permissions.
- Diagnostic CLI: `selfdev doctor` defaults to read-only; metrics stay bounded and redact private data.

For each benchmark, record environment, workload size, sample count, p50/p95, memory where relevant, and before/after comparison. Avoid flaky absolute timing assertions in normal CI; use functional CI assertions and a separate repeatable benchmark command.

Run focused Selfdev tests first, then related integration tests, then the project build and full tests. Do not mark the work complete based only on unit-test success.

## 8. Acceptance Criteria

The implementation is done only when all of the following are true:

- [x] A fresh installation reports Selfdev enabled by default.
- [x] A legacy installation receives the one-time default-ON migration.
- [x] A new explicit `selfdev disable` persists across restarts and configuration updates.
- [x] `selfdev enable` reliably re-enables the engine.
- [x] Collection, distillation, and injection follow their individual settings and the master switch.
- [x] The system records useful task events best-effort; a trigger-induced SQLite write failure integration test proves the main Agent task still resolves.
- [x] Workspace-aware collector tests prove there is no process-CWD/workspace mismatch or stale collector reuse.
- [x] Completion/failure events are persisted before automatic distillation is scheduled; integration tests verify ordered eventual persistence, and a slow-writer test proves main-task completion does not await the Selfdev sidecar.
- [x] Distillation is bounded/coalesced per workspace and does not run duplicate work on every fast completion burst.
- [x] Event-store writes and prompt-injection latency are benchmarked; prompt injection has a same-runtime before/after comparison. Lesson-store locking remains unchanged because the measured evidence did not justify a speculative rewrite.
- [x] Candidate-store lock recovery safely handles a verified stale owner and never steals a live owner's lock.
- [x] Runtime counters and read-only doctor checks expose sanitized diagnostic categories; detailed fault-injection coverage remains outstanding.
- [x] `selfdev doctor` and `selfdev metrics` are implemented or explicitly deferred with a documented reason; diagnostic mode is read-only by default.
- [x] FeedbackTracker is wired to production injection and explicit feedback controls; injection writes are idempotent and helpful/harmful outcomes require an explicit signal.
- [x] Candidate evidence is validated, provenance can be inspected with workspace-scoped event summaries, source signals and approval metadata; near-duplicate hints only mark candidates for human review.
- [x] Distillation creates bounded, deduplicated candidates and never activates them automatically.
- [x] Secret redaction, production evidence validation, suspicious-instruction rejection, and workspace isolation are covered by focused tests.
- [x] Only explicitly approved active lessons are injected into the correct workspace.
- [x] Single-agent and parallel multi-agent execution paths are covered by persisted-event integration tests.
- [x] Status makes enabled state, migration/opt-out state, and lesson counts clear.
- [x] Documentation explains how to inspect, approve, reject, retire, enable, and disable lessons.
- [x] TypeScript build and focused tests pass; full-suite execution is still unconfirmed and the selected unrelated test mismatch is documented in the progress log.
- [x] Existing unrelated changes in the working tree are preserved; unrelated files were left untouched.

## 9. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Default ON creates event data before users expect it | Document the behavior; keep collection workspace-scoped, bounded, redacted, and easy to disable. |
| Legacy `false` value could have been an intentional opt-out | Make the one-time migration behavior visible; introduce an explicit opt-out marker for all future user choices. |
| Untrusted task text becomes a harmful lesson | Redact secrets, reject authority-escalation patterns, require valid evidence and human approval. |
| Automatic distillation adds latency or duplicated candidates | Run best-effort in the background where appropriate, cap work per pass, and make writes idempotent. |
| Selfdev storage errors disrupt normal work | Preserve the non-throwing integration boundary and expose safe diagnostics. |
| Per-task distillation creates load or lock contention | Use per-workspace coalescing, bounded cadence, and benchmark before/after performance. |
| A stale lock blocks future candidate writes | Use conservative owner-aware stale-lock recovery; never reclaim a verified live lock. |
| Metrics imply a lesson helped without evidence | Count injection separately from explicit application/help/harm feedback; do not infer causality from task completion alone. |
| Optimization weakens validation or workspace isolation | Treat safety invariants as hard gates in every benchmark and refactor. |
| Multi-agent work leaks lessons across contexts | Bind event and lesson queries to an exact workspace and test both modes. |

## 10. Completion Report — 2026-10-14

1. **Implementation areas:** default-on settings/migration; workspace-scoped event collection; ordered Agent lifecycle persistence; bounded/coalesced distillation; validated evidence and approval; candidate-store locking; feedback; doctor/metrics/inspect commands; near-duplicate review hints; filter-first injection validation; documentation and benchmarks.
2. **Focused verification:** the latest build plus grouped run of `tests/selfdev`, `tests/selfdevAgentLifecycle.integration.test.ts`, `tests/selfdevAndGatewaySuite.test.ts`, and related Agent/mode tests passed: 16 files, 194 tests. The complete monorepo still lacks a conclusive run due runner limits and documented unrelated failures.
3. **Build:** `bun run build` passed after the source and benchmark changes.
4. **Runtime CLI smoke:** `selfdev status` reported Enabled Yes, Config Version 1, Explicit Opt-out No, collection and injection enabled. `selfdev doctor` reported all checks OK. `selfdev metrics` reported storage available and no stored events/lessons for the current workspace at test time.
5. **Injection safety:** `tests/selfdev/injector.test.ts` verifies only active lessons for the exact workspace are returned and the five-lesson cap remains enforced; candidate and retired lessons are excluded. Structural validation is still mandatory for eligible active lessons.
6. **Opt-out persistence:** earlier isolated CLI smoke verified that disable persists across independent processes and enable clears the opt-out. The active profile's migration has been rechecked; no long-running server process was restarted.
7. **Known limitations:** the full monorepo test run hit the execution timeout before producing a complete report; one selected unrelated `tests/multiModeAudit.test.ts` assertion expects an older tool error string. Calibrated confidence scores, broad fault injection, shutdown/retry coordination, semantic cross-task learning, relevance ranking, learning-policy UI, export/retention workflows, and reversible audit-log revisions remain explicitly deferred. No unrelated source edits were intentionally changed.
