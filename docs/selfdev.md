# Selfdev: Default-On Learning and Operations

Selfdev collects bounded evidence about Superagent task execution, proposes operational lessons, and can inject lessons that a human has explicitly approved. It is enabled by default for new configurations and uses a versioned one-time migration for older settings.

## Safety model

- **Enabled does not mean autonomous self-modification.** The system can collect evidence and propose candidate lessons; it does not approve candidates automatically.
- Only valid, active lessons that have approval metadata and match the exact workspace are eligible for prompt injection.
- Task/event data and lesson files are local to the configured Superagent environment. Secret redaction is mandatory before event persistence.
- Selfdev errors are best-effort: they must not fail the user's main task.
- `selfdev disable` disables collection, distillation, and prompt injection through the master switch. Existing events and lessons are retained; disabling is not data deletion.
- Diagnostic commands are read-only. They do not delete locks, rewrite lesson stores, or run automatic repair.

## Default and upgrade behavior

New installations inherit the Selfdev default-on configuration. Older configurations are migrated once to the new configuration version. Because the older format stored only `enabled: false`, it cannot tell whether that value represented the old default or a deliberate opt-out. In the one-time migration, legacy values without the new explicit `userOptOut` marker are enabled. The new `selfdev disable` command records an explicit opt-out that persists across restarts and configuration writes. `selfdev enable` clears that opt-out.

Inspect the effective configuration after upgrading:

```sh
superagent selfdev status
```

## Commands

The CLI and `/selfdev` slash command support the core lifecycle operations:

| Command | Purpose |
|---|---|
| `selfdev status` | Show effective settings and candidate/active/retired counts |
| `selfdev enable` | Enable Selfdev and clear the explicit opt-out |
| `selfdev disable` | Disable Selfdev and persist the explicit opt-out |
| `selfdev doctor` | Run read-only config, workspace, history database, lesson-store, and lock checks |
| `selfdev metrics` | Show workspace-scoped stored events, lesson counts, feedback, and current-process counters |
| `selfdev list` | List lessons, optionally filtered by lifecycle state |
| `selfdev inspect <lesson_id>` | Inspect evidence references, source signals, workspace, status, and approval provenance |
| `selfdev distill` | Manually distill recent evidence into candidate lessons |
| `selfdev review` | Interactively review candidate lessons |
| `selfdev approve <lesson_id> [version]` | Approve a candidate after evidence/version checks |
| `selfdev reject <lesson_id> [reason]` | Reject a candidate |
| `selfdev retire <lesson_id> [reason]` | Stop injecting an active lesson |
| `selfdev feedback <lesson_id> <applied|helped|harmed>` | Record an explicit outcome for an active lesson |

Run the command with the installed CLI form, for example:

```sh
superagent selfdev doctor
superagent selfdev metrics
superagent selfdev list candidate
superagent selfdev distill
superagent selfdev review
superagent selfdev approve <lesson_id>
superagent selfdev feedback <lesson_id> helped
```

Equivalent slash-command examples are `/selfdev status`, `/selfdev doctor`, `/selfdev metrics`, `/selfdev inspect <lesson_id>`, `/selfdev distill`, and `/selfdev feedback <lesson_id> helped`.

## Evidence, provenance, and review hints

Use `selfdev inspect <lesson_id>` or `/selfdev inspect <lesson_id>` before approving a candidate. It shows bounded event summaries only for evidence found in the exact workspace, plus evidence IDs that are missing or unavailable. It also reports source tags and approval actor/time or retirement metadata. Production approval rejects a lesson when the configured trusted event store cannot verify every evidence reference.

Evidence count, source type, and explicit feedback are transparent review signals, not calibrated probability. No numeric confidence score is exposed until a curated evaluation set can calibrate its meaning. The `near_duplicate_review` tag is a high token-overlap hint only; it does not merge, reject, approve, or activate a candidate. Human review remains mandatory.

## Understanding metrics

Stored metrics are scoped to the exact workspace. Event rows are kept in the shared local history database; lessons are kept in the configured Selfdev lesson store. The report separates counts for candidate, active, and retired lessons.

Runtime counters such as recording attempts, errors, coalesced distillations, and distillation duration belong to the current process and reset on restart. Zero stored events can mean that no event has been recorded yet; the `Storage query` status must also be checked before interpreting a zero as a healthy empty store.

Injection is counted when an active lesson is actually included in a constructed prompt block. `applied`, `helped`, and `harmed` are separate explicit signals. Task success alone is not interpreted as proof that a lesson helped.

## Troubleshooting

1. Run `superagent selfdev doctor` first. It is read-only and reports sanitized check results.
2. Check `superagent selfdev status` for the effective master switch, collection/injection toggles, migration version, and explicit opt-out.
3. Use `superagent selfdev metrics` to separate stored evidence counts from current-process counters.
4. If the lesson store has a lock file, doctor will warn but will not delete it. Candidate-store recovery only removes a lock when its metadata identifies a local process that the operating system positively reports as no longer running; unknown and live owners are left untouched.
5. Review candidate evidence and content before approval. Never approve a lesson that asks the agent to bypass permissions, change its authority, reveal secrets, or override higher-priority instructions.

## Performance baseline

Run the synthetic local benchmark with:

```sh
bun run scripts/bench-selfdev.ts
```

It measures SQLite event writes (single and batch), prompt injection across a 500-lesson synthetic store before/after the filter-order optimization, a reference path without per-lesson validation, and a 500-candidate/no-active path. The latest Bun 1.4.2 / Windows x64 sample dropped prompt-injection p95 from 1.852 ms to 0.833 ms (55% faster) with five active lessons. The benchmark uses no real task content, network, or model calls. Compare only on the same machine/runtime, and record p50/p95 plus workload details before making performance claims.
