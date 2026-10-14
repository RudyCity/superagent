# Selfdev Next Improvements Plan

- **Date:** 2026-10-14
- **Status:** Core scope and operational smoke checks completed. Build and 388 selected tests pass. The full monorepo suite has not been conclusively re-run.
- **Related plan:** `docs/plans/2026-10-14-selfdev-default-on-development-plan.md`
- **Scope:** SuperAgent Self-Development Engine
- **Goal:** Make review decisions auditable, feedback measurable, backup/restore safe, retention explicit, duplicate hints evaluated, and repository health verifiable.

## Baseline and review of existing workspace

Initial check after restart: Selfdev config v1 enabled, collection/injection enabled, 19 events, two candidate lessons, no active/retired lessons, no feedback signals, doctor checks OK.

Both candidate lessons were inspected before review. They were generic task paraphrases, not reusable operational rules; one included unnecessary account/provider URL context in its evidence. Neither was activated.

A redacted pre-review backup was created and independently re-read/validated:
- Path: `C:\Users\USER\AppData\Local\Temp\selfdev-pre-review-20261014.json`
- SHA-256: `6d70c1a2a94d951f2330db4bf06826f808011b76c2ce407beaee71a85f0ce0c8`
- Contents: 21 events, 2 lessons, 0 feedback rows, 0 prior review decisions.

Both candidates were then rejected with explicit reasons. A follow-up CLI check confirmed zero candidate lessons and two workspace-scoped `rejected` audit decisions. The backup and the rejected candidates remain recoverable in the verified pre-review export.

## Safety invariants

- Similarity scores and candidate generation never auto-approve, reject, merge, or activate lessons.
- Approval requires valid evidence belonging to the exact workspace.
- Best-effort Selfdev telemetry must not fail the primary task.
- Backups are bounded, versioned, checksummed, workspace-scoped, and redacted.
- Restore is dry-run by default, validates all records, requires an entirely empty target workspace, and writes a pre-restore backup before apply.
- Retention is dry-run by default and never deletes event evidence referenced by any lesson state.
- Feedback distinguishes a new row, a duplicate/no-op, disabled state, invalid input, and storage errors.
- Similarity figures from synthetic fixtures are not calibrated production accuracy.
- Existing MCP and other user's in-progress changes must not be reverted or committed without separate authorization.

## Phase 0 — Review existing candidates

- [x] Inspect both candidate lessons and workspace-scoped evidence.
- [x] Determine both are generic task summaries, not reusable procedures.
- [x] Export a redacted pre-review backup and validate checksum/workspace/counts.
- [x] Reject both with explicit reasons and persist review decisions.
- [x] Verify candidate list is empty and both decisions appear in `selfdev decisions`.

**Result:** no generic task summary is active or retained as a candidate.

## Phase 1 — Provenance and review ergonomics

- [x] Persist bounded review decisions with workspace, lesson ID/version, action, actor, timestamp, and redacted reason.
- [x] Keep existing stores readable when the optional `reviewDecisions` field is absent.
- [x] Audit approve, reject, retire, and edit with the lesson mutation.
- [x] Bound audit history at 500 rows and fail explicitly at the cap rather than silently evict history.
- [x] Scope evidence inspection to the exact workspace.
- [x] Display ISO-8601 timestamps and redact URLs/common credential forms from bounded evidence summaries.
- [x] Add CLI/slash `decisions [limit]`.
- [x] Test redacted rejection reasons and legacy-store compatibility.

**Validation:** review audit and broader Selfdev tests pass.

## Phase 2 — Feedback loop

- [x] Add typed statuses: `recorded`, `duplicate`, `disabled`, `invalid_input`, `storage_error`.
- [x] Preserve legacy boolean API, returning true only when a new row is inserted.
- [x] Add per-lesson metrics, last signal timestamp, bounded record listing/count, and empty-workspace restore hooks.
- [x] Make CLI/slash responses distinguish duplicate feedback from a new insertion.
- [x] Use unique default IDs for manual CLI assessments; accept an explicit ID for intentional idempotent retries.
- [x] Test idempotency, workspace isolation, status distinctions, metrics, and restore.
- [ ] Observe real `injected` metrics after a useful lesson has been human-approved and activated. There are currently zero active lessons; no lesson was fabricated merely to manufacture this signal.

**Definitions:** `injected` means an eligible lesson was included in a prompt. `applied`, `helped`, and `harmed` are explicit/verifiable outcome signals and must not be inferred from task completion alone.

## Phase 3 — Backup, restore, and retention

- [x] Add versioned `superagent-selfdev-backup` bundle with workspace/count manifest, redacted marker, creation time, and SHA-256.
- [x] Bundle events, lessons, feedback rows, and audit decisions.
- [x] Add redaction for common secret/token forms, sensitive payload keys, and URLs.
- [x] Bound file size and record counts; refuse overwrite unless `--overwrite` is explicit.
- [x] Write exports through temporary files and atomic rename.
- [x] Validate format/version, checksum, workspace, counts, full event schema, lesson/evidence links, duplicate IDs, feedback keys, and audit structure before restore.
- [x] Keep restore dry-run by default; `--apply` requires a fully empty target and makes a pre-restore backup.
- [x] Restore SQLite records under savepoints and compensate across stores if an import stage fails.
- [x] Add dry-run/explicit apply event retention, protecting evidence referenced by candidate, active, and retired lessons.
- [x] Test redaction, checksum tampering, workspace mismatch, round-trip restore, populated-target rejection, an injected storage fault/rollback, and evidence-protecting retention.
- [x] Smoke the real CLI: export and backup verification succeeded; restore validation/dry-run and retention dry-run succeeded.
- [x] Confirm no restore was applied and no retention deletion was run against real user data.

**Commands:** `selfdev export <path>`, `selfdev backup <path>`, `selfdev restore <path> [--apply]`, `selfdev retention --days <N> [--apply]`.

**Retention boundary:** only old, unreferenced event rows can be deleted. Lessons and feedback are not deleted. Feedback retention remains a separately defined future policy.

## Phase 4 — Near-duplicate evaluation

- [x] Export the token-overlap scorer for repeatable evaluation.
- [x] Add 18 labeled synthetic examples: 8 paraphrase pairs, 10 different/opposite-policy pairs.
- [x] Guard common contradiction/polarity cues (never/not/avoid/delete/remove/reject/stop, etc.).
- [x] Add regression tests for paraphrases and opposite-policy pairs.
- [x] Tune the review hint threshold from 0.72 to 0.35 on the synthetic fixture.
- [x] Run `bun run scripts/evaluate-selfdev-similarity.ts`: TP=8, FP=0, TN=10, FN=0; fixture precision/recall = 100%/100%.
- [ ] Evaluate against a larger curated, sanitized corpus labeled by humans before any production-accuracy claim or ranking use.

**Caveat:** the 18-example fixture is synthetic and small; its perfect result is only a regression signal. The hint may flag a candidate for human review but never decides its lifecycle.

## Phase 5 — Regression and repository health

- [x] `bun run build` passes.
- [x] Selfdev suite passes: 119 tests across 15 Selfdev test files.
- [x] Similarity regression script passes.
- [x] Broader Agent/Selfdev/Muse/mode/CLI regression group passes: 27 files, 309 tests.
- [x] MCP config/HTTP/OAuth/client compatibility regression group passes: 8 files, 79 tests.
- [x] Targeted `git diff --check` passes for the Selfdev changes and the changed regression-test/resolver paths.
- [x] Re-run prior named failures in isolation and diagnose/fix their causes:
  - `tests/agentPlanContent.test.ts`: 4/4 pass; fallback behavior verified.
  - `tests/askQuestionRobustness.test.ts`: 3/3 pass after changing the outdated mock to exercise the required batch tool schema directly.
  - `tests/cliBridgeTool.test.ts`: 52/52 pass; artifact-injection expectations are explicitly disabled in tests focused on unrelated CLI behavior.
  - `tests/CompactionStrategy.test.ts`: 9/9 pass; expected pin count reflects the explicit pin plus anchored active user request.
  - `tests/museMultiProjectWatch.test.ts` + `tests/museWebSocketTransport.test.ts`: 26/26 pass; read calls use the batch schema and workspace resolver handles the first `filePaths` entry.
  - `tests/multiModeAudit.test.ts`: 9/9 pass.
- [ ] Re-run the entire monorepo test suite in bounded batches and reconcile all remaining failures/timeouts. Whole-repo status must remain marked **unconfirmed** until that run finishes.

**Historical baseline only:** an earlier repository sampling found 1,305 passing tests and 11 failures across completed batches, plus one 25-file batch that exceeded the execution limit. That is not the outcome of current verification. The current verified result is the two selected groups above (388 tests); no claim is made that every repository test passed.

## Final implementation summary

| Area | State |
|---|---|
| Human review provenance/audit | Implemented, tested, and exercised on current candidates |
| Feedback idempotency/status/per-lesson metrics | Implemented and tested |
| Redacted/versioned backup and validate-before-restore | Implemented, tested, and smoke-checked |
| Restore compensation and evidence-safe event retention | Implemented and tested, including injected failure |
| Duplicate similarity evaluation | Implemented; synthetic fixture passes, broader human-labeled evaluation deferred |
| CLI and slash command exposure | Implemented; CLI export/restore-dry-run/retention-dry-run verified |
| Build + selected regression tests | Build passes; 388 selected tests pass in 35 files |
| Entire monorepo test suite | Still unconfirmed; whole-suite verification remains open |

## Definition of done

- [x] Build passes.
- [x] All Selfdev tests pass.
- [x] Similarity evaluation is repeatable and warns that it is synthetic only.
- [x] No candidate is auto-activated by these changes.
- [x] Existing generic candidates were exported, rejected with audit reasons, and verified absent.
- [x] Export/restore dry-run and retention dry-run were exercised through the real CLI.
- [x] `docs/selfdev.md` and this plan match the final CLI behavior.
- [x] Relevant Agent/Muse/mode/MCP regression suites were rerun.
- [x] Known root-suite failures were retested, with resolved cases recorded above.
- [ ] Full monorepo test suite finishes in bounded batches.

---
Core scope is complete. Remaining follow-ups require a larger real-world labeled similarity corpus, a genuinely useful approved lesson before observing non-zero `injected` feedback, and a complete monorepo test run. No commit was created, and no running SuperAgent service was restarted.
