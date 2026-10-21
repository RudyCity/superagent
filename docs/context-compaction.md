# Context Compaction P1–P3

## Architecture

All context compaction uses `ContextManager` and the existing `SummarizationStrategy`, `PinningStrategy`, `PruningStrategy`, `BudgetedPruningStrategy`, and RMemory integration.

`ContextContinuityStore` adds a **structured checkpoint** (current goal, decisions, completed and pending checklists, blockers, referenced files, tool names, verification evidence, and prior session summary). Checkpoints reflect observed context; they do not assert that an action succeeded without recorded evidence.

A **quality gate** runs before replacing the conversation. A compacted result that loses the active user request is rejected and the ContextManager can try emergency recovery. An aborted operation never invokes destructive recovery.

### Memory hierarchy

- **Working memory**: active goal, pending tasks, blockers. These must be available on the active turn.
- **Session memory**: checkpointed decisions, completed work, referenced files, and verified outcomes. A compressed session snapshot can be restored.
- **Project memory**: *candidate* durable decisions, subject to explicit review. RMemory already handles project/global memory; this feature does **not** automatically promote unverified text into project memory.

### Snapshot and recovery

Before an accepted compaction, the ContextManager stores the prior transcript in a compressed **per-session** sidecar next to the session history key: `<history-file>.compaction.gz`. The latest three snapshots are retained, and the compressed file is created with owner-only permissions on supporting systems. Snapshots are capped at 12 MiB uncompressed per snapshot and 8 MiB compressed per store. When no history path is available, snapshots are in-memory only. They are not encrypted; protect local session directories as you would conversation history.

On a CLI/T-Line restart or a resumed session referencing the same history file, the store reloads snapshots and associated metrics. Restoration is **explicit** via `/compact undo`; no old state is silently substituted for current work. The restore is persisted to the session history.

### Adaptive compaction and result retention

The normal model-aware context threshold remains. When a conversation has an individual tool result over 16,000 characters, its compaction threshold is reduced to 85%; after heuristic fallback it receives an additional reserve. Large, aged tool outputs now retain the first lines, actionable error/success/changed-state lines, and final lines, plus a marker directing agents to session/tool logs for complete evidence. The complete tool output should remain available via original logs if that tool provides logging.

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
- Undo reverts the conversation transcript, not filesystem edits, payment actions, terminal processes or external calls.
- Snapshot size caps may prevent rollback of extremely large contexts. The `/compact snapshots` command is the source of truth for availability.
- Tests should cover CLI restore, multi-round compaction, persistence, permission checks and catastrophic-failure recovery. Regression tests are maintained in `tests/contextContinuity.test.ts` and existing compaction suites.
