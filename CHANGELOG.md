# Changelog

All notable changes to this project will be documented in this file.

## [1.2.31] - 2026-06-29

### Improved
- **AI Agent Guidelines**: Updated `AGENTS.md` guidelines to strictly enforce coding files under 1000 lines, emphasize best practices, modularity, maintainability, optimization, and require commits, version bumps, and changelog updates for every change.

---

## [1.2.30] - 2026-06-28

### Added
- **Dynamic Limit Configuration**: Made checklist, history, and process visible limits dynamic and configurable via settings.
- **Git Branch and Workspace Tracking**: Dynamically track and update git branch and workspace path in footer and dashboard.
- **Diagnostics Event Logging**: Added mouse click raw event logging to superagent.log for diagnostics.

### Fixed
- **Mouse Tracking Mode**: Upgraded mouse tracking to button-event mode (1002h) to support scrolling and clicks in xterm/VS Code.
- **TTY Cursor Flickering**: Hide native cursor in TTY mode to prevent flickering in xterm during thinking updates.
- **Ask Question Input Validation**: Fixed parsing and handling of stringified JSON arrays in question options and coerced `isMultiSelect`.

### Improved
- **History Search Performance**: Isolated subagent and superagent session history to prevent heavy load on listing.
- **Settings Autocomplete**: Documented visible limit settings commands in the help screen and autocomplete suggestions.
- **Agent Dev Hook Context**: Clarified CWD and relative path prefix rules in the dev hook system prompt notice.

---

## [1.2.29] - 2026-06-27

### Added
- **Internal Hook Auto-Activation**: Auto-activate the hook on the `/ih dev <name>` command if it is not already active.
- **Active Hook Prompt Focus**: Load hook-specific skills from `.agents/skills` and dynamically inject active development hook prompt focus.

### Improved
- **Dynamic Directory Switching**: Dynamically switch the agent's workingDirectory to the active focused hook directory during `/ih dev` command executions.

---

## [1.2.28] - 2026-06-26

### Added
- **TencentDB Memory Management Command**: Introduced a new `/memory` slash command for real-time TencentDB memory management, configuration, and diagnostics.

### Fixed
- **TencentDB Gateway Startup**: Configured the `tencentdb-gateway` process to run headlessly using `node --import tsx` on Windows to prevent an intrusive command prompt window from showing.
- **TencentDB Gateway Synchronization**: Fixed duplicate schema export crashes during `tencentdb-gateway` startup and strengthened patch file synchronization logic.

### Improved
- **History Search Performance**: Optimized history search via in-memory caching, parallel async I/O, fast fuzzy matching, and concurrent AI-based semantic summarization.
- **Semantic Search Caching**: Implemented highly responsive semantic search caching with an expanded candidate pool and real-time progress logging, parameterized by model and provider.
- **TencentDB Memory Sync**: Reduced disk write overhead by optimizing turn-based TencentDB memory syncing to bypass redundant writes, and consolidated memory read/save routines with fast timeouts.
- **CLI Help & Suggestions**: Integrated the `/memory` command into the global help menus and autocomplete dashboard suggestions, and updated `/ih dev` command documentation.

## [1.2.27] - 2026-06-26

### Added
- **TencentDB Memory Gateway Enhancements**: Added support for upsert semantics, type mapping, custom priority, and strict type validation in TencentDB memory gateway updates.
- **Patched Router Startup Copying**: Copy the patched router to the vendor gateway directory on startup to ensure persistence.
- **Status Bar Focus Display**: Set workspace focus on `/ih dev` command and display the active workspace focus in the status bar footer.

### Fixed
- **StreamXmlFilter Robustness**: Enhanced `StreamXmlFilter` to be robust against mismatched `tool_call` closing tags.

---

## [1.2.26] - 2026-06-26

### Added
- **TencentDB Memory Writes**: Added `tdai_memory_save` and `tdai_conversation_add` tools to support direct memory storage and conversation history updates for TencentDB.

### Fixed
- **File Replace Tools**: Enhanced file replacement tools with overlap detection, robust index mapping, and fallback search behaviors to prevent incorrect offsets during multiple replacements.
- **Multi-Replace JSON Parsing**: Improved `multi_replace_file_content` robustness by correctly handling JSON stringified inputs, resolving malformed chunk structures, and preventing undefined property read errors.
- **Terminal Input Lockup**: Resolved terminal UI freeze/lockup and sluggish typing after pasting large text. Optimized rendering in `ChatTextInput.tsx` with a sliding character window and fixed pasting state transitions in `app.tsx` and `multi-agent-dashboard.tsx`.

### Improved
- **Token Usage Optimization**: Optimized file reading, searching, and grep tools along with agent workflow architectures to minimize token consumption and lower LLM API costs.

---

## [1.2.25] - 2026-06-26

### Added
- **Delete Provider Option**: Added a delete/remove provider option to the `/login` setup wizard, including:
  - Interactive search and filter interface for selecting a provider profile to delete.
  - Step 14 list view and Step 15 confirmation dialog rendering.
  - Test suites aligned with provider deletion and credential management.
- **XML/DSML Tool Call Parsing**: Support for parsing, filtering, and stripping XML and DSML format tool calls from streaming and non-streaming models (e.g. DeepSeek and OpenAI proxies).
- **Prompt Caching Support**: Integrated Anthropic prompt caching in the FastContext runner, and optimized workspace cache scanning to reduce context token usage.

### Fixed
- **XML Tags Leakage**: Screen/terminal output now filters out raw XML/DSML tool tags from both streaming and static assistant message responses in real-time.
- **Click Coordinates on Truncated Text**: Fixed selection and coordinates mapping for click actions in long assistant responses when lines wrap/truncate.
- **Type Conversion Bypass**: Respected the `string='true'` parameter attribute in tool calls to prevent numerical properties from being incorrectly converted to numbers.
- **OpenAI Endpoint Model Handling**: Enforced the OpenAI SDK wrapper for custom OpenAI endpoints serving Claude models, and correctly identified Anthropic profiles with custom base URLs as OpenAI-compatible.

### Improved
- **History Cache Performance**: Optimized `listHistorySessions` by introducing incremental metadata caching and a 30-second TTL cache to reduce disk reads.

---

## [1.2.24] - 2026-06-25

### Fixed
- **Subagent Premature Timeouts**: Enforced a minimum timeout of 10 minutes (`600000` ms) for subagent execution when a lower timeout is requested, preventing premature timeouts on slow local models, slow routers, or very large prompt context sizes. Excluded test environments (`process.env.VITEST`) to preserve unit test behaviors.

---

## [1.2.23] - 2026-06-25

### Added
- **Streaming Optimizations**: Implemented prompt caching, UI throttling, and line wrap caching to optimize terminal rendering performance.
- **Overloaded Retry Mechanism**: Added automatic retries for server overloaded/rate-limited errors (503/429) up to 5 times with exponential backoff.
- **TencentDB Terminal Window Control**: Added show/hide commands for the TencentDB terminal window and made spawning silent.

### Improved
- **Subagent Execution Mode**: Switched the default execution mode of subagents to background mode.

---

## [1.2.22] - 2026-06-25

### Added
- **Config Lock Tests**: Added unit tests for `model-config.json` locking, reentrant acquisitions, stale lock overriding, and non-destructive corruption recovery.

---

## [1.2.21] - 2026-06-25

### Improved
- **Mandatory Skill Preloading — Gap Fixes**:
  - `markPreloadedSkillsInList` now applies to **all** agent tiers (was incorrectly limited to custom-prompt agents only). Main Master/Superagent/Subagent instances now also get their preloaded skills tagged `[Content already loaded in context above]` in the `INSTALLED AGENT SKILLS` list, preventing redundant re-reads.
  - Added `trimSkillContent` static helper with frontmatter-aware trimming: YAML `---` blocks are always preserved in full; the `MAX_SKILL_LINES` (300) cap applies only to the body content so skill metadata is never cut off.

---

## [1.2.20] - 2026-06-25

### Fixed
- **Skill Path Resolution and Deduplication**:
  - Normalized agent skill paths to standard slashes and casing (specifically for Windows paths) to prevent duplicate loading.
  - Prioritized workspace local skills (`.agents/skills/`) and deduplicated duplicate global or source-level skills with identical names and authors.
- **Master Agent Orchestration**:
  - Conditionally load the `master-agent-orchestration` skill guidelines only when running in the Master Agent tier to keep prompt sizes efficient for other tiers.

---

## [1.2.19] - 2026-06-25

### Fixed
- **Image Fallback for Non-Vision Models**:
  - Automatically strip and replace image parts with placeholders when the active model lacks native vision support.
  - Append base64 image data within the text placeholder fallback, ensuring image context is preserved in text form.
- **Suggestion Cursor Behavior**:
  - Fixed autocompletion behavior so that accepting a suggestion snaps the cursor/pointer to the end of the input string and automatically appends a trailing space for unique suggestions.

---

## [1.2.18] - 2026-06-25

### Added
- **Live Tool Progress Logging**: Added real-time progress logging inside the `search_history` tool execution block in the terminal UI, displaying matching and summary steps as they occur.
- **Chat-Line Diff Stats**: Fixed rendering of `+N -N` diff statistics on file-edit tool results in the `chat-line` component to match the central `chat-area` dashboard layout.

---

## [1.2.17] - 2026-06-25

### Added
- **Image Attachments Support (`/image`)**:
  - Added a new `/image` slash command to manage prompt image attachments in the terminal UI.
  - Supports `/image paste` to attach an image from the system clipboard.
  - Supports `/image attach <path>` to attach an image from a specified file path.
  - Added support for detecting and processing file drop list in the clipboard.

---

## [1.2.16] - 2026-06-25

### Added
- **Whitespace-Insensitive Matching**: Added whitespace-insensitive matching to `multi_replace_file_content` to make tool edits more robust.

### Fixed
- **CRLF Line Endings Preservation**: Preserved CRLF line endings in file edit tools (`replace_file_content`, `multi_replace_file_content`, `apply_patch`).
- **Context Usage Tracker**: Prevented context usage tracker from resetting to 0% on model switch.
- **Shell Command Truncation**: Truncated long shell commands in tool action descriptions for cleaner output.

---

## [1.2.15] - 2026-06-25

### Added
- **Diff Stats on File Edit Results**: Chat view now displays `+N -N` diff statistics on file edit tool results, giving a quick summary of lines added/removed per edit.
- **Expand manage_tasks (update) by Default**: The `manage_tasks` update action is now automatically expanded in the chat view for better visibility of task progress.

### Fixed
- **DeepSeek Reasoning Token Separation**: Separated DeepSeek reasoning tokens from the assistant message content to prevent them from being mixed into the main response stream.

---

## [1.2.14] - 2026-06-25

### Added
- **Exit Confirmation Dialog**:
  - Added a new `exit_confirm` wizard type to gracefully handle `Ctrl+C` interrupts.
  - Renders a styled confirmation dialog asking whether the user truly wants to exit.
  - Implemented full submit handling so users can confirm or cancel the exit action without abrupt termination.
- **Agent Retry on Empty Response**: The agent now automatically retries up to 3 times with progressive delays (10s, 20s, 50s) when the model returns an empty response, improving resilience against transient API failures.
- **Updated Static Model Limits**: Refreshed OpenRouter model context window limits to reflect the latest available model specifications.

### Improved
- **Skills & Documentation**:
  - Updated `master-agent-orchestration` skill with clearer planning and task management guidelines for the Master Agent tier.
  - Added new `superagent-planning` skill providing structured guidance on creating valid implementation plans and task checklists.

---

## [1.2.13] - 2026-06-25

### Added
- **Internal Hooks System Expansion**:
  - **Scaffolding Requirements**: Made `README.md`, `CHANGELOG.md` and Git repository initialization (`git init`) mandatory when scaffolding new internal hooks.
  - **Automatic Dependency Installation**: Automatically run package manager dependency installation (`npm install`) when scaffolding a hook.
  - **Watcher Hot-Reload**: Added a file watcher to dynamically reload internal hooks on file edits.
  - **Telemetry Logging**: Integrated execution time telemetry logging for hooks.
  - **List Subcommand**: Added the `/ih list` command to display all discovered internal hooks and their registration status.

---

## [1.2.12] - 2026-06-25

### Improved
- **Hook Workspace Privacy & Isolation**:
  - Configured git ignore rules in `internal-hooks` to exclude all custom hook scripts and configurations except `.gitignore`, ensuring custom scripts are kept private and not committed to public repositories.
  - Ignored `node_modules/` and log files inside `internal-hooks` to keep the workspace clean.
- **Hook Documentation**:
  - Added detailed instructions on how to activate custom internal hooks to `SKILL.md`.

---

## [1.2.11] - 2026-06-25

### Added
- **Internal Hooks System Expansion**:
  - **Dynamic Slash Commands (`slash_commands`)**: Custom CLI commands configured inside `hook.json` are now dynamically registered into the CLI command registry, rendering automatically in the auto-complete dashboard suggestion list.
  - **Event Hooks (`event_hooks`)**: Implemented lifecycle event hooks for `pre_tool`, `post_tool`, `pre_command`, and `post_command`. Stdin pipes JSON metadata representing the event context to hook scripts.
  - **Dynamic Hook Skills**: Added support for packaging dynamic agent instructions in `skills/` folders directly within hooks. Any subdirectories containing `SKILL.md` files are loaded on startup.
- **Hook Documentation Update**: Updated `SKILL.md` for `Developing Internal Hooks` detailing the new configurations, triggers, context inputs, and best practices.

---

## [1.2.10] - 2026-06-24

### Improved
- **Compaction & Summarization Strategy Enhancements**:
  - **Truncation Guard**: Truncate formatted past chat history to a maximum of 80,000 characters before sending it to the LLM to prevent context window overflow and costly retry loops.
  - **Dynamic Abort Signal Propagation**: Properly propagate abort signals to LLM summarization calls for responsive cancellation.
  - **Improved Cost Estimation**: Fixed token/cost estimation inside `SummarizationStrategy` by counting using `contentToString()` instead of direct length on message content.
- **TencentDB Memory Strategy Enhancements**:
  - **Folder-based Hashed Session Keys**: Use a stable 8-character hash of the project path for the TencentDB session key, preventing session collisions between projects with the same folder name.
  - **Compaction Watermark Resume**: Lazily load `lastCapturedTimestamp` from the persistent compaction history on startup to accurately resume log capturing from the last processed message.
  - **L0 Log Safety**: Re-enabled `await` on `addConversation` during L0 capture to ensure transactional persistence.
  - **Dynamic Atomic Search Limit**: Automatically scale the `limit` for atomic memory searches based on the token budget.
  - **Watermark Auditing**: Persist `lastCapturedTimestamp` as metadata in the compaction event logs.
- **Setup Cleanup**:
  - Cleaned up settings check in `tencentdbSetup.ts` to rely solely on CLI arguments instead of `process.env.SUPERAGENT_MULTI` to determine the model mode.

---

## [1.2.9] - 2026-06-24

### Added
- **Internal Hooks System**: Introduced a fully extensible custom tool framework allowing users to register their own executable scripts as first-class agent tools directly within any project.
  - **`/ih init <name>`** (alias: `/internal-hooks init <name>`): Scaffolds a new hook project workspace under `internal-hooks/<name>/` with `hook.json` (tool schema), `package.json`, `index.js` (entrypoint), and `test-payload.json` (dev fixture). Newly created hooks are automatically activated and hot-reloaded into the agent's live toolset.
  - **`/ih dev <name>`**: Runs the hook locally using its configured `dev` script (or `command` fallback), piping `test-payload.json` as stdin. Supports both interactive and non-interactive execution paths with stdout/stderr capture and timing output.
  - **`/ih active`**: Opens an interactive multi-select checkbox dialog listing all discovered hooks. Uses the existing question-handler system for consistent UX. The selected active set is persisted per-project inside `~/.superagent-r/model-config.json` (`activeHooks` key) and hot-reloaded immediately.
- **Dynamic Hook Loading (`dynamicHooks.ts`)**: Hooks under `internal-hooks/` are discovered and loaded on startup via `loadDynamicHooks()` and refreshed on-demand via `refreshDynamicHooks()`. Supports per-project active-state filtering so inactive hooks are silently skipped.
- **Autocomplete Support for `/ih`**: Full tab-autocomplete for `/ih`, `/ih init`, `/ih dev`, and `/ih active`. Both `/ih init` and `/ih dev` dynamically suggest discovered hook names from `internal-hooks/`.
- **Internal Hooks Skill Guide**: Added skill documentation at `.agents/skills/internal-hooks/SKILL.md` describing the hook file structure, commands, and best practices for script authorship.

### Improved
- **`/help` now documents `/ih`**: The in-app `/help` output now includes the full `/ih` subcommand reference (`init`, `dev`, `active`) so users can discover the feature without leaving the terminal.
- **Autocomplete descriptions updated**: `/ih` and `/internal-hooks` descriptions in `dashboardSuggestions.ts` now accurately reflect all three subcommands.

---

## [1.2.8] - 2026-06-24

### Added
- **Background Processes Command**: Added `/setting-tencentdb show-bg-procs` slash command to inspect background TencentDB memory gateway processes.
- **Settings Auto-complete & Help Update**: Registered `show-bg-procs` sub-options in `/help` and tab completion.

### Fixed
- **Terminal Input Backspace Fix**: Resolved input backspace and delete keypress issues under certain terminals by correctly parsing `\x7f` and `\x1b\x7f` backspace sequences.
- **TencentDB Gateway Tag Pinning**: Enforced locking the gateway repository version to tag `v1.0.0` with automatic cleanup of obsolete `node_modules` during version changes.
- **Windows Postinstall Workaround**: Bypassed problematic pre/postinstall lifecycle scripts during dependency installation on Windows by using `--ignore-scripts`.

### Improved
- **Background Tasks Lifecycle**: Integrated the background TencentDB gateway process into the persistent CLI `backgroundTasks` registry for unified process visibility.

---

## [1.2.7] - 2026-06-24

### Added
- **TencentDB Gateway Status Check**: Added a live connection health check and status reporting via the `/setting-tencentdb status` command.
- **Live Connection Health Footer**: Added real-time connection status check for the local TencentDB gateway directly in the UI footer.
- **Settings Auto-complete & Help**: Integrated settings command configurations (like `/setting-tencentdb`) into `/help` output and autocomplete suggestions.

### Fixed
- **TencentDB Setup Robustness**: Prevented duplicate git clone issues when `vendor/tencentdb-memory` already exists.
- **Streaming Interruption**: Resolved streaming cancellation/interruption issues on ESC and Ctrl+C with robust key detection.

### Improved
- **Conversation History Performance**: Optimized performance for large conversation histories through TokenTracker caching, linear pruning, UI viewport line wrapping, and TTL caching for history sessions.

---

## [1.2.6] - 2026-06-24

### Added
- **TencentDB Memory Integration**: Integrated the fully local, 4-tier progressive memory system (`@tencentdb-agent-memory/memory-tencentdb`) as a compaction strategy inside the `ContextManager`. It automatically captures raw turns (L0), extracts atomic facts (L1), groups scenarios (L2), and maintains a unified user profile (L3).
- **Zero-Config Auto-Setup & Spawning**: Enhanced `/setting-tencentdb on` to automatically clone the gateway repository into `vendor/tencentdb-memory` and run `npm install` if missing, spawning it in the background as a detached process on port 8420.
- **Asynchronous Startup Self-Healing**: Integrated `runTencentdbSetup()` in `cli.tsx` to automatically run a non-blocking connection check on startup when enabled, spinning the gateway up in the background asynchronously if it is offline.
- **Dynamic Preset & Provider Resolution**: Configured the background gateway process to resolve memory-specific tier presets from presets (via `/model` for the `"memory"` or `"tencentdb"` tier), falling back to the active provider and master model, and injecting credentials via environment variables (`TDAI_LLM_API_KEY`, etc.).
- **Global Storage Isolation**: Structured the gateway to store its SQLite database and memory files globally under `~/.superagent-r/tencentdb-memory/vectors.db`, keeping the active workspace clean.
- **UI & Tools Integration**: Added a visual `🧠 Mem: ON` / `🧠 Mem: OFF` status indicator in the footers of both the terminal UI and multi-agent dashboards. Registered `tdai_memory_search`, `tdai_conversation_search`, and `tdai_read_cos` across all active agent tiers.
- **Workspace Hygiene**: Added `vendor/tencentdb-memory/` to `.gitignore` to prevent any untracked or node_modules files from polluting git status.

---

## [1.2.5] - 2026-06-24

### Added
- **Multimodal Image Paste & Path Detection**: Added native support for image attachments in the terminal. User prompts now accept `MessageContent` (text and image parts) seamlessly mapped to Vercel AI SDK's multimodal payload.
- **Cross-Platform Clipboard Parsing**: Created a robust platform-native utility (`readImageFromClipboard`) supporting Windows (PowerShell forms), macOS (`pngpaste`/`osascript`), and Linux (`wl-paste`/`xclip`) to automatically extract clipboard image binary data via `Ctrl+V`.
- **Ink Terminal UI Visual Indicators**: Added `ImageAttachmentBar` rendering in the Ink loop to display attached images and sizes above the input. Enabled `Ctrl+W` in an empty prompt to clear the last attachment.
- **Universal Dashboard Integration**: Wired the image attachment hook, state, and UI visual indicators into both single-agent mode (`app.tsx`) and multi-agent dashboard mode (`multi-agent-dashboard.tsx`).
- **Multimodal Token Tracking**: Integrated image token counting overhead (1600 tokens per image) in the live `TokenTracker` display.

---

## [1.2.4] - 2026-06-24

### Fixed
- **Empty Model Output Handling**: Classified empty model output as a non-retryable error to prevent infinite retry loops.
- **Background Agent Loop Leak**: Resolved background agent loop execution leak after ESC/abort to prevent ghost processes.

---

## [1.2.3] - 2026-06-24

### Added
- **Interactive Foreground Commands (TTY Piping)**: Added interactive foreground command execution and `!` shortcut in the terminal interface (`runInteractiveProcess`).
- **Background Tasks Completed Tracking**: Added `completedAt` timestamp tracking and cleanup for background tasks.

### Fixed
- **Persistent Background Tasks Registry**: Implemented a persistent registry for cross-process synchronization of background tasks.
- **TTY Piping Refinements**: Refined signatures and returned a promise from terminal execution.
- **Implementation Plan Headings Validation**: Relaxed implementation plan heading regex checks for validation flexibility.
- **Checkpoint Wizard Key Handling**: Scoped checkpoint wizard step 1 key handler so it does not intercept step 2 inputs.

---

## [1.2.2] - 2026-06-24

### Fixed
- **History View Tool Merging**: Fixed `reconstructChatLines` to properly merge `tool_start` and `tool_end` in the history view.
- **Model Config Lock Contention**: Resolved `model-config.json` corruption and lock contention under concurrent test runs.

### Improved
- **Text Streaming Performance**: Removed text streaming throttling and dashboard update delays.
- **Error Reporting**: Expanded error logs and error reports by default.

---

## [1.2.1] - 2026-06-24

### Added
- **Dynamic Workspace Fingerprinting**: Integrated workspace fingerprint in fastcontext cache key for dynamic invalidation.

### Fixed
- **Model Config Write Race Conditions**: Resolved model config deletion and corruption issues due to write race conditions.
- **Tool Arguments Formatting**: Formatted tool arguments and added custom descriptions for all tools in `getToolDescription`.

### Improved
- **Tasks Countdown Visibility**: Displayed completed tasks countdown in header only.

---

## [1.2.0] - 2026-06-24

### Added
- **Smart Workspace Discovery Cache**: Added dynamic workspace change detection on subsequent agent loop iterations and automatic updating of the cache.
- **Automatic Git Worktree Trusting**: Configured automatic git trusted directories configuration (`safe.directory`) for superagent git worktrees to prevent dubious ownership warnings.
- **Show Only Agent Name in Chat Headers**: Simplified the terminal UI layout by displaying only the agent name in cognitive node headers.

---

## [1.1.102] - 2026-06-24

### Added
- **Smart Workspace Discovery**: Implemented fast workspace fingerprint hashing (MD5 hash of sorted file paths, sizes, and timestamps) and startup cache persistence under `~/.superagent-r/workspace-caches/` to bypass redundant codebase scanning.
- **Glob Cache Interception**: Configured `globTool` to intercept searches and perform in-memory pattern matching using `picomatch` against the cached file list on cache hits, bypassing disk lookup latency.
- **Workspace Prompts Injection**: Dynamically injected the cached codebase files overview and project specifications directly into the agent's system prompt at startup to provide instant context and avoid initial discovery tool calls.
- **Picomatch Typings**: Added TypeScript type declarations for the `picomatch` module to ensure compiler type safety.

---

## [1.1.101] - 2026-06-23

### Fixed
- **Instant Stream Interruptions**: Added explicit abort checks at the start of each text stream chunk iteration in the agent loop. Resolved edge cases where the LLM response stream failed to stop immediately when the user pressed Ctrl+C or Escape.
- **Dashboard Reset on Interruption**: Automatically set the dashboard's current task status to `"Idle"` or `"Idle - Interrupted"` upon master agent done/abort events.

---

## [1.1.100] - 2026-06-23

### Improved
- **Throttled Dashboard Updates**: Implemented log buffering and state update throttling (every `30ms`) in the multi-agent dashboard UI and session hook to prevent performance drops and lag during high-frequency token streaming.

---

## [1.1.99] - 2026-06-23

### Improved
- **Fast Stream Rendering**: Reduced the streaming rendering throttle from `100ms` to `30ms` for much more responsive and faster UI updates when displaying assistant text streams.

---

## [1.1.98] - 2026-06-23

### Added
- **Multi-Agent Prompts & Self-Verification**: Mandated self-verification, testing, and critique checklists across all agent tiers (Superagent, coder, researcher, reviewer, single-mode).
- **Subagent Skills Injection**: Injected relevant agent skills into all subagent system prompts.
- **FastContext Registries Integration**: Integrated fastcontext instructions to manual-tester and subagent registries.

### Improved
- **Out-of-Bounds Arguments Visibility**: Displayed detailed arguments in the out-of-bounds permission dialog.
- **UI Log Merging & Collapsing**: Collapsed `tool_start` and `tool_end` logs into a single interactive row.
- **Dashboard Log Consolidation**: Merged consecutive `TOOL:START` and `TOOL:OK/FAIL` logs into a single row in the multi-agent dashboard UI.
- **Wizard UI Simplification**: Simplified the collapsed UI layout for the `ask_question` tool.
- **System Prompts Optimization**: Optimized fastcontext tool usage instructions in system prompts.
- **Single Mode Guidelines**: Mandated skill checking, reading guidelines, and strengthened orchestration with mandatory subagent usage instructions in single-agent mode.

### Fixed
- **Persistent Background Tasks**: Preserved active background processes across new chat sessions (`/new`).
- **Response Truncation Warning Translation**: Translated truncated response warning message into English.
- **DeepSeek/OpenRouter Validation**: Resolved DeepSeek/OpenRouter orphaned tool message validation errors and improved API HTTP status 400 error response handling.
- **Error Serialization**: Enhanced error serialization to handle non-Error objects cleanly.

---

## [1.1.97] - 2026-06-23

### Added
- **Completed Tasks Visual Countdown**: Added a visual countdown timer to completed tasks before they are hidden.

### Fixed
- **Dashboard Background Tasks**: Corrected the running background tasks filter and fixed a process cleanup leak in the dashboard.
- **Terminal Initialization Wizard**: Recommends relative paths during the workspace initialization.
- **MSYS & Windows Path Support**: Supported MSYS path formats on Windows and parsed background preset options in the terminal.
- **Terminal Preset Clean Naming**: Prohibits emojis and enforces clean, simple alphanumeric names for terminal presets to ensure they are easy to type.
- **Workspace Path Collision**: Resolved workspace path collision when directories share similar sibling prefixes in the session list and during auto-resume.

### Improved
- **Single-Agent Mode Tooling**: Enabled and enforced `manage_plan` and `manage_tasks` tools for single-agent mode CLI.
- **System Prompts Optimization**: Optimized system prompts and planning warnings to prevent illegal file modifications and enforce planning/task management tools.

---

## [1.1.96] - 2026-06-23

### Fixed
- **AI Stream Abort on Wizard Cancellation**: Cancelling a wizard with ESC or Ctrl+C now properly aborts the in-flight AI stream instead of leaving it running. Added an `abortController` abort hook in both `useKeyboardHandler.ts` and `useDashboardKeyboard.ts`.

---

## [1.1.95] - 2026-06-23

### Security
- **`.env*` File Protection**: `.env`, `.env.local`, `.env.production`, `.env-staging`, and similar files inside the workspace are now strictly protected from any agent tool access (file reads/writes, grep, shell commands) without explicit user permission. Detection covers both file path arguments and shell command strings (`cat .env`, `cp .env`, etc.) via the regex `/(?:^|[\\/])\.env([._\-][^\/]*)?$/i`.
- **`model-config.json` Per-Access Enforcement**: `model-config.json` access is now always evaluated before the session-level permission flag, so it can no longer be bypassed by granting "Allow for This Session" out-of-bounds access. The permission dialog for `model-config.json` shows a 2-option (Allow/Deny) set with no session option, and the keyboard handler now correctly treats the last option as Deny regardless of list length.

---

## [1.1.94] - 2026-06-23

### Security
- **model-config.json Protection**: `model-config.json` (containing API keys and model presets) is now strictly protected from any agent tool access (file reads, writes, grep, shell commands) without explicit user permission confirmation, even though it resides inside the allowed `~/.superagent-r/` config directory.
- **Directory Trust Prompt on Startup**: Added a mandatory security dialog on every interactive startup — agents cannot start working unless the user explicitly trusts the target folder. Navigable with arrow keys, confirmation on Enter.
- **Session-Level Permission Memory**: Permission grants now support an "Allow for This Session" option, which remembers the grant for the duration of the session so the user is not prompted again for the same type of out-of-bounds action.

---

## [1.1.93] - 2026-06-23

### Added
- **Out-of-Bounds Workspace Access Checks**: Enforced directory boundaries for file and command execution tools across all agent tiers to prevent accessing or executing commands outside the workspace/config directory without user permission.
- **Git Bash Path Normalization on Windows**: Implemented slash-path conversions on Windows platforms for robust boundary checking.
- **Wizard Permission Prompts UX**: Displayed generic allow/deny wizard options custom-tailored for command execution vs. file/directory access in the permission dialog.

---

## [1.1.92] - 2026-06-23

### Added
- **Mandatory Skill Reading Guidelines**: Added and expanded documentation guidelines requiring AI agents to read relevant skill files before planning or execution.

### Fixed
- **Wizard Key Swallowing**: Prevented focusMode handlers from swallowing keyboard inputs when the active wizard is open.

---

## [1.1.91] - 2026-06-23

### Added
- **Skills Search & Provider Prefixing**: Added search filters and provider prefixing to the skills wizard listing.
- **Dynamic Skill Authors**: Resolved skill authors dynamically using a registry-backed `skills-lock.json` to properly attribute bulk-added skills.

### Improved
- **AI-Delegated `/install` Command**: Delegated the `/install` slash command execution directly to the AI agent, with a local shell fallback and automatic non-interactive `-y` confirmation.
- **Author Attribution**: Accurately attributed standard superpowers-skills to `obra`, `typescript-advanced-types` to `wshobson`, and `agent-browser` to `vercel-labs`.

### Fixed
- **Skills Clean Up**: Retained only local and Andrej Karpathy's coding guidelines skills in the repository.
- **Compilation & Frontmatter Parsing**: Fixed compilation issue in the keyboard handler and refined the frontmatter parser to match indented metadata authors.

---

## [1.1.90] - 2026-06-23

### Fixed
- **Wizard Option Clicks**: Modified wizard options mouse click to only highlight/select the index instead of submitting.
- **Wizard Key Navigation**: Allowed return, backspace, and delete keys when paste is active in wizard inputs.

---

## [1.1.89] - 2026-06-23

### Added
- **Completed Tasks Auto-Hide**: Implemented 15-second decay timer to auto-hide archived completed tasks from "Previously Completed" section.

---

## [1.1.88] - 2026-06-23

### Improved
- **Plan Approval Keyboard Submission**: Require Enter key to submit selected plan options instead of immediate submit on mouse click.

### Fixed
- **FastContext Rate Limit**: Increased max retries to 6, emit total attempts, and integrated a shared rate limiter.
- **Checklist Strikethrough**: Replaced custom Unicode combining strikethrough characters with native Ink Text strikethrough.

---

## [1.1.87] - 2026-06-23

### Added
- **Horizontal Stepper Tabs for Wizard**: Added horizontal progress tabs to `ask_question` dialog.
- **Multi-Question Support**: Implemented support for multiple questions inside the agent question handler and wizard.

### Fixed
- **Plan Approval Clicks & Scrolling**: Fixed option selection clicks and hover-based panel mouse scrolling in terminal UI.
- **Legacy Test Suite Fixes**: Updated legacy test suites to support multi-question inputs.

---

## [1.1.86] - 2026-06-23

### Improved
- **Wizard Dialog Body Text Formatting**: Added `renderDialogBodyText` helper to format and color specific Indonesian text ("Struktur Direktori Tools") with vibrant theme colors.

### Fixed
- **Terminal History Clear in Single Mode**: Pass `clearLines` in slash command context to correctly clear terminal history in Single Mode.
- **LiteLLM Message Sanitization**: Sanitize input messages and handle `None` response objects and empty choices in LiteLLM `acall` for FastContext.

---

## [1.1.85] - 2026-06-23

### Added
- **Input History Clearing**: Clear input history log on `/new` and `/clear` commands.

### Improved
- **Robust Model Fallback Chain**: Implement a full robust subagent fallback chain and custom provider fallback in model resolution.
- **Plan Approval UI**: Refined the plan approval dialog UI layout.

### Fixed
- **FastContext Parameters**: Drop unsupported LiteLLM parameters (like `top_p` etc.) via `drop_params=True`.
- **Custom Provider Model Prefixing**: Prefix custom provider models with `openai/` for proper LiteLLM routing.

---

## [1.1.84] - 2026-06-23

### Added
- **HistoryPanel (Ctrl+H)**: New `HistoryPanel` component (`src/components/history-panel.tsx`) that displays the full input history in a scrollable, keyboard-navigable overlay. Press `Ctrl+H` to toggle; arrow keys navigate, `Enter` reuses selected entry, `Esc` closes.
- **Arrow-Key Input History in Single Mode**: The `SingleModeAgent` input component now maintains a history array of past inputs. `ArrowUp` / `ArrowDown` navigate through previous commands without leaving the input field, matching familiar terminal UX.

### Improved
- **FastContext Researcher Tier Warning**: FastContext tool now emits a visible warning when the configured model is on the `researcher` tier, helping users identify misconfigured tier assignments.
- **Trajectory Preservation on Error**: FastContext runner now preserves partial trajectory data when an error occurs mid-run, preventing full data loss on transient failures.
- **InternalServerError Retry**: FastContext automatically retries on `InternalServerError` responses from the provider, improving reliability on flaky upstream connections.
- **Custom Provider Model Routing**: Fixed model routing for custom provider configurations so that custom base-URL providers correctly receive the target model name.

---

## [1.1.81] - 2026-06-22

### Added
- **Nested Tool Calls Under Assistant Messages**: Tool events (`tool_start`/`tool_end`) are now rendered as indented children under the parent assistant message instead of appearing as separate top-level chat lines. This groups all tool invocations visually within the assistant response that triggered them.
- **`children` Property on ChatLine**: New optional `children` array on the `ChatLine` interface for grouping nested tool events under a parent line.
- **`addToolChild()` Function**: Appends tool-related events as children of the last assistant message in the chat state.
- **`expandedChildren` State & `toggleChildExpand()`**: New state management for nested collapse/expand of child lines, with a `Map<parentIndex, Set<childIndex>>` tracking which children are expanded.
- **`renderNestedChild()`**: Renders nested tool start/end children with tree-style indentation (`├───`), collapsible headers, and click-to-toggle support.

### Changed
- **Auto-Collapse Logic**: Smart collapse now operates on nested children within assistant lines instead of top-level lines. Active tool calls start expanded and auto-collapse when their `tool_end` arrives, same as before but nested.
- **Mouse Click Handling**: `useMouseScroll` now detects clicks on nested child lines and toggles their expand/collapse state via `toggleChildExpand`.
- **Dashboard Log Formatter**: TOOL log groups in the multi-agent dashboard are now nested under their parent AGENT group for cleaner visual hierarchy.
- **Multi-Mode Detection**: FastContext now also checks `SUPERAGENT_MULTI` environment variable (in addition to `--multi` CLI flag) for multi-agent mode detection.

### Fixed
- **Model Prefix Parsing**: FastContext tool now correctly parses provider prefixes from model strings (e.g., `tess@xmtp/mimo-v2.5-pro` → prefix `tess`, model `xmtp/mimo-v2.5-pro`). Supports both `@` and `:` separators.
- **Provider Profile Fallback**: Provider resolution now tries prefix match first, then `providerProfileId`, then a case-insensitive fuzzy match, and finally falls back to any provider with an API key — preventing "no credentials" errors when the configured provider is missing.
- **Python Process Tree Termination**: Added `killProcessTree()` function that uses `taskkill /F /T /PID` on Windows and `pkill -P` + `SIGKILL` on Unix to terminate the entire Python subprocess tree on abort signal, preventing orphaned processes.
- **AbortSignal Cleanup**: Abort event listener is now properly removed in the `finally` block, and `AbortError`/`CancelError` are handled gracefully without falling through to generic error handling.

### Tests
- Added tests for `killProcessTree` behavior, abort signal handling, model prefix parsing, and provider profile fallback chain.

---

## [1.1.80] - 2026-06-22

### Changed
- **FastContext Tool Parallelism**: `ExcludeGlobTool`, `ExcludeGrepTool`, and `SizedReadTool` now run blocking subprocess calls via `asyncio.to_thread()`, enabling `asyncio.gather()` to truly parallelise Read + Glob + Grep calls within the same turn and making `asyncio.wait_for()` timeouts effective.
- **`SizedReadTool` Path Resolution**: Now resolves relative paths against `cwd` before checking file size, preventing false negatives on files that exist but aren't found via absolute path.
- **`start` Event Timing**: The JSONL `start` event is now emitted inside `agent_loop()` after the cache check, so cache hits no longer trigger a premature `start` event.

### Fixed
- **Cache Key Collision**: Cache hash now includes `max_turns` as a component, preventing stale results when the same query is run with different `maxTurns` values.
- **Windows Path Exclusion**: `_is_excluded()` now normalises backslashes to forward slashes before `fnmatch`, so patterns like `node_modules` work correctly on Windows paths.
- **ExcludeGrepTool Mode Detection**: Content/heading mode detection now uses `"N|..."` numbered-line pattern instead of the unreliable `:` colon heuristic.
- **Duplicate Tool Classes**: Removed duplicate `ExcludeGlobTool` and `SizedReadTool` definitions, reorganised tool class layout for consistency.
- **Test Fixes**: `askQuestionRobustness` tests now use multi-call mocks (`callCount`) so `streamText` handles multi-turn correctly; `historySearch` test updated to match new `listSessions()` signature.

---

## [1.1.79] - 2026-06-23

### Added
- **Collapsible Chat Lines (Single-Agent)**: `tool_start`, `tool_end`, `system`, and `error` messages are now collapsible/expandable by clicking. Active tool calls start expanded and auto-collapse when their `tool_end` arrives; completed calls from history stay collapsed by default. Collapsed lines show a compact 1-line header with tool name, status icon, and description preview.
- **Collapsible Log Groups (Multi-Agent Dashboard)**: Tool start/done/fail, think, and auto-approve log groups in the multi-agent dashboard are now collapsible by clicking. Groups are collapsed by default, showing a compact header with icon, label, and content preview. Expanding shows full log details. Collapsed state resets when switching sessions.
- **`isCollapsibleType()` Helper**: Exported utility in `chat-line.tsx` to check if a chat line type supports collapse/expand behavior.
- **`computeLogGroupBoundaries()`**: New exported function in `dashboardLogFormatter.tsx` that computes group start/end line positions for click detection on collapsible log groups in the multi-agent dashboard.
- **`LogGroupInfo` Type**: New interface for group boundary metadata (groupIndex, startLine, endLine, label, isCollapsible).

### Changed
- **Plan State Guard Extended to Subagents**: `invoke_subagent` now enforces the same plan-approval gate as `invoke_superagent` — spawning is blocked if the parent agent's plan is not yet approved (`PLANNING_PENDING` or missing plan file). Error messages updated to reference both Superagents and Subagents.
- **Subagent Plan State Inheritance**: Spawned subagent instances now inherit `planState = "APPROVED"` to prevent false blocking on their own internal plan checks.
- **Chat Line Height Estimation**: `estimateChatLineHeight()` now accepts a `lineIdx` parameter and accounts for collapsed state when computing scroll positions.
- **Mouse Click Handling**: Both single-agent (`useMouseScroll.ts`) and multi-agent (`useDashboardMouse.ts`) mouse handlers now detect clicks on collapsible items and toggle expand/collapse, with priority over other click actions.

### Removed
- **`.gitignore` Cleanup**: Removed redundant entries (`__pycache__/`, `*.pyc`, `dist/`, `node_modules/`, `.fastcontext/`) that are already managed at the project root level.

---

## [1.1.78] - 2026-06-23

### Added
- **Query Result Caching**: FastContext now caches query results with 1h TTL (SHA-256 keyed on query+model+exclude+citation). Cache hits are shown in the live panel with key prefix and age. Use `--no-cache` / `noCache` param to bypass.
- **Dynamic Timeout**: Timeout is now calculated based on `maxTurns` (35s/turn, min 60s, max 600s) instead of a fixed value. Timeout error messages reflect the actual calculated duration.
- **`exclude` Parameter**: Comma-separated glob patterns to skip in all FastContext searches. `ExcludeGlobTool` post-filters results via `fnmatch` against exclude patterns.
- **`maxFileSizeKb` Parameter** (default 512 KB): `SizedReadTool` skips oversized files to prevent token waste from generated/minified/binary files.
- **Settings Integration**: `maxTurns` is now capped at `maxIterations` from global settings (`getSettings()`) when `maxIterations > 0`, integrating FastContext with the system-wide iteration budget.
- **Error Recovery**: Structured `[System]` hints are injected into agent context whenever tool calls fail, listing failed calls and error messages to prompt alternative strategies instead of silent retries.
- **Better Progress Output**: Increased reasoning preview 300→600 chars and content preview 500→800 chars in Python runner; thinking snippet 160→300 chars and tool args preview 120→160 chars in the TS live panel.

### Changed
- **`maxTurns` Default**: Raised from 6 to 8 for better exploration depth by default.
- **Smarter Retry Jitter**: Added random 0–1s jitter to exponential backoff to reduce thundering herd when multiple FastContext calls hit rate limits.
- **Better Error Parsing**: Non-zero exit errors now extract root-cause from JSONL events instead of dumping raw stderr (up to 500 chars).

### Fixed
- **`ExcludeGrepTool`**: Fixed broken glob-injection approach — `rg --glob` only accepts ONE pattern per flag, so comma-separated negation globs did NOT work. Replaced with post-filtering (same strategy as `ExcludeGlobTool`): runs normal search, then filters result lines by path. Handles both `files_with_matches` and `content`/`heading` modes.
- **Dead Code Removal**: Removed orphaned duplicate switch-case block in `fastcontextTool.ts` (leftover from a previous bad merge).
- **`.gitignore`**: Added `.fastcontext/` to prevent cache `.txt` files and trajectory `.jsonl` files from being accidentally committed to target repos.

---

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
