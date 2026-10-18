# SuperAgent Hermes-Like — Phase 1 Memory Quality, Review, and Evaluation Plan

- **Created:** 2026-10-18
- **Status:** Core Phase 1 implementation complete in working tree; full test inventory passed in batches; live-provider evaluation remains follow-up
- **Repository:** `D:/backup from pc asus/Documents Development/superagent`
- **Baseline commit:** `d12e3c12d5b203ed38ec8b8e2cfbddb62fe2a5ce` (`main` when work began)
- **Implementation state:** uncommitted working-tree changes; existing edits to the canonical Hermes reference are preserved
- **Canonical initiative reference:** `docs/plans/2026-10-18-superagent-hermes-like-implementation-master-reference.md`
- **Depends on:** memory schema/scope, owner-confirmed legacy migration, memory lifecycle tools, and task-scoped verification evidence merged in `d12e3c12`

> **Purpose:** Close the remaining Phase 1 memory gaps before moving deeper into self-improvement or unattended automation: reviewable updates, stale/conflicting facts, retention, verified task summaries, quarantined legacy review, and reproducible recall evaluation.

---

## 1. Executive Decision

Extend the current RMemory and memory-record architecture. Do not create a second memory backend or rewrite the agent loop. Keep durable memory, conversation/session history, task evidence, advisory lessons, and procedural skills distinct, while connecting them with stable identifiers and scoped provenance.

### Baseline and current implementation evidence

The starting point was `d12e3c12`. Phase 1 changes are implemented in the current, uncommitted working tree. Final verification was run on 2026-10-18 after the last code changes:

- `bun run build`: passed.
- Complete test inventory: **342 test/spec files**, executed in 14 deterministic batches. All batches passed; totals were **3,344 tests passed and 5 skipped, 0 failed**. One test file is reported as skipped by the suite. Two initially failing batch checks were corrected, then the affected batches passed on re-run.
- Phase 1 focused gate: 12 files, 117 tests passed (RMemory recovery/revision, lifecycle/evaluation, recall strategy, tools, SelfDev distiller/lifecycle, toolset authorization, metadata validation, CLI, and HTTP routes).
- `bun run verify:extension-js`: passed; 8 extension JavaScript files checked.
- `bun run wiki:validate`: passed; 9 Markdown files and 24 internal links checked.
- `git diff --check`: passed after final documentation updates.
- `bun run verify:all`: the single combined command timed out after 300 seconds in an earlier attempt without returning a final exit code. Its component gates were run separately and passed, including the complete test inventory in batches; the wrapper timeout is neither reported as a test failure nor as a pass.
- Live provider evaluation and provider-reported/billed token accounting: not run. Token counts in recall metadata remain estimates.

The full local test inventory is now verified. Keep live-provider evaluation and extending the small deterministic retrieval fixture as follow-up quality work rather than blocking this implementation gate.
---

## 2. Scope and Non-Goals

### In scope

- Re-establish the test baseline and document completed results accurately.
- Review the current memory metadata schema and validators before making compatible additions.
- Define and implement update, supersession, conflict, freshness, retention, and rollback semantics.
- Preserve isolation across tool, CLI, HTTP, shared-memory, and automatic-recall paths.
- Link candidate task summaries to valid task/evidence IDs, with secret redaction.
- Measure retrieval relevance, scope isolation, injection budget, latency, and unavailable-memory behavior.
- Update the canonical reference only after code/tests establish the new behavior.

### Out of scope

- Automatic procedural-skill promotion (Phase 2).
- Durable scheduler/run-ledger redesign (Phase 3).
- Rewriting MCP providers, Workspace Chain, or multi-agent orchestration.
- Silently resolving conflicts or deleting stale facts.
- Broad re-embedding/index migration without staging and rollback.
- Claiming Hermes parity because an analogous tool or command exists.

---

## 3. Non-Negotiable Guardrails

1. **Scope before relevance:** project eligibility must be enforced before memory enters model context.
2. **Provenance travels with the fact:** recall and inspect should show scope, validation/review state, evidence class, and freshness when available.
3. **Similarity is not proof of conflict:** embeddings may nominate candidates, but a deterministic scoped key/assertion comparison or explicit review must establish contradiction.
4. **Staleness is not deletion:** mark or down-rank according to policy; keep source data until an authorized review/retention action.
5. **Updates are previewable:** show target, scope, provenance, before/after values, and confirmation requirements.
6. **History is recoverable:** superseded records remain inspectable and have a rollback path where supported.
7. **Ambiguous legacy ownership stays quarantined:** never infer project scope from basename, folder name, content mention, or similarity.
8. **Memory is untrusted reference data:** it cannot override instructions, authorization, or approval gates.
9. **Recall is bounded:** cap items and estimated characters/tokens; never inject the entire corpus.
10. **Keep memory, episodes, and skills distinct:** durable facts in memory, historical detail in searchable session/task history, reusable procedures in skills.

---

## 4. Workstreams

### A. Baseline and full-suite evidence

**Areas:** package scripts, Vitest config, existing regression suites, test-health documentation.

1. Inspect exact script/config behavior before selecting commands.
2. Run `bun run build` and the focused memory/task suites on current HEAD.
3. Run the full suite in a sufficiently long-lived process or batches that return completed exit codes.
4. Capture exact commands, file/test counts, failures, skips, duration, and exit code per batch.
5. Classify failures as regression, pre-existing, flaky, or environment/provider-dependent. Do not silence a failure to make the gate green.
6. Mark provider/live checks unverified unless actually executed.

**Exit gate:** focused suites/build pass and the full-suite result is evidenced, or the remaining unverified batches are explicitly enumerated as a release blocker.

### B. Update, supersession, and rollback

**Areas:** `src/core/memoryRecord.ts`, `src/core/rmemoryUtil.ts`, `src/core/tools/rmemoryTools.ts`, `src/core/commands/memoryCommand.ts`, `src/serverRoutes.ts`.

1. Inventory all create/search/inspect/export/delete/write paths and their current scope checks.
2. Define compatible metadata changes. Prefer optional additive fields if invariants stay compatible; bump schema only when persisted meaning or validation requirements change.
3. Add a preview/dry-run that reports exact target ID, scope, current/proposed value, provenance, and reason.
4. Implement explicit update/revise semantics that preserve `createdAt`, update `updatedAt`, record new provenance, and never change scope implicitly.
5. Detect target changes between preview and apply; return a conflict rather than overwriting a newer revision silently.
6. Model supersession as a traceable relation. Keep the previous record inspectable/restorable according to explicit policy.
7. Apply equivalent permission, confirmation, and scope rules to tool/CLI/HTTP routes. Keep same-key shared memories in unrelated projects isolated.
8. Ensure retries are safe/idempotent and do not create duplicate or corrupt records.

**Acceptance:** Project A cannot update/export/delete Project B; global/project scope cannot change implicitly; stale-target conflicts do not overwrite; history/provenance is preserved; ambiguous or unauthorized operations fail closed.

### C. Conflict and freshness policy

1. Classify fact types that can become stale: temporary incidents, deployment/runtime versions, deadlines, project decisions, stable preferences, and conventions.
2. Set freshness rules per type. Do not apply one universal TTL to all memories.
3. Add optional last-verified/expiry metadata only after schema compatibility is designed and documented.
4. Define conflict detection conservatively around subject/key, assertion, scope, and relevant time. Similarity alone must not establish a conflict.
5. Preserve conflicting records; attach a reviewable relationship/candidate, show timestamps/evidence, and avoid treating either as verified truth until policy or owner review resolves it.
6. Distinguish states such as unverified, stale, conflicted, reviewed, and superseded only if they can be enforced consistently. Do not overload one boolean with several meanings.
7. Timestamp alone never upgrades an unverified fact.
8. Provide owner actions to retain one assertion, revise, merge with evidence, or leave unresolved. Record the decision and preserve history.

**Acceptance:** stale facts are marked/down-ranked rather than silently deleted; conflicts are observable; newer unverified items do not automatically beat older verified items; resolution is scoped and auditable.

### D. Retention and quarantined legacy records

1. Inventory record types and known index artifacts before implementing cleanup; never use broad directory deletion.
2. Define retention separately for user preferences, project facts, temporary facts, task summaries, conflict records, and superseded versions.
3. Preview bulk expiry/deletion and report counts grouped by scope and reason.
4. Require explicit confirmation for destructive operations; fail closed when non-interactive confirmation is unavailable.
5. Exclude quarantined/ambiguous legacy rows from automatic expiry.
6. Provide an explicit owner mapping/re-save workflow: owner chooses scope, target validates, and original remains until the replacement is verified and confirmed.
7. Keep exports allowlisted and redact secrets by default.
8. Test partial failures, retries, rollback, and interrupted migration/re-save.

**Acceptance:** retention affects only previewed, policy-eligible records; ambiguous rows remain quarantined; a failed migration never removes the only readable copy; supported entry points behave consistently.

### E. Verified task summaries and evidence

**Areas:** `src/core/selfdev/taskEvidence.ts`, `src/core/selfdev/distiller.ts`, terminal task events, history/memory write paths.

1. Inspect the current event schema and storage guarantees before extending it.
2. Create candidate summaries only from a successfully recorded completed task and evidence IDs that actually exist.
3. Include structured facts only: task/project IDs, truthful outcome, validation status, changed-file summary when available, blockers, and follow-up.
4. Redact credentials, tokens, cookies, auth headers, private keys, and sensitive command arguments before persistence.
5. Never copy raw stdout/stderr or whole transcripts into durable memory.
6. Distinguish “test/build command passed” from “overall task succeeded”.
7. Keep partial, failed, aborted, and cancelled outcomes truthful; do not distill them as verified success.
8. Promotion from a task summary into durable memory is a separate policy step.

**Acceptance:** incomplete/failed tasks cannot yield verified-success memory; evidence belongs to the correct task/project; raw output and secrets are absent from persisted summaries.

### F. Recall quality and resource evaluation

1. Create a versioned deterministic fixture with two similarly named projects, global preference, project-only decisions, stale/conflicting assertions, quarantined legacy records, and unavailable-memory states.
2. Add deterministic tests for scope, provenance, conflict markers, and budget enforcement without requiring a live model.
3. Evaluate retrieval against labeled relevant record IDs. Keep objective safety/scope tests separate from model-judged usefulness.
4. Measure at least: relevant-record recall/precision, cross-project leakage (must remain zero), stale/conflicted items injected without warning, item count/estimated token budget, latency, error rate, and unavailable/degraded behavior.
5. Label token counts estimates unless provider usage is actually returned. Do not infer billed cost from character count.
6. Record fixture version, commit, configuration, exact command, and output.
7. Establish a baseline before tuning ranking, embedding, or context compaction.

**Acceptance:** scope safety is a hard gate; bounded recall is reproducible; empty results are distinguishable from unavailable memory; changes can be compared against the same fixture.

---

## 5. Regression Matrix

| Area | Scenario | Expected result |
|---|---|---|
| Scope | Same semantic key in two projects | Both records survive; reads/writes stay isolated |
| Update | Target changes after preview | Apply detects stale target and does not overwrite |
| Provenance | Verified record is revised | Creation time and old evidence/history remain available |
| Freshness | Temporary environment fact expires | Mark/down-rank per policy; do not auto-delete |
| Conflict | Two incompatible assertions for one scoped key | Both preserved; recall signals conflict or defers decisive injection |
| Verification | Newer unverified assertion vs older verified | Timestamp alone does not win |
| Legacy | Project identity is absent/ambiguous | Remains quarantined until owner mapping |
| Retention | Expiry spans global/project records | Only previewed and confirmed eligible records affected |
| Task state | Task fails, aborts, or remains incomplete | No verified-success summary |
| Evidence | Build passes but task fails | Evidence reports build pass; task summary reports failure |
| Redaction | Test data contains credentials | Durable summary omits/redacts them |
| Budget | Many matching records | Injection remains within configured item/size budget |
| Degraded mode | Memory provider unavailable | Explicit unavailable/error result, not empty-success |
| Retry | Confirmed operation is repeated | No unintended duplicate or lost record |

---

## 6. Execution Order

1. Reconfirm HEAD, working tree, test scripts, and known test gaps.
2. Obtain complete test results in manageable batches and triage real regressions.
3. Implement update/revise and supersession with tests.
4. Implement freshness/conflict behavior and owner review.
5. Implement retention and explicit review/mapping for quarantined legacy records.
6. Complete verified task-summary/redaction behavior.
7. Add deterministic recall fixtures and reproducible quality/resource measurements.
8. Reconcile the canonical Hermes reference and subsystem plans to tested behavior.
9. Run build, targeted tests, full-suite verification, `bun run wiki:validate`, and `git diff --check`.
10. Review scope isolation, destructive actions, redaction, docs accuracy, and staged diff before proposing a release.

Do not start automatic skill promotion or increase unattended autonomy as part of this workstream.

---

## 7. Completion Checklist

- [x] Current working-tree baseline and complete batched test evidence recorded without overclaiming.
- [x] Update/revise flow is previewable, scope-safe, conflict-aware, and provenance-preserving in the RMemory backend; tool, CLI and HTTP entry points are implemented. Targeted tests cover backend/tool workflows, CLI revision, and HTTP revision/mapping/retention guards; not every CLI argument permutation has an individual test.
- [x] Supersession/history/restore semantics have targeted regression coverage; recovery restores the old slot if the active revision write fails.
- [x] Freshness is type-aware; stale facts are not silently deleted or automatically purged.
- [x] Explicit same-key, same-scope conflicts are observable and withheld from default recall; similarity/timestamp alone is not proof.
- [x] Retention is scoped/preview-only by default; marking stale needs an eligible preview, matching version token and owner confirmation; no delete is included.
- [x] Ambiguous legacy rows have an explicit mapping preview/apply flow with chosen scope, source fingerprint, confirmation, target verification, and original preservation.
- [x] Task summaries require a persisted `task_completed` terminal event and linked same-task evidence; failed/incomplete tasks are rejected.
- [x] Persisted task summaries redact credentials/secrets and use structured event/evidence summaries rather than raw logs.
- [x] A versioned `memory-recall-v1` fixture and deterministic evaluation test report expected IDs plus precision/recall for three scoped cases.
- [x] Build, all test batches, extension JS, wiki checks, and diff checks are recorded accurately.

---

## 8. Hermes Capability References

Use these as design references, not a mandate to clone the implementation:

- [Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/) — curated durable facts versus historical session search.
- [Working with Skills](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills/) — progressive disclosure and the distinction between short durable facts and longer procedural knowledge.
- [Skills System](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/) — review gates and the relationship between memory and procedural learning.
- [Session Storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage/) — durable history and session boundaries.

**Design principle:** adopt the reliability properties—bounded curated memory, searchable history, provenance, review, safe recovery, and measurable recall—while retaining SuperAgent's existing TypeScript, RMemory, Selfdev, dynamic-tool-discovery, and provider architecture.

---

## 9. Implementation Record and Remaining Gates — 2026-10-18

### Delivered in the current working tree

- Added backward-compatible optional review/lifecycle/freshness/conflict/revision/mapping fields to `MemoryRecordMetadata`; schema remains v1 because the fields are optional and validated.
- Added `src/core/memoryLifecycle.ts`: type-aware freshness, explicit keyed conflict detection, preview-only retention candidates, common secret redaction, and a guarded completed-task-summary builder.
- Connected lifecycle/conflict suppression to RMemory tool search and `RMemoryStrategy` compaction. Scope is checked before injection; superseded revisions are excluded from normal recall.
- Added `rmemory_revise` (preview/apply/history/restore), `rmemory_review` (conflict preview, pair mark/resolve, verify/quarantine/unquarantine and explicit legacy mapping), `rmemory_retention_review` (preview/confirm stale marking), and `rmemory_task_summary` (preview/save of an owner-confirmed, unverified candidate). Registered for Master and Superagent only and added to the global tool registry; tests assert these tools are not in subagent toolsets.
- Added optimistic concurrency checks using `updatedAt`, stable scope checks, verified history snapshots, rollback attempts on failed revision writes, legacy source fingerprints, owner confirmation on state-changing tool paths, and two-record conflict update/resolve with rollback and `conflictDetectedAt`/`conflictDetectedBy`/`conflictReason` audit metadata.
- Reused the common redactor in SelfDev distillation. `buildPersistedCompletedTaskSummary` reads persisted terminal/evidence events for the exact workspace and task; the task-summary tool never promotes a summary directly to verified. Added deterministic lifecycle, isolation, conflict, review, revision/restore, mapping, tier-guard, CLI/API, evidence-linkage and degraded-recall tests.
- Added recall metadata for status (`ok`, `partial`, `conflict`, `empty`, `unavailable`), record counts, cross-scope rejection, conflict counts, estimated characters/tokens, duration and cache hit. Added `tests/fixtures/memory-recall-v1.json` and `tests/memoryRecallEvaluation.test.ts`; three deterministic labeled cases pass with precision 1.0 and recall 1.0. Token counts are estimates, not provider billing/usage.

### Exact verification captured

```text
bun run build
PASS

Full local Vitest inventory (342 test/spec files; 14 batches)
PASS — 3,344 tests passed, 5 skipped, 0 failed

Focused Phase 1 gate
PASS — 12 files, 117 tests

bun run verify:extension-js
PASS — 8 extension JavaScript files

bun run wiki:validate
PASS — 9 Markdown files, 24 internal links

git diff --check
PASS after final code and documentation edits

bun run verify:all
The combined wrapper timed out after 300 seconds without returning an exit code; the component checks listed above were completed separately.
```
### Remaining limitations (follow-up quality work)

- Task summaries are saved only as `candidate`/unverified memories after owner confirmation. There is no automatic promotion from task evidence into verified durable facts, by design.
- The `memory-recall-v1` benchmark is deterministic and labeled but intentionally small (three cases). Expand coverage before ranking/embedding changes or claims about broad retrieval usefulness.
- Live-provider/end-to-end evaluation was not run. Estimated token counts are not provider usage or billed-cost measurements.
- Legacy memory scope is never inferred; callers must explicitly choose the destination scope and confirm mapping. Similarity alone never establishes a contradiction.
- Retention only previews and marks eligible records stale; there is no bulk deletion, automatic expiry purge, skill promotion, or increased unattended autonomy in this Phase 1 slice.
### Updated workstream status

| Workstream | Status | Evidence / remaining gap |
|---|---|---|
| A. Baseline and suite | Complete | Build passes; all 342 test/spec files ran in 14 batches with 3,344 passed, 5 skipped and 0 failed; extension/wiki/diff checks pass. |
| B. Update, supersession, rollback | Core backend/tool/CLI/HTTP implemented | Revision preview/apply/history/restore and optimistic version conflict checks are covered by backend, CLI and HTTP tests; live server deployment checks were not run. |
| C. Conflict and freshness | Core retrieval policy implemented | Explicit same-key conflict and type-aware freshness are covered; no semantic-only conflict claims. |
| D. Retention and legacy quarantine | Owner-review workflow implemented | Tool, CLI and HTTP paths require scope/confirmation; ambiguous rows stay untouched until explicit mapping; no bulk deletion is exposed. |
| E. Verified task summaries | Reviewed candidate flow implemented | Summary reads persisted same-task terminal/evidence events, redacts secrets and is saved only as candidate/unverified after owner confirmation. |
| F. Recall evaluation | Deterministic baseline established | Versioned three-case fixture passes precision 1.0 / recall 1.0; broader labeled coverage and live-provider latency/usage measurement remain follow-up. |

**Release gate:** the bounded Phase 1 implementation and local verification gates are complete. Live-provider evaluation and extending the intentionally small recall fixture remain follow-up quality work; do not claim those checks have already occurred.
