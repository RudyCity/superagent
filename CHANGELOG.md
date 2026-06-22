# Changelog

All notable changes to this project will be documented in this file.

## [1.1.77] - 2026-06-23

### Added
- **Global Pinned Knowledge Store** (`pinnedKnowledge.ts`): Persistent, cross-session knowledge base. Pinned messages are now auto-exported to a global store, enabling knowledge sharing across all sessions and projects.
- **Full-Content Pin Storage**: Pinned messages now store complete, untruncated content along with agent tags (tier, subagent type, worktree), tool calls, tool results, and user-defined labels. Upgraded from `Set<string>` to `Map<string, PinnedMessage>`.
- **`/knowledge` Command** (alias: `/k`): Browse, search, and manage the global pinned knowledge store. Subcommands: `/knowledge` (list all), `/knowledge <query>` (search), `/knowledge projects` (list projects with pins).
- **`/pin view <index>`**: View the full, untruncated content of a pinned message with complete metadata (agent tag, timestamps, tool calls/results, content size).
- **`/pin tag <index> <label>`**: Tag a pinned message with a custom label. Tags sync to the global knowledge store.
- **Cross-Session History Search**: Added `--all` flag to `/search-history` (alias: `/sh`) and `cross_session` parameter to the `search_history` tool, enabling searches across ALL sessions and projects.
- **`search_pinned_knowledge` Tool**: AI agents can now search the global pinned knowledge base with query, working directory, and tag filters.
- **`load_pinned_session` Tool**: AI agents can load and study full conversation transcripts from past sessions that have pinned messages, enabling cross-session learning.
- **FastContext Enhanced Logging**: New live event types in FastContext output: `dedup` (redundant call deduplication), `retry` (automatic retries), `tool_start`/`tool_end` (tool execution tracking), `error`, and `done` (completion summary).

### Changed
- **`/pin` Command Overhaul**: Complete UI redesign with box-drawing borders, role icons, relative timestamps (`timeAgo()`), and improved formatting. Help text now documents all subcommands.
- **`/pin list`**: Now shows full pinned metadata including agent tags, content size, pinned timestamps, and global knowledge sync status.
- **`/pin <index>`**: Now stores full message content + agent tag and auto-exports to the global knowledge store.
- **`/pin unpin`**: Now also removes the entry from the global knowledge store.
- **FastContext Defaults**: Adjusted `maxTurns` default from 8 to 6 and timeout from 5 minutes to 3 minutes for faster, more focused exploration.
- **`search_history` Tool**: Updated description and added `cross_session` boolean parameter for cross-project search.

---

## [1.1.76] - 2026-06-22

### Added
- **Context Manager Overhaul**: Complete modular rewrite of the context management system, introducing a pluggable architecture for intelligent conversation compaction:
  - **`TokenTracker`**: Model-specific token counting with support for OpenAI (`tiktoken`) and Anthropic (`@anthropic-ai/tokenizer`) tokenizers. Provides accurate per-message and total token estimation.
  - **`CompactionStrategy` Interface**: Pluggable strategy pattern for compaction methods — includes `TruncationStrategy` (drop oldest messages), `SummarizationStrategy` (LLM-powered summarization with heuristic fallback), and `SemanticStrategy` (semantic-aware compaction via `SemanticAnalyzer`).
  - **`SemanticAnalyzer`**: Intelligent message scoring based on technical density, decision points, file references, and error context to preserve high-value messages during compaction.
  - **`CompactionHistory`**: Persistent audit trail of all compaction events, tracking tokens before/after, strategy used, timestamps, and messages preserved. Queryable via `/compaction-history`.
  - **`ContextManager` Orchestrator**: Central coordinator that monitors token usage, triggers automatic compaction when thresholds are exceeded, and exposes public API for manual compaction, pinning, and status queries.
- **`/compact now` Command**: Force manual compaction on demand. Shows tokens before/after, tokens saved, compaction count, and the strategy used.
- **`/pin` Command**: Pin important messages to prevent them from being compacted. Subcommands: `/pin list` (view pinned messages), `/pin last` (pin the last user message), `/pin unpin <id>` (remove a pin).
- **`/compaction-history` Command** (alias: `/ch`): View the full audit trail of compaction events with timestamps, strategies used, tokens saved, and messages preserved.
- **LLM-Powered Summarization**: `SummarizationStrategy` now uses `generateText` (Vercel AI SDK) for real LLM-based conversation summaries, with 3-retry logic and heuristic fallback. Prompt is engineered to preserve file paths, technical decisions, and code snippets.
- **Autocomplete Suggestions**: Tab-completion support for `/compact now`, `/pin list`, `/pin last`, `/pin unpin` in the input bar.

### Changed
- **StatusBar Token Display**: Now reads from `ContextManager.getTokenTracker()` for accurate, real-time context usage statistics instead of legacy estimation.
- **`/setting-context-limit`**: Refreshes ContextManager's compaction threshold in real-time when the context window limit is changed.
- **`/model` Command**: Automatically refreshes the ContextManager's tokenizer when the active LLM model is switched.
- **`/compact` (no args)**: Now shows ContextManager status including compaction count, total tokens saved, current state, and last strategy used.

### Tests
- Added integration tests for the full ContextManager lifecycle (init, compact, pin, history).
- Fixed async ContextManager initialization to prevent race conditions in tests.
- All 50 tests passing.

---

## [1.1.71] - 2026-06-22

### Added
- **FastContext Multi-Provider Support via LiteLLM**: The Python runner (`fastcontext_runner.py`) now uses LiteLLM as a unified adapter to support OpenAI, Anthropic, OpenRouter, and custom providers. Falls back to the native OpenAI SDK if LiteLLM is not installed.
- **LiteLLM Dependency in Setup Scripts**: Both `setup-fastcontext.ps1` (Windows) and `setup-fastcontext.sh` (Linux/macOS) now install and verify `litellm>=1.74.0` alongside existing dependencies.
- **Provider-Aware Fallback Models**: `resolveFastContextCredentials()` now returns `providerType`, `providerName`, `tierName`, and `providerMismatch` metadata, and uses `DEFAULT_FALLBACK_MODELS` to pick sensible default models per provider type (OpenAI → `gpt-4o`, Anthropic → `claude-sonnet-4-20250514`, OpenRouter → `anthropic/claude-sonnet-4-20250514`).
- **Unique Trajectory Paths**: Each FastContext invocation now generates a unique trajectory JSONL file (`trajectory-<timestamp>-<random>.jsonl`) in `.fastcontext/`, preventing collisions during concurrent runs. Stale trajectory files are automatically cleaned up before and after each run.
- **Live Model/Provider Info in Logs**: FastContext now displays the resolved model name, tier, provider name, and provider type at the start of each run, along with a warning if the tier's configured provider was not found and a fallback was used.
- **Backend Info in Start Events**: The `start` event in live logging now includes a `backend` field indicating whether LiteLLM or the native OpenAI SDK is being used.

### Changed
- **Improved Tier Resolution Logic**: The credential resolver now explicitly checks `researcher.model`, `subagentDefault.model`, and falls back to the main tier (`master`/`superagent`), with clear tier name tracking. Provider mismatch is detected and flagged when the tier specifies a `providerProfileId` that doesn't exist.
- **CLI Args Extended**: FastContext runner now accepts `--trajectory-path` and `--provider` flags for explicit trajectory file location and provider type selection.
- **Tool Description Updated**: The FastContext tool description now accurately reflects the tier resolution order: `researcher > subagentDefault > main fallback`.

---

## [1.1.70] - 2026-06-21

### Added
- **Version Display in Multi-Agent Dashboard**: The dashboard header now shows the current Superagent version (e.g. `MULTI-AGENT SYSTEM v1.1.70`), read dynamically from `package.json` at runtime.

### Changed
- **Reduced Visible Process Slots**: `maxProcsVisible` decreased from 5 to 3 in both the single-agent app and multi-agent dashboard to save vertical space on smaller terminals.
- **Expanded `/terminal` Help Text**: Help output now documents additional `/terminal` subcommands: `/terminal all` (launch all presets), `/terminal init` (AI-guided preset setup), `/terminal preset` (list presets), `!<command>` shortcut syntax, and the background/stop commands.

---

## [1.1.69] - 2026-06-21

### Changed
- **Full Settings Migration to JSON Config**: All system settings (concurrency limit, rate limit RPM/capacity, streaming toggle, context window limit, max iterations) now read exclusively from `getSettings()` in `model-config.json` instead of `process.env`. This completes the migration started in v1.1.66.
- **Rate Limiter**: `SharedRateLimiter` now reads `rateLimitRpm` and `rateLimitCapacity` from `getSettings()` instead of `process.env.SUPERAGENT_RATE_LIMIT_*`.
- **Concurrency Checks**: `agent.ts`, `masterAgent.ts`, and `historySearch.ts` now use `getSettings().concurrencyLimit` instead of `process.env.SUPERAGENT_MAX_CONCURRENCY`.
- **Streaming Display**: Dashboard and login wizards now read `getSettings().disableStreaming` instead of `process.env.DISABLE_STREAMING`.
- **`.env.example`**: Rewritten in English, simplified to show only optional runtime overrides. Rate limit and concurrency settings removed (now managed via `/settings` slash command and `model-config.json`).

### Removed
- **`src/core/config/env.ts`**: Deleted entirely. The `updateEnvFile()` function no longer exists. All configuration flows through `jsonConfig.ts` functions (`getSettings()`, `updateSettings()`, `addProvider()`, etc.).
- **`process.env` Sync in `updateSettings()`**: Removed the backward-compatibility block that wrote settings back to `process.env` after updating JSON config.

### Fixed
- **AGENTS.md Guidelines**: Updated to reflect the complete removal of `process.env` for settings, expanded the list of forbidden env vars, and documented `getSettings()` / `updateSettings()` as the canonical settings API.

### Tests
- Updated `configJson.test.ts`, `rateLimiter.test.ts`, `slashCommands.test.ts`, and `providerCredentialResolution.test.ts` to use `updateSettings()` / `getSettings()` instead of `process.env` manipulation and `updateEnvFile()`.

---

## [1.1.63] - 2026-06-20

### Added
- **Checkpoint Delete**: New `/checkpoint delete` command and interactive wizard action to delete individual checkpoints by ID. Supports both slash command (`/checkpoint delete <id>`) and interactive wizard selection.
- **Checkpoint Wizard Sub-Menu**: The checkpoint wizard now shows a contextual sub-menu after selecting a checkpoint, offering "Restore" or "Delete" actions (browse mode). Direct `/checkpoint restore` and `/checkpoint delete` commands open pre-filtered wizards.
- **Auto-Checkpoint UI Event**: Added `checkpoint_auto` event type that emits a visible system notification in the terminal UI whenever an auto-checkpoint is created (e.g., before destructive operations).
- **Ctrl+P in Multi-Agent Dashboard**: Added `Ctrl+P` keyboard shortcut in the multi-agent dashboard to open the interactive checkpoint browser wizard.
- **`deleteCheckpointById()`**: New function in `checkpoints.ts` that safely deletes a single checkpoint file by its ID.

### Changed
- **Checkpoint List Wizard**: `/checkpoint list` and `/checkpoint` (no args) now open the interactive wizard instead of printing a static list.
- **Checkpoint Wizard State Machine**: Refactored wizard to use action-based state machine (`browse` → `choose` → `restore`/`delete`) for cleaner flow in both single-agent and multi-agent modes.

### Fixed
- **Translated Remaining ID Strings**: Translated leftover Indonesian strings in checkpoint restore messages (e.g., "Git restore gagal" → "Git restore failed") to English for consistency.

---

## [1.2.0] - 2026-06-19

### Added
- **Safe Merge Strategy v2**: Complete rewrite of the merge system to prevent file corruption:
  - **Line-Based Conflict Resolution**: Safe auto-resolution for trivial conflicts (empty side, identical sides, subset sides) before falling back to manual resolution.
  - **Universal Post-Merge Validation**: 5 validation checks run before every commit: conflict marker detection, duplicate adjacent lines, duplicate attributes, line merging detection, and diff sanity check.
  - **Project-Level Validation**: Automatically runs the project's own build/test/lint scripts after merge.
  - **Auto-Revert on Failure**: If validation fails, the merge is automatically reverted before committing.
- **Patch Mode** (`mode: 'patch'`): Lightweight Superagent mode that skips worktree creation for small, targeted fixes. Operates directly in the parent's working directory with safety warnings for uncommitted changes.
- **Base Branch** (`baseBranch`): New parameter for `invoke_superagent` to create worktrees from a specific branch instead of HEAD. Useful for building dependent features on top of in-progress work.
- **Detailed Merge Error Reporting**: `MasterAgent.lastMergeErrors` and `lastMergeWarnings` properties expose detailed error/warning information from failed merges.
- **Auto-Create Task File**: `manage_plan` action `create` now auto-creates a minimal `_task.md` if no checklist tasks are found in the plan.

### Changed
- **Stateless Spawned Agents**: All spawned Superagents now start with `planState = "APPROVED"` to prevent self-blocking on plan state checks. This fixes the "Plan pending approval" bug where agents would block themselves.
- **No LLM Auto-Resolve**: Removed LLM-based conflict auto-resolution entirely. Complex conflicts are now aborted and reported for manual resolution to prevent corruption.
- **Task File No Longer Blocks**: Missing `_task.md` no longer blocks `invoke_superagent` or `merge_superagents`. The file is auto-created from plan content or a minimal placeholder.
- **Master Agent System Prompt**: Updated to document patch mode, baseBranch, and the new merge strategy.

### Fixed
- **Merge HTML Corruption** (root cause): Fixed the recurring issue where LLM auto-resolve would corrupt HTML files during merge by removing auto-resolve and adding universal validation.
- **Agent Plan State Confusion**: Fixed spawned agents blocking themselves by reading plan state from conversation history. Agents are now stateless executors.
- **Task File Blocking**: Fixed `invoke_superagent` failing with "Task Tracking File is missing" error when `_task.md` didn't exist yet.
- **Worktree Branch Confusion**: Fixed agents spawning from the wrong branch by adding the `baseBranch` parameter.
- **Diff Sanity Threshold**: Fixed off-by-one error in diff sanity check (`> 10` → `>= 10`).

### Tests
- Added 15 new tests for universal post-merge validation (`tests/postMergeValidation.test.ts`).
- Added 3 new tests for patch mode, baseBranch, and stateless agent behavior.
- Updated existing tests to match new merge behavior (no auto-resolve, validation-first).
- **Total: 47 test files, 400 tests passing.**

---

## [1.1.61] - 2026-06-18

### Added
- **Tools Error Logging**: Added dedicated error log file (`tools-error.log`) for tool execution errors across all tiers. Logs blocked file writes, permission denials, out-of-bounds access, invalid plan structures, and unknown tool calls with tier/depth metadata for better debugging.

---

## [1.1.45] - 2026-06-13

### Fixed
- **Multi-Agent Console**: Restored a dynamic loading/processing spinner (`⚡ PROCESSING`) in the Master Orchestrator log view and set its status to `ACTIVE` (yellow) in the workspace registry list when background agents (Superagents/Subagents) or processes are still running, ensuring clear visibility when the main orchestrator thread is idle but background execution is active.

---

## [1.1.44] - 2026-06-13

### Added
- **AI Model Speed Tracking**: Added generation speed metrics to both single-agent and multi-agent CLI footers.
- **Scrollable Dashboards**: Implemented scrolling support for active tasks, active agents, and active processes in the multi-agent CLI dashboard to prevent layout overflow.
- **Real-Time Text Streaming**: Implemented real-time model text streaming and UI notifications for subagents and superagents.
- **Custom Provider Resolution**: Supported dynamic resolution of custom provider prefixes in `getModelInstanceForString`.
- **Multi-Agent Active Task Mapping**: Added active superagent status mapping to task lists to automatically reflect real-time task progress.

### Fixed
- **CLI Footer Model Display**: Fixed footer display in both single-agent and multi-agent CLI modes to correctly show the selected model.
- **Wizard Model Fetching**: Fixed provider-to-model fetching mapping in the wizard.
- **Double Plan Approval**: Prevented duplicate plan approval submissions in the wizard.
- **UI Overflow and Limits**: Increased `maxVisible` options in dropdown lists to 10 and removed the header icon in multi-agent dashboards for cleaner visual layout.
- **Robust Error Handling**: Added robust file reading error handling (with logging and fallback) for task checklist loading.
- **Interruption Controls**: Handled Escape key to abort running agents and correctly handle interruptions.

---

## [1.1.38] - 2026-06-13

### Added
- **Multi-Model Agent Setup**: Added depth-based model configuration support for Master Agent (depth 0), Superagent (depth 1), and Subagent (depth 2).
- **Custom Superagent Definitions**: Added `define_superagent` tool to register custom Superagent roles with tailored system prompts.
- **Interactive Superagent Messaging**: Added `send_message_to_superagent` tool to allow sending follow-up instructions and queries to running Superagents.
- **Robust Worktree Cleanup**: Added robust filesystem force-removal fallback (`cleanupWorktreeRobust`) for git worktrees on Superagent termination (`kill` and `kill_all` in `manage_superagents`).

### Changed
- **Superagent Prompt**: Updated Superagent system prompt instructions to focus on coordination and delegating atomic operations (research, coding, testing) to specialized Subagents.

---

## [1.1.34] - 2026-06-11

### Added
- **Fuzzy Autocomplete Suggestions**: Implemented fuzzy matching/search for commands and slash commands.
- **Enhanced Terminal UI Layout**: Added current Git branch name rendering and polling, plus token metric counts (▲ upload / ▼ download) in the cognitive node streaming/thinking headers.
- **System Log Indicators**: Added parsing of `[SYS]` prefix to display system messages in yellow.
- **Visible & Background Command Options**: Added support for visible and background task execution with autocomplete and descriptions.

---

## [1.1.27] - 2026-06-11

### Added
- **Session Checkpoints**: Added a session checkpointing mechanism (`/checkpoint` command, interactive `Ctrl+P` wizard) to save, list, and restore previous states/history in the CLI.
- **Dynamic Project Detection**: Implemented auto-detection of project name, description, and technology stack (from `package.json`, `Cargo.toml`, `go.mod`, etc.) during system setup.
- **Git Metadata Audit**: Display current Git branch, HEAD commit hash, and status in the initialization (`/init` command) system audit log.
- **Karpathy Coding Guidelines Skill**: Integrated Andrej Karpathy's coding guidelines to reduce agent errors.

---

## [1.1.0] - 2026-06-10

### Added
- **Cyberpunk Terminal Styling**: Added customized terminal UI components, user narratives, an ASCII banner on start, and colors (magenta, cyan, yellow, green).
- **`/init` Slash Command**: A new command to initialize project settings and configuration setup.
- **Global Config Path (`~/.superagent-r`)**: Relocated environment configurations (`.env`), history records (`history/`), and execution logs (`superagent.log`) to a global user profile folder to prevent polluting project directories.
- **Context Usage Tracker**: Enhanced status bar displaying message count, active model name, current working directory, uploaded / downloaded tokens, and context window consumption percentage (`CTX_USAGE`).
- **Console Clear on Startup**: Interactive terminal clears output before rendering the UI layout.
- **Strict Guidelines & Safety Controls**: Added clear developer guidelines, PowerShell command compatibility (using `;` instead of `&&` on Windows), and mandatory planning phase (`implementation_plan.md`) workflows for complex changes.

### Changed
- Refactored history loading and logging routines to write and load from `~/.superagent-r` instead of process working directory.
- Adjusted CLI terminal layout and height calculations to accommodate the new multi-line status bar.

---

## [1.0.0] - 2026-06-10

### Added
- Initial release of Superagent, an interactive CLI coding agent.
- Integration with Anthropic and OpenAI via AI SDK.
- CLI Terminal interface using Ink (React-based terminal rendering engine).
- File reading, file writing, command execution, and permission confirmation mechanisms.
