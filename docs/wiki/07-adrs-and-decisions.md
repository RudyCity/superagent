# 07. Architecture Decision Records (ADRs)

This document records the foundational architectural decisions made in Superagent following the MADR (Markdown Architecture Decision Record) standard.

---

## ADR-001: 3-Tier Multi-Agent Hierarchy & Git Worktree Isolation

- **Status**: Accepted & Implemented
- **Date**: 2026-03-01
- **Deciders**: Architecture Core Team

### Context & Problem Statement
Direct LLM multi-file modifications in a single workspace often lead to file contention, broken intermediate builds, lost changes during rollback, and context window bloat when attempting complex features with multiple parallel roles.

### Decision
Implement a strict 3-tier hierarchy:
1. **Master Agent (Tier 1)**: Acts as the high-level planner and orchestrator in the main repository. Prohibited from editing files directly.
2. **Superagent (Tier 2)**: Allocated a dedicated Git worktree (`~/.superagent-r/worktrees/<name>`) and feature branch (`feature/<name>`) to build, run, and verify features in isolation.
3. **Subagent (Tier 3)**: Ephemeral agents (`researcher`, `coder`, `reviewer`, `tester`) that execute atomic sub-tasks inside the parent Superagent's worktree.

### Consequences
- **Positive**: Complete filesystem and git branch isolation between concurrent features. Zero risk of dirtying the main working tree.
- **Positive**: Clean context boundaries per tier.
- **Negative**: Requires Git 2.30+ worktree support on the host machine.

---

## ADR-002: SQLite as Single Source of Truth for Session Transcripts

- **Status**: Accepted & Implemented
- **Date**: 2026-04-15
- **Deciders**: Storage & Performance Team

### Context & Problem Statement
Storing conversation transcripts as large JSON files causes excessive disk I/O on every turn, makes cross-session full-text search inefficient, and risks data corruption on abrupt process exits.

### Decision
Migrate all chat transcripts, dialogue turns, tool calls, and execution metadata to SQLite (`~/.superagent-r/history.db`) with Write-Ahead Logging (WAL) and an FTS5 full-text search virtual table. Historical `.json` files are preserved as 0-byte markers solely for path resolution and artifact anchoring.

### Consequences
- **Positive**: ACID compliance prevents corrupted transcripts.
- **Positive**: Instant BM25 full-text search across millions of tokens via FTS5.
- **Positive**: Sub-millisecond turn persistence and indexing.

---

## ADR-003: Zero `process.env` Dependency for Configuration

- **Status**: Accepted & Implemented
- **Date**: 2026-05-10
- **Deciders**: Security & Runtime Team

### Context & Problem Statement
Relying on `.env` files and `process.env` variables created severe issues with credential leakage, multi-provider collision, tier model overrides, and background subagent state desynchronization.

### Decision
Completely eliminate `process.env` for all AI providers, API keys, presets, tier models, and system settings. Store all runtime configuration exclusively in `~/.superagent-r/model-config.json` accessed through typed helper functions in `src/core/config/jsonConfig.ts` and `src/core/config/providers.ts`.

### Consequences
- **Positive**: Clear multi-provider profiles with instant switching without restarting the process.
- **Positive**: Per-tier model assignments (e.g. Master uses Sonnet, Subagents use Haiku or Flash).
- **Positive**: Absolute security and isolation against accidental environment variable exposure.

---

## ADR-004: Serverless WebSocket Bridge for Remote Chrome Control

- **Status**: Accepted & Implemented
- **Date**: 2026-06-20
- **Deciders**: Integrations Team

### Context & Problem Statement
Automating browser tasks typically requires heavy Puppeteer or Playwright instances that consume gigabytes of RAM, cannot access existing user sessions/logins, and frequently encounter anti-bot bot-detection challenges.

### Decision
Implement a serverless WebSocket server (`src/core/tools/remoteChromeBridge.ts`) listening on `ws://127.0.0.1:9223`. Pair this with a lightweight Manifest V3 Chrome extension (`chrome-extension-remote/`) that developers install in their normal Chrome browser profile.

### Consequences
- **Positive**: Zero overhead; connects directly to the developer's active browser profile with pre-authenticated sessions.
- **Positive**: Fast DOM extraction, clicks, navigation, and screenshots without spawning headless processes.
- **Negative**: Requires the developer to have Chrome open with the remote extension installed when running browser tasks.

---

## ADR-005: Pluggable Context Window Compaction Architecture

- **Status**: Accepted & Implemented
- **Date**: 2026-07-12
- **Deciders**: Context Engine Team

### Context & Problem Statement
Long-running multi-agent coding sessions easily exceed 128k/200k token context limits. Uncontrolled truncation causes catastrophic loss of original user constraints and architectural plans.

### Decision
Build a centralized `ContextManager` with pluggable strategies:
1. **`PinningStrategy`**: Automatically detects and locks crucial architectural requirements and pinned items (`is_pinned = 1`).
2. **`SummarizationStrategy`**: Prompts the LLM (or uses heuristic fallback) to create structured semantic checkpoints for completed milestones.
3. **`PruningStrategy`**: Selectively strips large obsolete tool outputs while retaining summaries.

### Consequences
- **Positive**: Sessions can run indefinitely without hitting context limits or losing core instructions.
- **Positive**: Real-time token tracking calibrated to specific model tokenizers via `tiktoken`.
