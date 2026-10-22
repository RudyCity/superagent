# Context Compaction P1–P3

## Architecture

All context compaction uses `ContextManager` and the existing `SummarizationStrategy`, `PinningStrategy`, `PruningStrategy`, `BudgetedPruningStrategy`, and RMemory integration.

`ContextContinuityStore` adds a **structured checkpoint** (current goal, decisions, completed and pending checklists, blockers, referenced files, tool names, verification evidence, and prior session summary). Checkpoints reflect observed context; they do not assert that an action succeeded without recorded evidence.

A **quality gate** runs before replacing the conversation. A compacted result that loses the active user request is rejected and the ContextManager can try emergency recovery. An aborted operation never invokes destructive recovery.

### Memory hierarchy

- **Working memory**: active goal, pending tasks, blockers. These must be available on the active turn.
- **Session memory**: after the transcript is **successfully saved**, the checkpoint is separately persisted in the per-session continuity sidecar, alongside snapshot metadata. Use `/compact memory` to inspect it. `RMemoryStrategy` may load this checkpoint as **current-session evidence only** when the active goal still matches; changing the provider retains project/session identity.
- **Project memory**: candidate durable decisions, subject to **explicit review**. RMemory already handles project/global records. The checkpoint is **not** automatically promoted to a project or global atomic memory. No external embedding request is required to read a local checkpoint.

### Snapshot and recovery

Before an accepted compaction, the ContextManager stores the prior transcript in a compressed **per-session** sidecar next to the session history key: `<history-file>.compaction.gz`. The latest three snapshots are retained, and the compressed file is created with owner-only permissions on supporting systems. Snapshots are capped at 12 MiB uncompressed per snapshot and 8 MiB compressed per store. When no history path is available, snapshots are in-memory only. They are not encrypted; protect local session directories as you would conversation history.

On a CLI/T-Line restart or a resumed session referencing the same history file, the store reloads snapshots and associated metrics. Restoration is **explicit** via `/compact undo`; no old state is silently substituted for current work. The restore is persisted to the session history.

### Adaptive compaction and result retention

The model-aware threshold remains; a tool result over 16,000 characters triggers an earlier threshold (85%), and emergency fallback reserves additional headroom. Aged outputs now use **typed evidence extraction**: known JSON keys such as `status`, `code`, `error`, `file`, and `count`; diagnostic lines, paths, and final exit output in text. Credentials/secret-like keys are excluded from previews. This is an evidence extraction heuristic, **not** a semantic LLM verifier.

Before truncating an aged result, the original is copied to the local, session-scoped SQLite `compaction_tool_archive` (only when its UTF-8 size is at most **512 KiB**). A marker in the shortened result includes the archive ID only after a successful archive write. Inspect pages explicitly with `/compact tool <archive-id> [offset]`. Archive scope hashes the **full normalized history path**, so same-named sessions in different workspaces cannot read each other's originals. Retention: at most **40 archives per session**, maximum **30 days**. Old/oversized results may not have an archived original; the preview says so. The SQLite DB can contain sensitive output—protect it with the same precautions as regular transcripts; no project-directory dump or auto-upload is created.

### Observability and validation

The ContextManager tracks counts, total token savings, cumulative duration, failures, latest strategy, fallback and quality score. The CLI/T-Line compaction event includes a quality indicator. Quality checks report missing active goals and warnings about prior summaries or tool-result pairing. A result with a missing active goal is not accepted.

### CLI and T-Line commands

| Command | Behavior |
|---|---|
| `/compact` or `/compact status` | Context usage, threshold, metrics and last strategy |
| `/compact preview` | Read-only structured checkpoint and memory hierarchy |
| `/compact now` | Run compaction, validate, store pre-compaction snapshot, persist result |
| `/compact snapshots` | List undo snapshots from current session |
| `/compact undo [id]` | Restore newest or selected pre-compaction snapshot and save |
| `/compact benchmark` | Run deterministic in-memory pruning dry-run, without changing history |
| `/compaction-history` | Existing audit trail |

### Benchmark

Run `bun scripts/bench-compaction.ts` for human-readable output or `bun scripts/bench-compaction.ts --json` for JSON. The script evaluates three synthetic session sizes (50, 200, 600 turns), captures elapsed time and byte reduction, verifies that the original transcript is not mutated, and fails if the active goal is lost. This is a **local synthetic benchmark**; it does not replace real provider cost, latency, token or quality measurements.

### Safety and constraints

- Automatic project memory promotion is intentionally excluded until user review.
- Old summaries are rolled forward into newer summaries, rather than silently dropped.
- Snapshot records can include sensitive conversation data; do not upload sidecars to public repositories.
- Undo reverts the conversation transcript, not filesystem edits, payment actions, terminal processes or external calls; safe undo requires a matching saved transcript checksum. `--force` must be an explicit decision.
- Compaction records, token-saved metrics, and completion events are confirmed **after session history saving**, not when summarization merely finishes.
- Compaction quality checks explicit decisions, pending checklists, blockers, and current goal; they are evidence checks, not proof that the next LLM answer will be correct.
- Snapshot size caps may prevent rollback of extremely large contexts. The `/compact snapshots` command is the source of truth for availability.
- Tests should cover CLI restore, multi-round compaction, persistence, permission checks and catastrophic-failure recovery. Regression tests are maintained in `tests/contextContinuity.test.ts` and existing compaction suites.
