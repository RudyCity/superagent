# Selfdev: Default-On Learning and Operations

Selfdev collects bounded evidence about Superagent task execution, proposes operational lessons, and can inject lessons that a human has explicitly approved. It is enabled by default for new configurations and uses a versioned one-time migration for older settings.

## Safety model

- **Enabled does not mean autonomous self-modification.** The system can collect evidence and propose candidate lessons; it does not approve candidates automatically.
- Only valid, active lessons that have approval metadata and match the exact workspace are eligible for prompt injection.
- Task/event data and lesson files are local to the configured Superagent environment. Secret redaction is mandatory before event persistence and backup text fields receive an additional redaction pass.
- Selfdev errors are best-effort: they must not fail the user's main task.
- `selfdev disable` disables collection, distillation, and prompt injection through the master switch. Existing events and lessons are retained; disabling is not data deletion.
- Diagnostic commands are read-only. They do not delete locks, rewrite lesson stores, or run automatic repair.
- Backup restore is an explicit maintenance operation, separate from normal learning. It is a dry run unless `--apply` is provided and refuses to restore into a workspace containing Selfdev records.

## Default and upgrade behavior

New installations inherit the Selfdev default-on configuration. Older configurations are migrated once to the new configuration version. Because the older format stored only `enabled: false`, it cannot tell whether that value represented the old default or a deliberate opt-out. In the one-time migration, legacy values without the new explicit `userOptOut` marker are enabled. The new `selfdev disable` command records an explicit opt-out that persists across restarts and configuration writes. `selfdev enable` clears that opt-out.

Inspect the effective configuration after upgrading:

```sh
superagent selfdev status
```

## Commands

The CLI and `/selfdev` slash command support lifecycle operations and the maintenance commands listed below. Maintenance commands are also registered through slash-command dispatch.

| Command | Purpose |
|---|---|
| `selfdev status` | Show effective settings and candidate/active/retired counts |
| `selfdev enable` | Enable Selfdev and clear the explicit opt-out |
| `selfdev disable` | Disable Selfdev and persist the explicit opt-out |
| `selfdev doctor` | Run read-only config, workspace, history database, lesson-store, and lock checks |
| `selfdev metrics` | Show workspace-scoped stored events, lesson counts, feedback, and current-process counters |
| `selfdev list [candidate|active|retired]` | List lessons, optionally filtered by lifecycle state |
| `selfdev inspect <lesson_id>` | Inspect evidence references, source signals, workspace, status, and approval provenance |
| `selfdev distill [max]` | Manually distill recent evidence into candidate lessons |
| `selfdev review` | Interactively review candidate lessons |
| `selfdev approve <lesson_id> [version]` | Approve a candidate after evidence/version checks |
| `selfdev reject <lesson_id> [reason]` | Reject a candidate and preserve a bounded review decision |
| `selfdev retire <lesson_id> [reason]` | Stop injecting an active lesson and audit the retirement |
| `selfdev feedback <lesson_id> <applied|helped|harmed> [session_id]` | Record an explicit outcome for an active lesson |
| `selfdev lesson-metrics <lesson_id>` | Show per-lesson feedback counts and the last feedback timestamp |
| `selfdev decisions [limit]` | Show recent workspace-scoped review audit decisions, newest first |
| `selfdev export <output.json> [--overwrite]` | Export a redacted, versioned workspace backup |
| `selfdev backup <output.json> [--overwrite]` | Alias for export |
| `selfdev restore <backup.json> [--apply]` | Validate a backup; dry-run by default, apply only into an empty target |
| `selfdev retention --days <N> [--apply]` | Preview or delete old events while preserving all lesson-referenced evidence |

Example commands:

```sh
superagent selfdev doctor
superagent selfdev metrics
superagent selfdev list candidate
superagent selfdev inspect <lesson_id>
superagent selfdev distill
superagent selfdev review
superagent selfdev approve <lesson_id>
superagent selfdev feedback <lesson_id> helped
superagent selfdev lesson-metrics <lesson_id>
superagent selfdev decisions 50
superagent selfdev export ./selfdev-backup.json
superagent selfdev restore ./selfdev-backup.json
superagent selfdev retention --days 90
```

Equivalent slash examples include `/selfdev status`, `/selfdev inspect <lesson_id>`, `/selfdev feedback <lesson_id> helped`, `/selfdev decisions 50`, `/selfdev export ./selfdev-backup.json`, and `/selfdev retention --days 90`.

## Evidence, provenance, and review hints

Use `selfdev inspect <lesson_id>` or `/selfdev inspect <lesson_id>` before approving a candidate. It shows bounded event summaries only for evidence found in the exact workspace, plus evidence IDs that are missing or unavailable. It also reports source tags and approval actor/time or retirement metadata. Evidence summaries shown by the CLI redact URLs and common credential token formats. Production approval rejects a lesson when the configured trusted event store cannot verify every evidence reference.

Human review outcomes are recorded in the lesson store as a bounded audit trail: workspace, lesson ID/version, action, actor, timestamp, and a redacted reason. Existing stores without the optional audit field remain readable. The audit is capped at 500 entries. At the cap, new lifecycle decisions fail explicitly rather than silently evicting older audit history; export the workspace before defining a separate audit-retention policy.

Evidence count, source type, and explicit feedback are transparent review signals, not calibrated probability. No numeric confidence score is exposed. The `near_duplicate_review` tag is a token-overlap hint that incorporates a small list of contradiction/polarity cues; it does not merge, reject, approve, or activate a candidate. Human review remains mandatory.

## Feedback meaning

Stored metrics are scoped to the exact workspace. Feedback rows are deduplicated by workspace, session, lesson, lesson version and metric. `recordDetailed` reports whether a row was newly inserted, a duplicate, disabled, invalid, or not recorded due to a storage error. A CLI feedback command makes a unique manual session ID by default; pass a stable `session_id` only when intentionally retrying the same assessment idempotently.

- `injected` means an active eligible lesson was actually included in a prompt.
- `applied` records an explicit/verifiable usage signal; it should not be inferred from task completion alone.
- `helped` and `harmed` are explicit outcome assessments, not automatic judgements based only on success/failure.
- Per-lesson metrics show counts and last signal time. They are review signals and do not imply a confidence probability.

A workspace with no active eligible lessons can correctly report zero injected signals; check active-lesson count before diagnosing the feedback path.

## Backup, restore, and retention

The export format `superagent-selfdev-backup` version 1 includes a manifest with creation time, exact workspace, counts, a redacted marker, and SHA-256 checksum. The bundle contains event records, lessons, feedback records, and review audit entries. Textual fields have an extra redaction pass for common credential/token forms, sensitive payload keys are masked, and URLs are replaced in export text. A backup is bounded by byte/record limits and written through a temporary file followed by rename. Existing destinations are refused unless `--overwrite` is explicitly supplied.

Restore validates the bundle checksum, schema/version, record counts, workspace identity, event structure, lesson schemas and evidence links, duplicate IDs, feedback keys, and review decisions before changing data. It is **dry run only by default**. `--apply` first creates a pre-restore backup and applies data only if the target workspace has no events, lessons, feedback, or review audit entries. Restore refuses to overwrite/merge a populated target. The CLI must be run from the intended workspace so exact workspace matching is clear.

Retention is also **dry run only by default**. `retention --days 90` reports old events and those that could be deleted. Adding `--apply` deletes only events older than the cutoff that are not referenced by any candidate, active, or retired lesson. It does not delete lessons or feedback. Feedback retention is not automatic; set its policy separately before any feedback rows are removed.

## Understanding metrics

Stored metrics are scoped to the exact workspace. Event rows are kept in the shared local history database; lessons and review decisions are kept in the configured Selfdev lesson store. Reports separate counts for candidate, active, and retired lessons.

Runtime counters such as recording attempts, errors, coalesced distillations, and distillation duration belong to the current process and reset on restart. Zero stored events can mean no event has been recorded; the `Storage query` status must also be checked before interpreting zero as a healthy empty store.

## Similarity evaluation

Run the synthetic labeled regression set:

```sh
bun run scripts/evaluate-selfdev-similarity.ts
```

The current 18-pair synthetic fixture (8 near-duplicate pairs and 10 different/opposite-policy pairs) reports TP=8, FP=0, TN=10, FN=0 at token-overlap threshold 0.35. This small synthetic result is **not** a production-quality accuracy estimate. Before making production claims or increasing autonomy, evaluate on a larger sanitized dataset labeled by humans, including subtle contradictions and lessons with differing scope. Similarity can only flag candidates for review.

## Troubleshooting

1. Run `superagent selfdev doctor` first. It is read-only and reports sanitized check results.
2. Check `superagent selfdev status` for the effective master switch, collection/injection toggles, migration version, and explicit opt-out.
3. Use `superagent selfdev metrics` to separate stored evidence counts from current-process counters.
4. If the lesson store has a lock file, doctor warns but will not delete it. Candidate-store recovery only removes a lock when metadata identifies a local process that the operating system positively reports as no longer running; unknown and live owners are left untouched.
5. Review evidence and content before approval. Never approve a lesson that asks the agent to bypass permissions, change its authority, reveal secrets, or override higher-priority instructions.
6. If restore validation fails, do not edit the checksum to force an import. Re-export from the source or resolve the reported schema/evidence issue first.
7. Retention preview reports only the eligible event IDs/count; do not use `--apply` until a recent backup has been verified.

## Performance baseline

Run the synthetic local benchmark with:

```sh
bun run scripts/bench-selfdev.ts
```

It measures SQLite event writes (single and batch), prompt injection across a 500-lesson synthetic store before/after the filter-order optimization, a reference path without per-lesson validation, and a 500-candidate/no-active path. The recorded Bun 1.4.2 / Windows x64 sample dropped prompt-injection p95 from 1.852 ms to 0.833 ms (55% faster) with five active lessons. The benchmark uses no real task content, network, or model calls. Compare only on the same machine/runtime, and record p50/p95 plus workload details before making performance claims.
