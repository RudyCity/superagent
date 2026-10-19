# SuperAgent Hermes-like Phase 2 — Evidence-Based Skill Lifecycle

**Status:** Phase 2 remains in progress. This increment adds a model-backed replay adapter, strict per-version promotion gates, richer skill metadata, adversarial heuristics, and workspace-isolated effectiveness metrics. A live end-to-end call to the configured model provider has not yet been run; focused tests use a mocked AI SDK and deterministic fixture executors.

## What changed

Skill synthesis creates immutable, content-addressed candidates outside runtime skill discovery. Candidate activation now requires verified persisted Selfdev task evidence, a passing latest evaluation that includes a passing replay for the exact immutable version, revalidation at promotion time, and explicit exact-text owner approval from an interactive CLI.

### Candidate identity and evidence

Candidate artifacts and records live under `.superagent/skill-candidates/<name>/<sha-prefix>/`. The record keeps the full content hash, workspace identity, evidence IDs, source task IDs, evaluations, approval provenance, lifecycle history, metadata, and version-bound replay records. Candidate reads validate content integrity and workspace binding.

Record metadata has a SHA-256 checksum that detects uncoordinated changes to evaluation, replay, or approval fields. This is **not a keyed signature** against someone who can rewrite the record and recompute the checksum. Legacy records are sealed on first valid read, but that cannot prove they were never edited before being sealed. Path containment, symlink checks, atomic writes, and local-only workspace restrictions fail closed. Candidate creation does not write to `.agents/skills/`; the legacy direct-save helper rejects direct activation.

A source evidence ID must resolve in the exact workspace to a persisted `task_completed` terminal event. That event must link to a successful persisted test/build event for the same task and session, timestamped before task completion. Missing, cross-workspace, unavailable, or stale evidence fails closed. Declared metadata `taskId` must match task IDs in verified evidence.

### Candidate evaluation and risk

Static checks cover Markdown structure and frontmatter identity, common secret/credential patterns, permission or approval bypass wording, risky commands, machine-specific paths, active-name collisions, verified task evidence, high-confidence prompt-injection/secret-exfiltration phrases, generalization boundaries, declared task provenance, and risk classification. High-risk candidates fail the normal evaluation path; medium-risk candidates produce a warning.

These scanners are heuristics rather than a guarantee of semantic safety. Unsupported phrase variants, contextual prompt injection, and duplicate/conflicting workflow detection remain open.

### Model-backed replay in a disposable workspace

The replay CLI loads a bounded JSON fixture from a relative path inside the selected workspace and calls a trusted application-code adapter using the configured SuperAgent model. The adapter exposes exactly five operations—list files, read file, write file, assert file exists, and verify syntax—and does not import the general agent/tool catalog.

Fixture size, initial file count, per-file and total sandbox bytes, model read sizes, tool calls, and duration are bounded. Paths must stay relative, symlinks are rejected, and the sandbox is removed after the run. Final assertions run after the model adapter returns. JSON/JS/JSX/TS/TSX syntax is parsed; JavaScript written by a candidate is never executed by the syntax checker.

Replay results bind to the exact candidate version and fixture SHA-256. They record safe provider/model labels, token usage when the AI SDK reports it, changed relative filenames, checks, duration, and outcome. The run is stored in bounded candidate history, followed by a fresh evaluation and version-specific validation metrics.

**Promotion gate:** successful sandbox replay for the exact immutable version is mandatory alongside verified task evidence, a passing latest evaluation, and explicit exact-text owner approval. A failed replay updates the evaluation and blocks promotion. A retry may be made after correcting the fixture or trusted executor, or after creating a revised immutable skill version.

**Important boundary:** this is a disposable file workspace, **not OS/container isolation**. The executor is trusted application code; candidate skill text is untrusted data. The adapter must never receive shell, network, arbitrary filesystem, or privileged tools. Use synthetic/minimal fixtures because fixture prompts and file contents may be sent to the configured model provider. The live provider adapter is integrated but has not yet had an end-to-end call verified in this implementation pass.

### Metadata, metrics, and review

Candidate metadata supports task ID, provider/model/mode, bounded error and recovery summaries, applicability, preconditions, expected outputs, verification steps, low/medium/high risk, limitations, and explicit user-feedback sentiment/summary. Metadata and feedback are bounded and redacted before persistence. Free-text feedback is stored for review but is not inserted into generated skill instructions.

Metrics add immutable content-version IDs, invocation and success/failure counts, elapsed time, retry counts, independent replay validation, bounded user-feedback counts/summaries, provider/model/mode, and task IDs. Stats are stored under a per-workspace hashed path so identically named skills in separate workspaces do not contaminate each other's metrics. Legacy global counters are not automatically imported because their originating workspace cannot be reliably reconstructed.

The compare command reports success rate, average duration, validation pass rates, retry counts, feedback ratios, and conservative potential regressions/improvements. It labels missing or small samples as insufficient and does not infer equivalence when thresholds are not crossed. Provider billing/cost is not yet measured.

Explicit feedback can be recorded against one version. Synthesizing revised content creates another immutable version; feedback does not change evaluation or activation. Promotion, rollback, disable, and retire continue to require the existing approval rules.

## CLI examples

- `superagent skill synth "Describe the workflow" --name workflow-helper --workspace <path> [--evidence-id <task-completed-event-id>]`
- `superagent skill candidates --workspace <path>`
- `superagent skill evaluate workflow-helper@<12-char-version> --workspace <path> [--evidence-id <task-completed-event-id>]`
- `superagent skill replay workflow-helper@<12-char-version> --fixture fixtures/workflow-helper.json --workspace <path> [--timeout-ms 120000]`
- Review the artifact and successful exact-version replay, then run `superagent skill promote workflow-helper@<12-char-version> --workspace <path>` and type the exact confirmation.
- `superagent skill compare workflow-helper <version-a> <version-b> --workspace <path>` (content diff and effectiveness comparison if samples exist)
- `superagent skill feedback workflow-helper@<12-char-version> negative --summary "Needs another verification step" --workspace <path>`
- `superagent skill rollback workflow-helper@<previous-version> --workspace <path>`
- `superagent skill disable workflow-helper --workspace <path>`
- `superagent skill retire workflow-helper@<version> --reason <reason words> --workspace <path>`

Replay fixture JSON supplies a name/description/task prompt, bounded synthetic initial files, and final-state checks. Keep the fixture minimal and do not place secrets, real customer data, credentials, or unrelated project files in it. The programmatic entry point `replaySkillCandidate(workspace, name, version, fixture, trustedExecutor, options)` is also available for deterministic evaluation.

## Verification

- `bun run build` — passed.
- `bunx vitest run tests/skillReplay.test.ts tests/skillReplayAgent.test.ts tests/skillReplayExecutor.test.ts tests/skillLifecycle.test.ts tests/skillSynthesizer.test.ts tests/skillTracker.test.ts tests/skillRoutes.test.ts tests/selfdevAndGatewaySuite.test.ts` — 8 files, 71 tests passed.
- Tests cover disposable workspaces, postconditions, traversal/symlink controls, syntax parsing without execution, the adapter's exact five-tool surface, cancellation, fixture loading, exact-version replay history, activation denial without successful replay, failed-replay blocking and corrected retry, metadata checksum/migration, workspace metric isolation, feedback redaction, and sample-size-aware regression comparisons.
- Build and focused tests passed; run `git diff --check` and wiki validation after this documentation update.

## Still open before Phase 2 completion

- Run a live provider end-to-end smoke test using only a synthetic fixture, confirm cancellation/deadline and token/provider metadata, and verify no data is written outside the disposable workspace. Focused tests mock the AI SDK; this real-provider verification remains open.
- Derive provider/model/mode, retries, changed-file summaries, and linked Selfdev task evidence from trustworthy production task events rather than relying solely on optional caller-supplied metadata.
- Expand contextual/adversarial injection and generalization checks; detect duplicate/conflicting workflows and define a clearer policy for medium-risk candidates.
- Add provider billing/cost instrumentation and more complete latency/iteration metrics where reliable data is available.
- Add an evidence-backed revise/refine experience linking reviewer feedback to a new immutable version and comparing replay/evaluation history.
- Continue Phase 1 memory retrieval-quality and live-provider checks; this increment does not mark those gates complete.

## Compatibility and rollback

The active skill remains at `.agents/skills/<name>/SKILL.md`. Use the lifecycle CLI to disable a managed active skill so its hash can be verified and history retained. Existing unmanaged active skills are preserved and cannot be overwritten by promotion. Do not manually copy candidates into the active tree to bypass evaluation or approval.

This records a bounded Phase 2 increment, not completion of every Hermes-like capability or all Phase 2 acceptance criteria.
