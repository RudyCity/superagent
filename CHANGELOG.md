# Changelog

All notable changes to this project will be documented in this file.

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
