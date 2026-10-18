# SuperAgent Hermes-like Phase 2 — Evidence-Based Skill Lifecycle

**Status:** Bounded lifecycle implementation landed in the working tree; Phase 2 overall remains in progress.

## What changed

Skill synthesis previously wrote a valid SKILL.md directly into runtime discovery. Synthesis now creates a content-addressed candidate outside the active skill tree. A candidate needs a passing evaluation, verified persisted task evidence, and explicit owner approval from an interactive CLI before activation.

### Candidate identity and storage

Candidate artifacts and record metadata live under .superagent/skill-candidates/<name>/<sha-prefix>/. The record stores the full SHA-256 digest, workspace identity, immutable version ID, evidence IDs, evaluation history, approval provenance, lifecycle transitions, and redacted extracted patterns. Candidate reads validate integrity and workspace binding; path containment, symlink checks, atomic writes, and local-only workspace restrictions fail closed. Candidate creation does not invalidate the skills cache and does not write into .agents/skills/. The legacy direct-save helper rejects direct installation.

### Evidence-based evaluation

The versioned evaluation checks Markdown structure, frontmatter identity, common secret/credential patterns, permission or approval bypass language, risky command patterns, machine-specific paths, active-name collisions, and persisted Selfdev task evidence.

A source evidence ID must resolve in the exact workspace to a persisted task_completed terminal event. That event must link to a successful persisted test/build event for the same task and session, timestamped before task completion. Missing, cross-workspace, unavailable, or stale evidence fails closed. Markdown validity alone is not evidence of successful learning.

Static scanners are heuristics, not a sandbox and not a guarantee that arbitrary generated instructions are safe. Broader prompt-injection analysis and sandboxed replay are still required.

### Lifecycle and approval

CLI operations include candidates, evaluate, promote, rollback, compare, disable, and retire. Promotion requires the latest passing evaluation, revalidates its source evidence, checks active-file ownership, and prints the candidate for review. Mutating approval actions require a real interactive terminal and an exact typed confirmation; non-interactive approval is denied, and no MCP promotion tool was added.

New active versions supersede the former managed version. Rollback may reactivate a previous evaluated version. Disable and retire preserve candidate metadata and audit history. An unmanaged active skill is never overwritten.

### Entry points and metrics

CLI synthesis, slash-command synthesis, the synthesize-skill tool, MCP synthesis, and the HTTP synthesis route now create candidates. Active discovery still reads only .agents/skills/. The read-only endpoint GET /api/skills/candidates lists candidates for the workspace resolved from request context; a workspace supplied in a request body cannot override it.

Skill invocation counts are separate from observed successful/failed runs and elapsed milliseconds. The initial counters are aggregated by skill name; per-version effectiveness scores, retry counts, regression detection, cost, validation coverage, and user feedback remain open.

## CLI examples

- superagent skill synth "Describe the workflow" --name workflow-helper --workspace <path> [--evidence-id <task-completed-event-id>]
- superagent skill candidates --workspace <path>
- superagent skill evaluate workflow-helper@<12-char-version> --workspace <path> [--evidence-id <task-completed-event-id>]
- Review the output, then run superagent skill promote workflow-helper@<12-char-version> --workspace <path> and type the exact confirmation.
- superagent skill compare workflow-helper <version-a> <version-b> --workspace <path>
- superagent skill rollback workflow-helper@<previous-version> --workspace <path>
- superagent skill disable workflow-helper --workspace <path>
- superagent skill retire workflow-helper@<version> --reason <reason words> --workspace <path>

Synthesizing revised content under the same name creates a separate immutable version. Evaluation alone never activates a candidate.

## Verification

- bun run build — passed.
- bunx vitest run tests/skillLifecycle.test.ts tests/skillRoutes.test.ts tests/skillSynthesizer.test.ts tests/skillTracker.test.ts tests/selfdevAndGatewaySuite.test.ts — 5 files and 48 tests passed on the latest successful focused run.
- Lifecycle tests cover missing/invalid evidence, cross-session and cross-workspace links, test evidence timestamped after terminal completion, persisted successful task/test evidence, explicit promotion, non-interactive approval denial, history-preserving disable, immutable revisions, compare, rollback, permission-bypass rejection, unmanaged-file protection, path traversal rejection, and candidate integrity tampering.
- Synthesizer tests cover newline/frontmatter and heading injection, bounded oversized metadata, bounded trajectory extraction, candidate-only storage, direct-save rejection, and the active runtime discovery boundary. Route tests verify that the candidate endpoint and synthesis route obey trusted workspace resolution. Tracker tests cover usage counters versus success/failure/duration metrics.
- git diff --check passed before this document was added; rerun after documentation updates.

## Still open before Phase 2 completion

- Replay the same labeled task fixture against the generated skill inside a disposable sandbox/worktree; current evaluation does not execute generated instructions.
- Add structured evidence for model/provider, execution mode, error/recovery, changed files, applicability/preconditions, expected output, and user feedback.
- Improve adversarial prompt-injection/secret/generalization analysis and formal risk classification.
- Track outcomes by exact skill version, including regression comparisons, retry/iteration counts, independent validation results, and cost/latency where available.
- Add an evidence-backed revise/refine review workflow and run provider-level/end-to-end checks of the actual interactive CLI.
- Continue Phase 1 memory retrieval-quality and live-provider checks; this increment does not mark those gates complete.

## Compatibility and rollback

The active skill remains at .agents/skills/<name>/SKILL.md. Use the lifecycle CLI to disable a managed active skill so its hash can be verified and history retained. Existing unmanaged active skills are preserved and cannot be overwritten by promotion. Do not manually copy candidates into the active tree to bypass evaluation or approval.

This records a bounded Phase 2 increment, not completion of every Hermes-like capability or all Phase 2 acceptance criteria.
