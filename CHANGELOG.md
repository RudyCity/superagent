# Changelog

## [1.2.549] - 2026-07-24

### Fixed
- **RMemory Dynamic Migration & Local Model Downloads**:
  - Refactored `checkAndPerformDbMigration` in `rmemoryUtil.ts` to accept explicit target directories and dimension metadata for both general vector storage and isolated skills index (`rmemory-skills`).
  - Added cached RMemory instance invalidation when embedding model name or dimensions change.
  - Added support for explicit local model download commands `/setting-rmemory download` and `/setting-classifier download` in slash commands.
  - Added unit tests for RMemory database migration and slash command download triggers.

## [1.2.548] - 2026-07-24

### Fixed
- **RMemory Migration & Background Task Notifications**:
  - Enhanced `checkAndPerformDbMigration` in `rmemoryUtil.ts` to clean up all stale files and directories in `globalDataDir` upon embedding model or dimension change, preventing vector dimension mismatches.
  - Batched background task change notifications in `app.tsx` by moving `notifyTasksChanged()` outside the task processing `forEach` loop.
  - Added robust argument unwrapping in `managePlanTool` (`otherTools.ts`) for nested `args.arguments` payloads.

## [1.2.547] - 2026-07-24

### Fixed
- **ESC Key AI Process Cancellation & Test Reliability**:
  - Fixed ESC key handler in `useKeyboardHandler.ts` so that when chat is scrolled (`scrollOffset > 0`), pressing ESC resets scroll and still aborts the running AI process instead of being blocked by the `else-if` condition chain.
  - Added test case in `keyboardAbortInterrupt.test.ts` to verify ESC aborts processing when `scrollOffset > 0`.
  - Fixed Windows `EBUSY` file locking errors in `agentAbortInterrupt.test.ts` during temporary directory cleanup.

## [1.2.546] - 2026-07-24

### Fixed
- **Silent Classifier Fallback on Local Model Failure**: When the local Supra-Router-51M-ONNX model fails to download or any error occurs during Phase 2 LLM classification, the system now silently falls back to the heuristic result instead of showing a user-facing `[SYS] Warning: Request classification issue` message. The heuristic result is applied directly to routing (planState, isSimpleTask) so execution continues normally. Failures are recorded to the log file only (`WARN` level). Root cause: `heuristicResult` was declared inside the `try` block making it inaccessible to the `catch` block — fixed by hoisting the declaration before `try`.

## [1.2.545] - 2026-07-24

### Removed
- **Codebase Indexing RAG System**: Completely removed the codebase vector embedding and Auto-RAG feature.
  - Deleted `CodebaseIndexer` module (`codebaseIndexer.ts`) and all background auto-indexing logic.
  - Deleted `codebaseSearchTool` and removed it from all tier toolsets (master, superagent, chrome extension, and all subagent types).
  - Removed Auto-RAG prompt injection from `ContextBuilder` system prompt construction.
  - Deleted `/index` slash command (`indexCommand.ts`) and removed its import from commands registry.
  - Removed `/index` entries from `/help` output and dashboard autocomplete suggestions.
  - Deleted `codebaseIndexer.test.ts` test file.

## [1.2.544] - 2026-07-24

### Optimized
- **Pragmatic Minimalism for Codebase Indexer**:
  - Refactored `CodebaseIndexer` according to pragmatic minimalism principles to eliminate over-engineering and reduce runtime overhead.
  - Optimized database memory insertions within batches using concurrent `Promise.all` instead of sequential line-by-line `await` blocking loops.
  - Streamlined stale deleted file purging into a single-pass `Set` lookup over vector memories instead of repeated O(N) array scans.
  - Normalized path separator matching for cross-platform ignore rules on Windows and Linux.
  - Reused chunk creation helper to keep structural and standard chunking DRY.

## [1.2.543] - 2026-07-24

### Fixed
- **Indexing RAM and File Locks Leak**:
  - Implemented batching (max size of 8) in `OptimizedLocalTextEmbeddingProvider.embedTexts` to prevent high peak memory allocation during feature extraction.
  - Added explicit `.dispose()` calls on intermediate ONNX/WASM feature-extraction tensors in both `embedText` and `embedTexts` to prevent native memory leaks in the transformers pipeline.
  - Resolved locked files and directory deletion failures on Windows by closing FS file watchers and calling `close()` on the cached `RMemory` SQLite database connection within `CodebaseIndexer.clearIndex`.
  - Optimized `CodebaseIndexer.initAutoIndexing` to avoid scheduling redundant workspace indexing scans on every prompt construction call.
  - Registered `codebaseSearchTool` in the `allTools` registry to resolve tool registry consistency checks.
  - Switched default local embedding model from `nomic-ai/nomic-embed-text-v1.5` to `Xenova/all-MiniLM-L6-v2` to reduce memory usage and improve indexing startup and execution speeds. Isolates codebase index storage under model-specific subdirectories to prevent dimension mismatch errors.

## [1.2.542] - 2026-07-24

### Fixed
- **Terminal Warning for Request Classification Failures**: Added terminal feedback when request classification fails due to invalid API keys or configuration errors, preventing silent logs and informing the user in the UI instead of hanging silently in THINKING state.

## [1.2.541] - 2026-07-24

### Fixed
- **Startup Lag & Non-Blocking Initialization**: Optimized initial application boot time by making ripgrep setup, Android CLI setup, MCP server initialization, and Git safe directory verification run non-blocking in the background. Improved tool existence checks in `androidSetup.ts` to check fast local binary paths before spawning `execa` shell commands.

## [1.2.540] - 2026-07-24

### Maintenance
- **Graphify Output Cleanup**: Cleaned up auto-generated `graphify-out` directory artifacts and added `graphify-out/` to `.gitignore` to prevent generated graph files from tracking in repository.

## [1.2.539] - 2026-07-24


### Added
- **Codebase Embedding & Auto RAG System**: Integrated a local vector embedding system using `rmemory` local embedding model (`nomic-embed-text-v1.5`) and SQLite vector storage. Added `CodebaseIndexer` for structural JS/TS and line-based file chunking, auto background indexing on workspace load, `codebase_search` tool for agents, Auto RAG prompt injection, and `/index` slash command (`/index`, `/index clean`, `/index search <query>`).

## [1.2.538] - 2026-07-24

### Fixed
- **Test Suite Stability & Test Pollution Fixes**: Resolved 5 failing test cases across `rmemoryUtil`, `askQuestionTool`, `visionServer`, and `visionTokenSaving`. Restored test spies, reset active question handlers in `afterEach`, adjusted dynamic vision threshold test assertions, and increased Python vision server boot retry timeout for parallel test runs.

## [1.2.537] - 2026-07-23

### Changed
- **Global History Sessions in Terminal UI**: Removed workspace-specific path filtering from the `/resume` wizard, `/session list` slash command, keyboard handler wizard, and dashboard wizard. This allows all history sessions to be listed and accessible in the CLI/terminal UI regardless of the active workspace directory.

## [1.2.536] - 2026-07-23

### Removed
- **Finishing a Development Branch Skill**: Removed the skill, cleaned up files referencing it, and updated configuration to reflect the deletion.

## [1.2.535] - 2026-07-23

### Documentation
- **Integrations**: Documented the integration between Superagent and `t-line` desktop client in [AGENTS.md](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/AGENTS.md).

## [1.2.534] - 2026-07-23

### Fixed
- **Filter Terminal UI (tline) Chat History Sessions by Workspace**:
  - Scoped the history sessions list in `/resume` wizard, `/session list` slash command, keyboard handler wizard activation, and dashboard wizard to use the agent's active `workingDirectory` workspace path instead of defaulting to process root.
  - This ensures that when switching workspaces in `tline` terminal UI mode, the chat sessions list updates dynamically to show only the sessions matching the active workspace.

## [1.2.533] - 2026-07-23

### Fixed
- **Filter Chrome Extension Chat History Sessions by Workspace**:
  - Scoped the history sessions retrieval endpoint in the Chrome Extension's side panel to request and filter sessions based on the currently active workspace.
  - Added a placeholder message in the history tab prompt when no workspace is active to prompt the user to select one.
  - Modified the backend session list implementation (`listHistorySessions` in `history.ts`) to strictly exclude sessions with empty/missing working directories when filtering by workspace path, and added unit tests to verify.

## [1.2.532] - 2026-07-23

### Fixed
- **Cleaned Session Display Names**:
  - Filtered out system-generated RMemory memory context messages when determining the first and last user messages.
  - This ensures that sessions with active RMemory context display the actual user conversation prompts on the dashboard rather than leaking RMemory configuration text like ": - [memory] ...".

## [1.2.531] - 2026-07-23


### Fixed
- **Resolved Tool Calls Leaking as Raw Text in Assistant Responses**:
  - Restored the XML tool call parsing and cleanup block at the end of the agent loop iteration in `LoopIterationProcessor.ts` that was accidentally removed during the modularization refactoring of `agent.ts`.
  - Re-integrated `StreamXmlFilter` in the text-delta streaming loop inside `LoopIterationProcessor.ts` to block and filter raw XML tool call tags (e.g. `<tool_call>`) from being streamed in real-time.
  - Ensured only cleaned assistant response text is stored in history and emitted via `onEvent`, resolving issues where raw `<tool_call>` elements and JSON payloads would leak onto the user terminal and Chrome Extension chat interface.

## [1.2.530] - 2026-07-23

### Fixed
- **Disabled Local Request Classifier by Default**:
  - Changed the default value of `classifierEnabled` from `true` to `false` in `jsonConfig.ts` and set it to `false` in the user's `model-config.json` settings.
  - This avoids loading and running the local `Sharjeelbaig/Supra-Router-51M-ONNX` classifier model via `transformers.js` on CPU-only machines. On CPU, the ONNX model inference blocks the Node.js event loop completely, causing the superagent server to freeze and experience extremely long "thinking" delays (~1 minute per simple message) without displaying any streaming response.

## [1.2.529] - 2026-07-23

### Fixed
- **Prevented CLI and Server Session Collision**:
  - Differentiated map keys for active CLI and Server sessions using `:cli` and `:server` suffixes. This allows a terminal CLI session and a desktop app session running in the same workspace to coexist seamlessly, preventing them from overwriting each other in the server's session registry.

## [1.2.528] - 2026-07-23

### Fixed
- **Optimized `tests/androidSetup.test.ts` Execution**:
  - Added conditional mock setup and deferred dynamic import of `androidSetup` module in tests, enabling execution-level mocks for both Vitest and Bun test runner environments. This prevents `bun test` from executing slow, blocking real-world `execa` commands on Windows.

## [1.2.527] - 2026-07-23

### Fixed
- **Resolved Cross-Workspace Session Hijack Mismatch**:
  - Restrained resolveSession's active CLI session fallback so it only routes requests if the requested workspace path matches the CLI session's workspace path (or if no workspace path was requested). This stops multiple clients/environments with different workspaces (like desktop t-line) from accidentally hijacking and routing messages to an unrelated active terminal session.

## [1.2.526] - 2026-07-23

### Optimized
- **Workspace Telemetry Optimization in GitUtils**:
  - Prevented parallel file I/O bottlenecks and memory blowup when capturing Git snapshots in workspaces with massive untracked file counts (e.g. desktop apps with large build outputs or unpacked assets). If there are more than 100 untracked files, content reading is bypassed.

## [1.2.525] - 2026-07-23

### Fixed
- **Resolved Server-CLI Chat Session Routing Conflict**:
  - Keyed active sessions in the server map by `${clientMode}:${targetWorkspace}` to allow concurrent CLI and Chrome Extension sessions for the same workspace path.
  - Refactored `resolveSession` to match sessions against the request's client mode (using `resolveClientMode`), preventing extension requests from resolving to CLI sessions.
  - Added `parentAgent` tracking to subagent and superagent instances, and updated server event subscribers to match completed children only to their spawning parent agent session.
  - Fixed pre-existing Vitest test failures in `server2.test.ts` (preset config naming mismatch) and `promptToolGuidance.test.ts` (assertions outdated relative to minified system prompts).

## [1.2.524] - 2026-07-22

### Fixed
- **Test Suite Refactoring and Vitest-Bun Compatibility**:
  - Replaced slow/deadlocking async module mocks (`vi.mock('...', async (importOriginal) => ...)`) with synchronous mocks and spies to resolve deadlock issues under the Bun environment.
  - Resolved SQLite database locks (EPERM errors) on Windows by closing database connections dynamically in beforeEach and afterEach hooks via `closeHistoryDb()`.
  - Fixed `keyboardAbortInterrupt` and wizard tests by invoking hooks directly and mocking React hooks synchronously.
  - Added `jsonSchema` mock export to `ai` SDK mocks, resolving TypeErrors in the agent loop tests.
  - Implemented a synchronous mini React renderer in `trustPrompt` mock to support state transitions and input callbacks.

## [1.2.523] - 2026-07-22

### Added
- **Workspace Custom Name Support (`src/core/storage/historyDb.ts`, `src/core/commands/workspaceCommand.ts`, `src/serverRoutes.ts`)**:
  - Added a `name` column to the SQLite `workspaces` table to persist custom user-friendly names for directories.
  - Implemented schema migration inside database initialization to automatically alter existing tables with the new `name` column.
  - Updated the `/workspace add` command to support parsing an optional workspace name argument, e.g., `/workspace add <path> [name]`. Added support for unquoted paths with spaces.
  - Modified `/workspace list` to print the custom workspace name (if registered) alongside the directory path.
  - Updated `addTrustedDirectory` API and `/api/config/trusted-directory` endpoint to accept and record a workspace name.
  - Exposed workspace names in the `/api/workspaces` list endpoint.
  - Added unit test coverage for name retrieval, insertion, and CLI command printing.

## [1.2.522] - 2026-07-22

### Changed
- **Removed Legacy JSON Files Creation**:
  - Cleaned up [ensureGlobalConfigDir](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/config/paths.ts#L23) in [paths.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/config/paths.ts) to stop pre-creating legacy history directories (history, history/single, history/multi, checkpoints) which are no longer needed as all conversation history, session messages, and checkpoints are stored in SQLite database.
  - Updated [cleanLegacyInputHistoryFiles](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/storage/historyDb.ts#L1244) in [historyDb.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/storage/historyDb.ts) to fully delete (unlink) legacy input-history.json files after migration instead of writing an empty array to them.
  - Updated `/new` command in [coreCommands.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/commands/coreCommands.ts) to delete the workspace's legacy input-history.json file upon session reset rather than writing an empty array.
  - Adjusted unit tests in [historyDb.test.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/tests/historyDb.test.ts) to assert that legacy input history files are successfully unlinked/deleted.
  - Cleaned up unused import of getWorkspaceInputHistoryPath in [app.tsx](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/app.tsx).

## [1.2.521] - 2026-07-22

### Fixed
- **First/Last Chat Session Title Duplication/Locking Bug (`src/serverRoutes.ts`)**:
  - Extracted the actual first and last user message content instead of hardcoding `title` to `firstChat` and `lastChat` when saving session metadata to SQLite database via `POST /api/history/session`.
  - This preserves the actual start and end prompts of a chat session, allowing the t-line bridge to calculate cleaner, more representative conversation titles.

## [1.2.520] - 2026-07-22

### Enhanced
- **System Prompts Optimization (`src/core/prompts.ts`)**:
  - Integrated Pragmatic Minimalism to enforce lean, high-density, zero-fluff prompts.
  - Integrated Single-Agent Cognitive Scale-Up protocols including symbolic problem indexing (`P[001..100]`), Graph of Thought representation, and consolidated single-pass delta execution.
  - Integrated Hundred-Minds Collective 6-team deliberation structure (Arch, Tech, Red Team, Empirical Validators, Consensus, Lean Ops).
  - Integrated Non-Linear Debugging Engine with 5-pass cause-effect triangulation, multi-hypothesis superposition matrix, and collision node pinpointing.
  - Enforced Concept A (Telegraphic English), Concept B (Markdown Hierarchy), and Concept C (Pseudocode Logic Gates) across Master Agent, Superagent, Subagents, and Chrome Extension prompts.

## [1.2.518] - 2026-07-21

### Fixed
- **Excessive Context Compaction & Summarization Loop**:
  - Excluded conversation summary messages (`[System Conversation Summary]`) from `autoPinKeyMessages` in `ContextManager.ts` to prevent summaries from being auto-pinned into permanent un-prunable state.
  - Added filtering in `PinningStrategy.ts` and `SummarizationStrategy.ts` to strip previous summary messages when compacting, preventing duplicate summary stacking.
  - Aligned emergency compaction threshold `safetyMax` in `ContextBuilder.ts` with `ContextManager.ts` threshold ratio.
  - Added unit test in `ContextManager.test.ts` verifying summaries are not auto-pinned and do not accumulate across compaction cycles.

## [1.2.517] - 2026-07-21

### Fixed
- **Python Vision Server Orphan Leak (`server.ts`)**:
  - Imported `execSync` statically from `child_process`.
  - Modified process exit hook `killVisionServerProcess()` to kill the Python child process synchronously using `execSync` instead of an asynchronous dynamic `import(...)` that fails to execute during the process exit phase.

## [1.2.516] - 2026-07-21

### Changed
- **Default Terminal Stream Response Logging Disabled (`server.ts`)**:
  - Wrapped SSE stream log output in `broadcastEvent` with a `process.env.LOG_STREAM_RESPONSE === 'true'` check.
  - Stream response logging to server terminal is now disabled by default.

## [1.2.515] - 2026-07-21

### Added
- **Stream Response Terminal Logging (`server.ts`)**:
  - Added stdout/console logging for SSE stream events in `broadcastEvent`.
  - Stream events broadcasted from SuperAgent HTTP server are now logged directly to the server terminal process.

## [1.2.514] - 2026-07-20

### Added
- **`tests/server.test.ts` — Part 1 (546 lines)**: Comprehensive integration tests for `src/server.ts` core session endpoints:
  - OPTIONS CORS preflight, GET /api/status (+ workspace header/query param resolution)
  - GET /api/workspaces, GET /api/history, GET /api/history/sessions
  - DELETE /api/history/session/:id (active session removal), GET/POST /api/input-history
  - POST /api/init (single, multi, initialPrompt, resume), POST /api/chat (!, session, empty)
  - POST /api/approve, POST /api/plan/approve, POST /api/answer
  - Session resolution via `?sessionId` query param
- **`tests/server2.test.ts` — Part 2 (621 lines)**: Integration tests for `src/server.ts` infrastructure endpoints:
  - POST /api/browser/update-instance, POST /api/browser/result
  - GET|POST|DELETE /api/browser/macros (CRUD round-trip)
  - POST /api/abort, GET /api/tasks, GET /api/instances
  - GET /api/workspace/files, POST /api/workspace/file/read (content, 400/403/404)
  - POST /api/workspace/file/open (400/403/404/200), GET /api/git/changes
  - GET /api/background-tasks, POST /api/background-tasks/kill
  - GET /api/config, POST /api/config (settings, activePresetId)
  - POST /api/switch-workspace (new, existing, multi-mode), GET /api/documents
  - GET /api/workspaces (after sessions), GET /api/events SSE stream
  - 404 fallthrough for unknown routes
- **`tests/serverTestHelper.ts`** (90 lines): Shared test fixture module (helpers: `getFreePort`, `getJSON`, `postJSON`, `deleteJSON`, `optionsReq`; shared workspace/config vars used by both server test files).

### Fixed
- Corrected 4 test assertions that assumed server files live in the workspace directory (they live in `~/.superagent-r/history/`) and one assertion about input-history no-workspace behaviour (server uses `lastActiveWorkspace` fallback, not 400).
- Refactored monolithic `server.test.ts` (was 1269 lines, exceeding the 1000-line code limit) into two sub-1000-line files.

## [1.2.513] - 2026-07-20

### Fixed
- **Test Suite — Full 1178/1178 Pass (`tests/`)**:
  - `conversation.ts` `loadFromFile`: Restored `result = "[Paused by session exit]"` and log message injection for `superagent`/`subagent` instances whose status was `"running"` or `"idle"` at session exit. The SQLite migration had inadvertently dropped this behavior.
  - `tests/skillsInjection.test.ts`: Updated assertions to match simplified `GuidelineLoader` (removed stale `PLAN WRITING/EXECUTION GUIDELINES` expectations) and updated dev-hook notice assertion from `"ACTIVE INTERNAL HOOK DEVELOPMENT FOCUS"` → `"HOOK FOCUS"` to match current `ContextBuilder.ts` copy.
  - `tests/requestClassifier.test.ts`: Updated `getCategoryPromptAddendum` assertions to expect lowercase classification tags (`"conversation"`, `"question"`, `"research"`). Replaced `"audit"` with `"scan"` in TF-IDF test string to avoid COMPLEX_KW early-exit that prevented the statistical router from running.
  - `tests/connectionTestFlow.test.ts`: Changed custom provider cached model names to use `custom/` prefix so they pass the `getModelOptions("custom", …)` filter correctly.
  - `tests/agentOptimizations.test.ts`: Updated subagent prompt test to assert `"Research Subagent"` + `"CRITICAL RULES"` instead of deleted `SEMI_FORMAL_REASONING` / `LOGIC_OF_AWARENESS` variables.
  - `tests/promptToolGuidance.test.ts`: Removed stale assertions for `"Can this be batched, delegated, or run in parallel safely?"`, `"if multiple_independent_subagents"`, `"single-agent-cognitive-scaleup"`, and `"optimal non-human reasoning"` from `prompts.ts` (removed during SQLite migration prompt cleanup). Retained `skillsConfig` assertion for `"single-agent-cognitive-scaleup"`.

## [1.2.512] - 2026-07-20

### Fixed
- **Vision Server Path Resolution (`src/server.ts` & `tests/visionServer.test.ts`)**:
  - Replaced `process.cwd()` with `getPackageRootDir()` when resolving `scripts/vision_server.py`.
  - Fixes `[Errno 2] No such file or directory` error when launching `superagent --server` from workspace directories outside the Superagent package root.

## [1.2.511] - 2026-07-20

### Added & Enhanced
- **Idle Session Harvesting, SSE Metadata & `/api/workspaces` Endpoint (`src/server.ts`)**:
  - Added `lastActiveTime` tracking to `AgentSession` interface, updated automatically on every request resolution and event broadcast.
  - Added background idle session harvester (30-minute inactivity timeout) to automatically prune inactive non-CLI sessions from memory without interrupting running tasks.
  - Attached `sessionId` and `workspace` metadata directly to `agent_event` and `plan_approval_required` SSE broadcasts for precise client session event routing.
  - Added `GET /api/workspaces` endpoint to query all active workspace sessions, modes, running status, and last active timestamps.

## [1.2.510] - 2026-07-20

### Enhanced
- **SuperAgent HTTP Server CORS & Active Session Purge (`src/server.ts`)**:
  - Updated CORS preflight and `sendJSON` headers to allow `x-workspace-path` and `Authorization` headers across all origins.
  - Enhanced `DELETE /api/history/session/:id` to purge deleted sessions from memory (`activeSessions`), aborting active runs if still executing, and broadcasting `superagent-sessions-changed` via SSE for real-time sidebar synchronization.

## [1.2.509] - 2026-07-20

### Fixed
- **SuperAgent HTTP Server `/api/abort` & Session ID Alignment (`src/server.ts`)**:
  - Enhanced `/api/abort` endpoint in `src/server.ts` to abort all active workspace agents, mark running subagent & superagent instances as `cancelled`, clear pending permissions and questions, and broadcast SSE status & done events.
  - Updated `resolveSession` in `src/server.ts` to update `session.sessionId = targetSessionId` whenever a session is resolved via workspace path, ensuring 100% session ID alignment for incoming chat requests.

## [1.2.508] - 2026-07-20

### Fixed
- **Input Focus Recovery**: Fixed bug where keystrokes were silently discarded when `focusMode` was stuck on a non-input mode (chat, checklist, superagents, subagents, procs). Typing a printable character now auto-returns focus to the input field, preventing the "typing does nothing" issue.
- **Mouse Click Focus Steal**: Clicking on chat items to expand/collapse tool outputs no longer changes `focusMode` to "chat", which previously stole keyboard focus from the input field.

## [1.2.507] - 2026-07-20

### Changed
- **Workspace Cache File Cleanup on Pruning**:
  - Updated `deleteWorkspaceDataFromDb` to clean up the JSON cache file under `workspace-caches/` whenever a workspace is deleted or pruned as stale, preventing directory and cache file leaks on disk.

## [1.2.506] - 2026-07-20

### Changed
- **Workspace ID retrieval in Read Queries**:
  - Updated `SessionRecord` interface to define the optional `workspaceId` property.
  - Updated `getSessionFromDb`, `listSessionsFromDb`, and `getSessionsByTagFromDb` queries to select the `workspace_id` column as `workspaceId`.
  - Updated `getAllPinnedKnowledgeFromDb` to return the `workspaceId` value for mapped entries.

## [1.2.505] - 2026-07-20

### Changed
- **Relational Key Integrity for Scoped Data**:
  - Linked `input_history` and `workspace_tasks` SQLite tables to `workspaces` with cascading deletions (`ON DELETE CASCADE`).
  - Added a `workspace_id` column to the `pinned_knowledge` SQLite table with a foreign key constraint.
  - Implemented dynamic database migrations to auto-add the `workspace_id` column to `pinned_knowledge` table.
  - Updated `savePinnedKnowledgeToDb` to resolve and record workspace IDs when saving pinned entries.

## [1.2.504] - 2026-07-20

### Changed
- **SQLite-Backed Workspace Trust & Parent Model**:
  - Migrated trusted directory registration from `model-config.json` to the central SQLite database inside a new `workspaces` table.
  - Established workspaces as the main parent data, registering workspace paths with their 12-char SHA-1 hashes.
  - Linked sessions to workspaces via a `workspace_id` column in the `sessions` table.
  - Implemented automatic, transparent migration of existing `trustedDirectories` config from `model-config.json` to SQLite.
  - Updated config JSON tests to resolve resource busy locks during teardown hooks.

## [1.2.503] - 2026-07-20

### Changed
- **SQLite Concurrency & Workspace Storage Alignment**:
  - Configured SQLite `PRAGMA busy_timeout = 5000;` during initialization to resolve busy timeouts under parallel execution.
  - Implemented database migrations to auto-add missing columns (like `extra_data`, `plan_state`) in existing tables, preventing column existence errors.
  - Added clean connection closing on process exit across CLI, API server, and background synchronization modules.
  - Unified workspace caching and project summary naming to standard SHA-1 path hashing.
  - Fixed input history clearing in SQLite on `/new` session command.
  - Resolved SQLite storage leak by deleting database rows in `workspace_tasks` and `input_history` when workspaces are pruned.

## [1.2.502] - 2026-07-20

### Changed
- **Pinned Knowledge & Background Tasks SQLite Migration**:
  - Migrated `pinned-knowledge.json` and workspace-scoped `background-tasks.json` to SQLite tables (`pinned_knowledge` and `workspace_tasks`) in the central `history.db`.
  - Removed all file-based locks (`background-tasks.json.lock`), relying entirely on SQLite's concurrent writes.
  - Implemented one-time transparent migrations for both stores upon first access.
  - Updated `pinnedKnowledge.test.ts` and `backgroundTasksSync.test.ts` to assert against the database state, seeding the database directly to ensure test isolation.

## [1.2.501] - 2026-07-20

### Changed
- **SQLite History Listing & Test Robustness**:
  - Bound the SQLite `dbInstance` to `globalThis.__superagent_db_instance` to share the connection across duplicate imports, resolving database lock (`EBUSY`) issues under Vitest.
  - Implemented `isMulti` (single vs. multi-agent) session filtering and superagent/subagent subdirectory exclusion inside `listHistorySessions()` to preserve correct folder isolation.
  - Refactored `config.test.ts` to write session data directly to SQLite instead of mocking legacy file paths, making the entire configuration test suite pass.
  - Cached the legacy cache migration state in `models.ts` with a `legacyCacheMigrated` flag to avoid file check overhead.

## [1.2.500] - 2026-07-20

### Changed
- **SQLite Storage Optimization**: Migrated `models_cache.json`, `tool_support_cache.json`, and `rate_limit_state.json` from JSON file storage to SQLite tables in `history.db`.
  - Added `model_caches`, `tool_support_cache`, and `rate_limit_state` tables to `historyDb.ts` with 7 new helper functions.
  - Refactored `models.ts` to read/write model context limits via SQLite instead of `models_cache.json`.
  - Refactored `promptBasedToolCalling.ts` to store tool support probe results in SQLite with TTL-based expiration.
  - Refactored `rateLimiter.ts` to use SQLite for token bucket state, removing file-based locking (`rate_limit.lock` and `rate_limit_state.json`).
  - All three modules include transparent one-time migration from legacy JSON files to SQLite on first access.
  - Updated `config.test.ts` to use SQLite helpers for model cache tests.

## [1.2.499] - 2026-07-20

### Added
- **CLI Prompt Input History SQLite Migration & Auto-Cleanup**:
  - Created `input_history` table in SQLite `history.db` with workspace-scoped indexing.
  - Implemented `saveInputHistoryToDb()`, `getInputHistoryFromDb()`, and `clearInputHistoryInDb()` functions.
  - Updated `app.tsx` terminal UI to load and save typed command history directly to SQLite.
  - Added `migrateLegacyInputHistoryToDb()` and `cleanLegacyInputHistoryFiles()` functions with startup auto-execution.
  - Added unit test case in `tests/historyDb.test.ts` for input history operations.

## [1.2.498] - 2026-07-20

### Added
- **Incremental Vacuuming, Rolling Daily Backups, DB Stats, & Session Tagging**:
  - Implemented `PRAGMA auto_vacuum = INCREMENTAL;` and `vacuumDatabase()` after session and checkpoint deletions.
  - Implemented `performRollingBackup()` maintaining up to 7 timestamped rolling backups under `~/.superagent-r/backups/`.
  - Added `getDatabaseStats()` and registered `/history stats` subcommand to display database metrics and disk usage.
  - Added `tags` column to `sessions` table and registered `/history tag <id> <label>` subcommand for session tagging and filtering.
  - Added unit test cases covering stats, rolling backups, tagging, and vacuuming in `tests/historyDb.test.ts`.

## [1.2.497] - 2026-07-20

### Fixed
- **Cascade Checkpoint Deletion**:
  - Added explicit SQLite deletion of associated checkpoints in `deleteSessionFromDb()` transaction when deleting a session.

## [1.2.496] - 2026-07-20

### Added
- **Full SQLite Checkpoint Persistence, Migration, & Cleanup**:
  - Created `checkpoints` table schema with indices in SQLite `history.db`.
  - Refactored `checkpoints.ts` functions (`createCheckpoint`, `listCheckpointsForSession`, `restoreCheckpoint`, `deleteCheckpointById`, `deleteCheckpointsForSession`) to operate directly against SQLite.
  - Implemented `migrateLegacyCheckpointsToDb()` and `cleanLegacyCheckpointsFiles()` functions in `historyDb.ts`.
  - Added automated startup migration and cleanup for legacy checkpoint JSON files.
  - Added unit test suite covering SQLite checkpoint CRUD operations, legacy migration, and cleanup in `tests/historyDb.test.ts`.

## [1.2.495] - 2026-07-20

### Fixed
- **Checkpoint Restoration SQLite Integration**:
  - Updated `restoreCheckpoint()` in `checkpoints.ts` to write restored messages, plan state, and metadata directly to SQLite `history.db` instead of legacy JSON files.

## [1.2.494] - 2026-07-20

### Added
- **Automated Startup Migration & Legacy JSON Cleanup**:
  - Configured automatic startup execution of both `migrateLegacyJsonToDb()` and `cleanLegacyJsonFiles()` so all legacy JSON session files are imported into SQLite and purged automatically on launch.

## [1.2.493] - 2026-07-20

### Added
- **Legacy JSON Cleanup Utility & /history clean Command**:
  - Implemented `cleanLegacyJsonFiles()` function in `historyDb.ts` to convert legacy `.json` payload files into empty file anchors after SQLite import verification.
  - Registered `/history clean` (and alias `/history cleanup`) subcommand to safely purge obsolete JSON session files.
  - Added unit test in `tests/historyDb.test.ts` to verify legacy JSON cleanup behavior.

## [1.2.492] - 2026-07-20

### Added
- **History Command Help & Autocomplete Suggestions**:
  - Registered `/history` command description and usage under `/help` listing in `coreCommands.ts`.
  - Registered `/history` built-in description and subcommand autocompletes (`/history export`, `/history backup`, `/history migrate`) in `dashboardSuggestions.ts`.

## [1.2.491] - 2026-07-20

### Added
- **SQLite Database Architecture & Performance Enhancements**:
  - Implemented PRAGMA WAL mode (`journal_mode=WAL; synchronous=NORMAL;`) for concurrent read/write throughput.
  - Implemented `messages_fts` SQLite FTS5 virtual table with auto-sync triggers for fast full-text message search.
  - Added `migrateLegacyJsonToDb()` utility to automatically import legacy `.json` session files into SQLite.
  - Added `exportSessionToJson()` and `backupDatabase()` helper functions.
  - Registered `/history export [session_id]`, `/history backup [path]`, and `/history migrate` slash commands.
  - Added unit test cases covering WAL, FTS5, legacy migration, export, and backup in `tests/historyDb.test.ts`.

## [1.2.490] - 2026-07-20

### Added
- **SQLite History Storage**:
  - Migrated session history, message logs, and compaction events to a unified SQLite database (`~/.superagent-r/history.db`).
  - Added dynamic SQLite storage module (`src/core/storage/historyDb.ts`) supporting both Node `node:sqlite` and Bun `bun:sqlite` runtimes.
  - Refactored `history.ts`, `conversation.ts`, `CompactionHistory.ts`, and `historySearch.ts` to query SQLite with JSON file fallback.
  - Added unit test suite in `tests/historyDb.test.ts`.

## [1.2.489] - 2026-07-19

### Fixed
- **Task Checklist Synchronization**:
  - Implemented `syncChildTasksToMaster` in `otherTools.ts` to automatically propagate active/completed task status changes from child agents (Superagents) to the Master Agent's checklist file.
  - Dynamically updates checkboxes, appends newly added tasks with the correct agent prefix, and removes child-specific tasks when they are removed.
  - Corrected capture group index references in regex match arrays.
  - Added comprehensive integration tests in `tests/taskSync.test.ts` to verify the synchronization logic for update, add, and remove actions.

## [1.2.488] - 2026-07-19

### Fixed
- **superagentTools Test Mocking**:
  - Captured original `fs.readFileSync` and updated mock implementation in `superagentTools.test.ts` to fallback to it, preventing real configuration file corruption during test runs.

## [1.2.487] - 2026-07-19

### Fixed
- **Test Harness Configuration**:
  - Configured `globals: true` in `vitest.config.ts`, fixing the `vi.mocked is not a function` error across the entire test suite.
  - Updated mock type assertions in `postMergeValidation.test.ts` and `superagentTools.test.ts` to be fully compatible with Bun/Vitest test runner.

## [1.2.486] - 2026-07-19

### Added
- **Parallel Agentic Reasoning & Optimization**:
  - Implemented Self-Consistency voting (Wang 2022) support for single-agent subagents in `subagentTools.ts`.
  - Implemented Upper Confidence Bound (UCB) dynamic Monte Carlo Tree Search (MCTS) prompt guidance for agent reasoning in `base.ts`.
  - Implemented Budgeted DAG Pruning Strategy (GraphSentry 2026) in `ContextManager` to proactively manage token budgets before compaction.
  - Implemented early termination controls and reasoning aggregation inside `masterAgent` merge flows.

## [1.2.485] - 2026-07-19

### Added
- **Advanced Agentic Reasoning Principles**:
  - Implemented `SEMI_FORMAL_REASONING` and `LOGIC_OF_AWARENESS` rules in coder and researcher system prompts.
  - Extended `ContextGraph` to track semantic premises and generate logical mind-map context blocks.

## [1.2.484] - 2026-07-19

### Added
- **Advanced Multi-Agent Optimizations**:
  - Implemented recursive subagent delegation up to depth of 3.
  - Implemented `CriticAgent` for automated post-merge code reviews.
  - Integrated `ContextGraph` to construct component summaries and inject them into system prompts.
  - Implemented `PromptOptimizer` to analyze execution traces and optimize prompt guidelines over sessions.

## [1.2.483] - 2026-07-19

### Fixed
- **Heuristic Classifier Optimization**:
  - Implemented missing request classification algorithms: Soundex phonetic variations, Jaro-Winkler/Levenshtein fuzzy matching, and statistical TF-IDF classification fallback.
  - Added support for fuzzy word matching in `countKeywordMatches` using duplicate letter collapsing, Jaro-Winkler, and Levenshtein distance checks.
  - Added exact and phrase matches for `ongoing`, `onging`, and `on going` to conversational keyword definitions.

## [1.2.482] - 2026-07-19

### Fixed
- **Gemini API Message Sequence Validation**:
  - Implemented `cleanMessageSequence()` in `MessageBuilder.ts` to enforce strict alternating message roles (user/assistant) and correct pairing of tool calls and results.
  - Automatically merges consecutive user messages and consecutive assistant messages.
  - Automatically strips unanswered tool calls from assistant messages to keep the API compliant.
  - Automatically filters/skips orphaned tool messages and ensures the first message is always a user message.

## [1.2.481] - 2026-07-18

### Optimized
- **Agent Request Hot Paths**:
  - `MessageBuilder`: single `getMessages()` pass for both vision Mode 2 and plaintext Mode 1; removed duplicate `contentToString` per-message serialization.
  - `ContextBuilder`: replaced full `.filter(role==="user").slice(-3)` with reverse-scan for last 3 user messages; reused `allMessages` ref for `getBreakdown` (no second `getMessages()` call).
  - `FastPath`: single `contentToString` call per message instead of duplicate user/assistant branches.
  - `HistoryCompactor`: confirmed single `getMessages()` per entry point; no redundant intra-method calls.
  - `advisor`: no change needed (small N).

## [1.2.480] - 2026-07-18

### Optimized
- **Token Compression Subsystem**:
  - Replaced O(n) heuristic `tokensForMessages()` with cached `TokenTracker` LRU estimator (`estimateTokensCached`) in Summarization, Pruning, and Pinning budget loops.
  - Made budget loops incremental (subtract-on-shift) instead of full recompute per iteration — O(1) per shift for 1000+ message conversations.
  - Extracted duplicated vision-support detection into single `TokenTracker.resolveVisionSaving()` static helper; removed inline duplication in PruningStrategy.
  - Wired `SemanticAnalyzer.scoreImportance` into PruningStrategy to drop lowest-importance older messages first instead of pure FIFO.
  - Added 60s memoized recall cache to RMemoryStrategy to avoid repeated gateway calls per compaction cycle.

## [1.2.479] - 2026-07-18

### Fixed
- **CLI Conversation Log Scrolling**:
  - Automatically transition focus mode to `"chat"` when scroll keys (PageUp, PageDown, Ctrl+Arrows, Shift+Arrows) are pressed while in `"input"` mode, enabling easy line-by-line keyboard scrolling using simple Up/Down arrow keys.
  - Automatically revert focus mode back to `"input"` typing mode once the user scrolls all the way back down to the bottom (`scrollOffset === 0`), eliminating the need to manually press Escape.
  - Reset scroll offset to `0` when loading history, restoring checkpoints, or resuming sessions to prevent conversation misalignment.

## [1.2.478] - 2026-07-18

### Changed
- **Chrome Extension Caching Optimization**: Optimized updateActiveTab tracking in sidepanel.js by caching the last sent title, URL, and profile name. Network requests to /api/browser/update-instance are now throttled to only fire when a genuine state change occurs, preventing redundant duplicate POST requests during navigation events.

## [1.2.477] - 2026-07-18

### Changed
- **Subagent Rename**: Renamed the manual-tester subagent to software-tester throughout the codebase, prompts, and registry configuration.
- **New Subagent Addition**: Added a security-engineer subagent, complete with its own specialized system prompt, registered subagent definition, and a robust toolset including ripgrep search, web search, execution, and security-focused skill resolution.

## [1.2.476] - 2026-07-18

### Changed
- **Chrome Extension Tool Access**: Enabled browser control tools (control_browser_tab, control_browser_macro_save, control_browser_macro_run) for both the researcher and manual-tester subagent toolsets.
- **System Prompt Updates**: Updated system prompts (master, superagent, researcher, manual-tester) to always contain instructions on how to use Chrome extension tools and macros, removing the server-mode conditional checks.

## [1.2.475] - 2026-07-18

### Added
- **Multi-Instance Browser Registration**: Enabled registering and tracking multiple Chrome instances running the Chrome extension. We can now uniquely identify and selectively target individual Chrome windows/profiles using clientId and windowId.
- **Custom Profile Naming**: Added a Profile Name text input field in the extension settings to allow custom friendly labels (e.g. Work, Personal) stored locally and synchronized with the backend.
- **Targeted Browser Control**: Updated control_browser_tab and control_browser_macro_run tools to support listing instances (list_instances) and selectively routing commands to specific target instances via instanceId.

## [1.2.474] - 2026-07-18

### Changed
- **Subagent Tool Optimization**: Updated the researcher subagent system prompt to explicitly restrict terminal/bash execution tools, preventing invalid tool call generation.
- **Self-Healing Error Recovery**: Modified the agent iteration loop to intercept "tried to call unavailable tool" errors from the LLM, inject a correction into the conversation history, and continue instead of crashing.
- **Test Suite Mock Fix**: Extended the mocked `fs` in `skillsTool.test.ts` to preserve other native filesystem methods, resolving lock file contention and test suite failures across worker threads.

## [1.2.473] - 2026-07-18

### Changed
- **Agent Codebase Modularization (Phase 8)**: Successfully completed modularization of `agent.ts`. Extracted the primary agent iteration/loop execution logic (AI SDK streamText/generateText calls, retry behaviors, 413 compaction fallbacks, empty response retries) to `LoopIterationProcessor.ts`.
- **Refactoring**: Reduced `agent.ts` file length from 1,509 lines to exactly 705 lines, and kept `LoopIterationProcessor.ts` at exactly 653 lines, keeping both files comfortably below the 1,000-line limit. Verified complete test suite passing.

## [1.2.472] - 2026-07-18

### Changed
- **Agent Codebase Modularization (Phase 7)**: Extracted directory/path resolver helper getters to `PathResolver.ts`, conversation history saving/loading and session clear routines to `HistoryManager.ts`, request preprocessing/concurrency checks to `RequestProcessor.ts`, and base prompt building, workspace cache loading, and pre-flight compaction checks to `ContextBuilder.ts`.
- **Refactoring**: Reduced `agent.ts` file length from 2,654 lines to 1,509 lines (approaching the 1000-line limit), while keeping retry loops, delay countdowns, and planning nudges fully functional.

## [1.2.471] - 2026-07-18

### Changed
- **Agent Codebase Modularization (Phase 6)**: Extracted git diff utilities to `GitUtils.ts`, conversation fast-path execution to `FastPath.ts`, and the entire tool execution loop (interactive questions, permissions, out-of-bounds, shell validations) to `ToolExecutor.ts`.
- **Refactoring**: Reduced `agent.ts` file length from 3,430 lines to 2,654 lines.

## [1.2.470] - 2026-07-18

### Changed
- **Model Wizard Hook Modularization (Phase 5)**: Extracted provider configuration, profile setup, credentials saving, and model selection wizard steps from `useModelWizard.ts` into `useModelProviders.ts`.
- **Refactoring**: Reduced `useModelWizard.ts` length to 488 lines (well below the 1000-line limit) and kept the extracted `useModelProviders.ts` helper at 705 lines.

## [1.2.469] - 2026-07-18

### Changed
- **Agent Codebase Modularization (Phase 4)**: Extracted message building logic to `MessageBuilder.ts` and history compaction/RMemory prepopulation to `HistoryCompactor.ts`.
- **Refactoring & Cleanups**: Reduced `agent.ts` file length by 704 lines, ensuring modularity, cleaner code organization, and strict compliance with the codebase length limit guidelines.

## [1.2.468] - 2026-07-18

### Changed
- **Codebase Modularization**: Refactored large modules to improve maintainability and keep code files under 1000 lines.
- **System Tools Refactoring**: Split file editing, reading, and browser macro utilities out of systemTools.ts and otherTools.ts.
- **Agent Logic Modularization**: Extracted PlanValidator and AgentEvents out of agent.ts.
- **Model Wizard Hooks**: Extracted preset wizard handling logic from useModelWizard.ts into useModelPresets.ts.

## [1.2.467] - 2026-07-18

### Fixed
- **Request Classifier Keywords & Toolsets**: Expanded research keywords with optimization and review terms, and registered missing tools (`use_skill`, `ask_question`, `read_shared_memory`) in category toolsets.

## [1.2.466] - 2026-07-18

### Fixed
- **Tool Registry Consistency**: Registered `read_shared_memory` tool in central `allTools` array.
- **RMemory Tool Unit Tests**: Updated limit assertions in `rmemoryTools.test.ts` to match search query multiplier logic.

## [1.2.465] - 2026-07-18

### Added
- **Git Worktree Path Normalization**: Added git repository root resolution to ensure isolated multi-agent worktrees share the same project memory namespace.
- **Dedicated Shared Memory Reader Tool**: Created `read_shared_memory` tool to allow AI agents to inspect project and global shared memory entries.
- **RMemory Vector Workspace Filtering**: Enhanced vector memory search tools with active project filtering and relevance boosting.
- **Workspace Summary Auto-Indexing**: Added `workspaceSummary` module to persist workspace cold-start summaries in `~/.superagent-r/projects/<hash>/summary.json`.

## [1.2.464] - 2026-07-18

### Fixed
- **Cached Model Notification Suppression**: Fixed progress callback checks in request classifier and RMemory embedding utilities so that model load completion messages are completely suppressed when models are loaded from disk cache without network downloads.

## [1.2.463] - 2026-07-18

### Fixed
- **Conditional Model Download Indicator**: Configured both local Request Classifier and RMemory embedding model loaders to only emit downloading and loading progress indicators when the model is actually being downloaded, hiding unnecessary loading messages when loading from local cache.

## [1.2.462] - 2026-07-18

### Changed
- **System Services Status Relocation**: Moved the System Services Status display from the startup banner into the `/settings` command output.

## [1.2.461] - 2026-07-18

### Changed
- **System Services Status UI**: Removed icons and borders from the system services status display in the terminal banner.

## [1.2.460] - 2026-07-18

### Added
- **Chrome Extension Auto Scroll & Limits**: Added client-side Auto Scroll toggle, Chat Message DOM Limit, and Max Explorer Files limit to the Superagent Chrome Extension.
- **Chrome Extension Performance Optimization**: Optimized chat panel rendering and file tree builder to slice large DOM node lists and render clear truncation warnings.

## [1.2.459] - 2026-07-17

### Added
- **Workspace Management Command**: Added a workspace management feature via `/workspace` and `/w` command that supports `list`, `add`, and `use` subcommands.
- **Workspace Management Wizard**: Integrated a step-by-step interactive wizard dialog for managing and switching project workspaces in both CLI mode and Multi-Agent Dashboard mode.
- **Reactive Git Status**: Configured git-branch and worktree counts to reactively re-fetch and update whenever the active workspace path changes.

## [1.2.458] - 2026-07-17

### Changed
- **Browser Control Tools Conditional Activation**: Configured Chrome extension browser control tools (`control_browser_tab`, `control_browser_macro_save`, `control_browser_macro_run`) and their system prompt optimizations to only be active when running in server mode (`--server`).

## [1.2.457] - 2026-07-17

### Fixed
- **Chrome Extension History**: Restored the missing innerHTML for history items in the Chrome extension history list to ensure workspace history chat sessions render correctly instead of showing up blank.

## [1.2.456] - 2026-07-17

### Changed
- **Chrome Extension Redesign**: Redesigned the Chrome extension's sidepanel UI to adhere to a clean, premium Material-inspired Design style. Added the "Outfit" Google Font, revised theme color variables for cool grey/white light mode and dark charcoal/grey backgrounds with Material blue accents, and configured premium component styling for buttons, inputs, checkboxes, selects, and mode cards with soft box-shadows and 8-16px rounded corners.

## [1.2.455] - 2026-07-17

### Fixed
- **Chrome Extension Manifest**: Removed redundant `"http://localhost/*"` from `optional_host_permissions` since it is already declared as a required permission under `host_permissions`.

## [1.2.454] - 2026-07-17

### Changed
- **r-memory Update**: Updated the `r-memory` dependency to version 1.3.0 which natively supports the Bun runtime. Removed the temporary sqlite patch (`patches/r-memory+1.2.0.patch`) and added a new patch (`patches/r-memory+1.3.0.patch`) to pre-compile the library on installation.

## [1.2.453] - 2026-07-17

### Fixed
- **Local Router ONNX Filename**: Passed `model_file_name: "model_int8"` to Transformers.js pipeline options for the classifier model. This resolves an issue where the pipeline was failing to load the model because it looked for the non-existent default `model.onnx`/`model_quantized.onnx` filenames in the repository, which left the system services status banner stuck on `⏳ LOADING`.

## [1.2.452] - 2026-07-17

### Fixed
- **Pre-loading Status Events**: Emitted `downloading` loading status event immediately before creating/warming up local ONNX model pipelines (for both classifier and embedding models), and emitted `loaded` status immediately upon successful initialization. This ensures that the status banner updates to `⏳ LOADING` during model setup/initialization time even if the model was already fully cached on disk.

## [1.2.451] - 2026-07-17

### Fixed
- **Advisor Loop Warnings**: Excluded status polling and waiting tools from triggering consecutive same call loop warnings (including `manage_subagents` for subagent status updates, `manage_superagents` for superagent status, `manage_background_process` / `view_background_processes` for background processes, `manage_tasks` for checklists, and external `manage_task` status checks). Added test coverage to prevent regressions and preserve loop state for other tool calls.

## [1.2.450] - 2026-07-17

### Added
- **Real-Time Services Status**: Connected the system services status in the startup banner to real-time download events. When a model is downloading or loading in the background, the status updates dynamically to `⏳ LOADING` instead of staying statically `● ONLINE` or `○ OFFLINE`.

## [1.2.449] - 2026-07-17

### Fixed
- **Model Download Progress**: Fixed download progress display going over 100% (showing values like 1011.3%) by removing redundant multiplication by 100 on the progress percentage returned by Hugging Face Transformers.js.

## [1.2.448] - 2026-07-17

### Fixed
- **README Documentation**: Updated instructions for running local/target project with `bunx` to use `--bun` flag (`bunx --bun superagent`) so it runs fully under the Bun runtime instead of Node.js shebang.

## [1.2.447] - 2026-07-17

### Fixed
- **Model Download Progress**: Redirected local HuggingFace classifier and embedding model downloading progress outputs from standard output/footer directly into the scrollable chat feed (system logs) in-place, preventing terminal DOM layout corruption.

## [1.2.446] - 2026-07-17

### Added
- **README Documentation**: Added instructions for linking and running the local Superagent package inside other projects using `bun link` and `bunx`.

## [1.2.445] - 2026-07-17

### Added
- **Worktree Collision Prevention (SKILL.md v4.0.0)**: Upgraded `preventing-subagent-collisions` skill to cover Scenario B — Master Agent → Superagent worktree-level collisions. Documents which files must never be modified inside a worktree (`package.json`, `CHANGELOG.md`, `AGENTS.md`, `README.md`), adds the strict post-merge serial sequence for Master Agent, and adds a Superagent worktree constraint section with updated plan template.
- **Master Agent — `WORKTREE_SHARED_FILES` Rule**: Superagents inside worktrees must never bump version or update changelog. They include proposed entries in their final report; Master Agent writes them ONCE post-merge.
- **Master Agent — `POST_MERGE_SERIAL` Rule**: Enforces strict post-merge order: build → test → version bump → changelog → commit → prune worktrees.
- **Superagent — `WORKTREE_PROTECTED_FILES` Rule**: Explicit prohibition on touching `package.json`, `CHANGELOG.md`, `AGENTS.md`, `README.md` inside the worktree.
- **Superagent Report — Proposed Version/Changelog Fields**: Added `Proposed Version Bump` and `Proposed Changelog Entry` fields to Superagent final report format so Master Agent can collect and apply them in one post-merge commit.

## [1.2.444] - 2026-07-17

### Fixed
- **Superagent Package Manager Detection**: Updated `detectPackageManager` in `src/core/tools/superagentTools.ts` to check for `bun.lock` in addition to `bun.lockb`. This ensures that Superagent running on environments with text-based `bun.lock` configured will properly run via Bun rather than falling back to npm.

## [1.2.443] - 2026-07-17

### Fixed
- **Test Suite Package Manager Detection**: Updated post-merge validation mocks in `tests/postMergeValidation.test.ts` and `tests/masterAgent.test.ts` to correctly handle `bun.lock` alongside `bun.lockb`. This prevents test suite validation failures on local environments that have Bun configured.

## [1.2.442] - 2026-07-17

### Fixed
- **AGENTS.md Bun Migration**: Updated Verification Checklist in `AGENTS.md` to use `bun run build` and `bun test` instead of stale `npm run build` and `npm test` references, consistent with the full Bun migration completed in v1.2.439.

## [1.2.441] - 2026-07-17

### Optimized
- **Skill Auto-Trigger on Parallel Spawn**: Added `use_skill('preventing-subagent-collisions')` directive to the `multiple_independent_subagents` branch in both `base.ts` (single-agent mode) and `SUPERAGENT_SYSTEM_PROMPT` (multi-agent mode). The agent now reads the coordination skill automatically before issuing parallel `invoke_subagent` calls, ensuring the pre-assignment and file scope workflow is always followed without requiring a manual `get_skills()` query.

## [1.2.440] - 2026-07-17

### Added
- **Subagent Collision Prevention Skill**: New skill `.agents/skills/preventing-subagent-collisions/SKILL.md` providing a complete coordination guide for parallel subagents. Covers pre-assignment workflow, serialization gates, shared file protocol, and integration with `manage_plan` + `_task.md` as the coordination hub.
- **`fileScope` Parameter in `invoke_subagent`**: New optional `fileScope: string[]` parameter that auto-injects a structured `## FILE SCOPE (Enforced)` block at the top of the subagent system prompt. Enforces file boundaries structurally without relying on parent prose.
- **Coder Subagent Report Fields**: Added `Files Changed` and `Scope Compliance` fields to coder subagent final report format so the parent can audit file touches and scope violations from the report alone.
- **`[agent: role]` Annotation in `manage_tasks list`**: `manage_tasks(action: 'list')` now parses and displays `[agent: role]` prefix from task descriptions as a suffix, e.g. `1. [/] Implement JWT middleware (agent: auth-coder)`. Enables task ownership tracking across parallel agents.

### Optimized
- **Base Prompt — Single-Agent Mode**: Added `TASK_OWNERSHIP`, `NO_SELF_ASSIGN`, and `SHARED_FILES` rules to the `spawning_subagent` logic gate in `base.ts`.
- **Master Agent Prompt**: Added `ANNOTATE` (plan task annotation with `[agent: role]`) and `STATUS` (task status lifecycle) rules to the `multiple_superagents_ready` gate.
- **Superagent Prompt**: Added `COLLISION_GUARD` rule to `spawning_subagent` gate; appended pre-assign enforcement to `LEADERSHIP_AND_DELEGATION` rule.
- **All Subagent Prompts**: Added `Do NOT call manage_tasks or manage_plan` to every subagent LIMIT line (researcher, coder, reviewer, manual-tester).
- **Coder Subagent**: Added `SCOPE_GUARD` and `SHARED_FILE_GUARD` rules — coder must only touch files in its assigned scope and must stop and report if a shared/read-only file needs modification.

## [1.2.439] - 2026-07-17

### Fixed
- **Full Bun Migration**: Updated `package.json` scripts to use `bun run` and `bun x` instead of `npm.cmd` and `npx`. Fixed `detectPackageManager()` in `masterAgent.ts` to also detect `bun.lock` (Bun v1.1+ format) alongside the legacy `bun.lockb`, ensuring build/test validation uses Bun automatically.

## [1.2.438] - 2026-07-17

### Fixed
- **autoRetry Test Compatibility**: Updated `enhancedFeatures.test.ts` auto-retry mock to detect any package runner prefix (bunx, npx, pnpm dlx, yarn dlx) so the test passes regardless of which lockfile is present on the machine.

## [1.2.437] - 2026-07-17

### Added
- **Bun Support Documentation**: Updated README.md with detailed installation, global executable linking, and script execution instructions for utilizing the Bun runtime and package manager.

## [1.2.436] - 2026-07-17

### Optimized
- **Shared Tokenizer Encoder**: Shared a single global tiktoken encoder instance across all TokenTracker instances rather than instantiating a new WASM encoder per agent, saving significant WebAssembly heap allocations.
- **History Search Cache Capping**: Capped the local history search cache at 100 entries with LRU-style eviction to prevent unlimited memory growth when querying or syncing thousands of conversation files.

## [1.2.435] - 2026-07-17

### Optimized
- **Memory Footprint Optimization**: Freed up massive memory allocations in long-running CLI sessions by nullifying the underlying `agent` reference of completed and errored subagents and superagents, allowing V8 to garbage collect their large message histories, caches, and WASM-based tiktoken tokenizers.

## [1.2.434] - 2026-07-17

### Added
- **Advisor Help & Suggestion Integration**: Integrated the `/setting-advisor` command description into the `/settings` help list screen, status dashboard display, and terminal/dashboard auto-completion suggestions list.

## [1.2.433] - 2026-07-17

### Added
- **Advisor Slash Command Toggle**: Added the `/setting-advisor` command to enable or disable the Real-Time Execution Advisor dynamically, with matching configuration storage and automated tests.

## [1.2.432] - 2026-07-17

### Added
- **Advisor Model Configuration Options**: Integrated options to set custom models for the Real-Time Execution Advisor in `/model` CLI commands, setup wizard screens, keyboard navigation menus, and dashboard interfaces.

## [1.2.431] - 2026-07-17

### Added
- **Real-Time Execution Advisor**: Added a real-time advisor subsystem that monitors tool execution loops, repeated errors, and hallucinated tools across all agent tiers (master agent, superagents, subagents, and single agent). It raises helpful guidance warnings or pauses execution when stuck.

## [1.2.430] - 2026-07-17

### Changed
- **Simplify /memory sync output**: Removed the checkmark icon (`✓`) from the synchronization success message.

## [1.2.429] - 2026-07-17

### Optimized
- **Test Suite RAM Usage Optimization**: Prevented background classifier warming and local embedding/router model loading during test suite runs unless explicitly mocked. This dramatically reduces vitest memory usage (saving gigabytes of RAM) and speeds up test execution time by over 50%.

## [1.2.428] - 2026-07-17

### Added
- **Manual Sync Command**: Added `/memory sync` subcommand allowing users to manually force synchronization of their current conversation history to the RMemory database.

## [1.2.427] - 2026-07-17

### Added
- **Download Percentage Progress**: Added inline percentage progress updates to the CLI output when downloading local embedding and local router models.

## [1.2.426] - 2026-07-17

### Changed
- **Embedding Model Upgrade to nomic-embed-text-v1.5**: Changed the default local embedding model from `all-MiniLM-L6-v2` to `nomic-embed-text-v1.5` (via `nomic-ai/nomic-embed-text-v1.5` dynamically supported by `@huggingface/transformers`).
- **Dynamic Dimension Adjustment**: Added a dynamic getter for embedding vector dimensions (384 for MiniLM and 768 for Nomic models).
- **Task Prefix Support**: Integrated task-specific prefixes (`search_query:` and `search_document:`) automatically prepended for instruction-aware Nomic embeddings depending on the query context.
- **Auto-healing DB Migration**: Implemented a `metadata.json`-based database migration helper that deletes legacy SQLite databases when embedding dimensions or models change, preventing schema dimension mismatch crashes.
- **Banner Label Update**: Updated the welcome banner component to display `nomic-embed-text-v1.5` inside the system services status panel.

## [1.2.425] - 2026-07-17

### Improved
- **System Services Status Expansion**: Added a dedicated row for the **Local Embedding Model (all-MiniLM-L6-v2)** inside the system services status panel in `Banner` to explicitly indicate its active state alongside RMemory Gateway and Local Router.

## [1.2.424] - 2026-07-17

### Added
- **Startup System Services Status Panel**: Integrated a clean Cyberpunk-themed status panel inside the welcome `Banner` component. This panel queries current configuration settings at startup and visually reports whether local services are active, specifically indicating the status of **RMemory Gateway (Local Embeddings)** and **Local Router (Supra-Router-51M-ONNX)**.

## [1.2.423] - 2026-07-17

### Improved
- **Classifier Background Pre-Warming**: Added `warmUpClassifier()` to trigger asynchronous pre-loading of the local `Supra-Router-51M-ONNX` weights during Agent class construction. This eliminates the warm-up latency on the user's first ambiguous query.
- **Optimized Download Logs**: Cleaned up the progress callback handler to print a single informational log when downloading the classifier model rather than spamming the CLI.
- **Test Isolation**: Introduced `clearLocalClassifierCache()` to reset global pipeline state between vitest test suites.

## [1.2.422] - 2026-07-17

### Improved
- **Local 51M Classifier Model Integration**: Upgraded Phase 2 classification in `requestClassifier.ts` to use the local micro-LLM **Supra-Router-51M-ONNX** via `@huggingface/transformers`. When the heuristic filter is low confidence, the classifier runs locally on CPU (downloading the 66MB model to cache on first run), analyzing prompt complexity and routing requirements before mapping them to the 7 Superagent categories, eliminating classifier API costs.

## [1.2.421] - 2026-07-17

### Added
- **Mandatory Hallmark Design Skill Rule**: Registered hallmark as a workspace-scoped mandatory skill in AGENTS.md, enforcing that the Hallmark guidelines are always read when designing or building user interfaces.

## [1.2.420] - 2026-07-17

### Added
- **Hallmark Design Skill Integration**: Added design-skill (cloned and configured from nutlope/hallmark) to provide anti-AI-slop design quality gates, structural layouts, and themed UI generation principles.

## [1.2.419] - 2026-07-17

### Added
- **Okapi BM25 Unit Tests**: Added unit tests to `tests/historySearch.test.ts` to directly verify term frequency saturation, document length normalization, IDF weighting for rare terms, and subsequence fuzzy penalties.

## [1.2.418] - 2026-07-17

### Improved
- **Okapi BM25 + Fuzzy Hybrid Local Search**: Upgraded both `searchHistory` and `searchKnowledge` local search fallback scoring algorithms to Okapi BM25. This introduces proper term frequency (TF) saturation limits (with standard $k_1 = 1.2$) and document length normalization (with standard $b = 0.75$), preventing long transcripts from skewing scores and prioritizing short, highly relevant matching turns.

## [1.2.417] - 2026-07-17

### Improved
- **Local Hybrid TF-IDF + Fuzzy Pinned Knowledge Search**: Upgraded the local fallback search algorithm in `searchKnowledge` (when `enableRmemory` is `false`) from basic substring matching to a local Hybrid TF-IDF + Fuzzy search, aligning it with the optimized `searchHistory` algorithm for higher ranking quality and typo tolerance.

## [1.2.416] - 2026-07-17

### Improved
- **Local Hybrid TF-IDF + Fuzzy History Search**: Replaced the expensive AI-based history filtering and summarization in `searchHistory` (when `enableRmemory` is `false` and an API key is present) with a 100% local Hybrid TF-IDF + Fuzzy search. It computes term frequency (TF) and inverse document frequency (IDF) with subsequence fuzzy penalties on the fly, rendering matching context turns/snippets in under 5ms without hitting the LLM model APIs.

## [1.2.415] - 2026-07-17

### Improved
- **Skills Index Hash Persistence**: Optimized `get_skills` semantic search by persisting the computed skills list hash to disk (`~/.superagent-r/rmemory/skills.hash`). This prevents re-indexing (re-embedding all 50+ local skill descriptions) on every new CLI invocation/session if the installed skills haven't changed, reducing subsequent cold starts to < 10ms.

## [1.2.414] - 2026-07-17

### Improved
- **`get_skills` Semantic Search via RMemory**: Replaced the expensive LLM call (`generateText` with the main model) used for skill filtering with a lightweight local embedding similarity search powered by the existing RMemory infrastructure (`r-memory` + `Xenova/all-MiniLM-L6-v2`, ~23MB ONNX model). Skills are indexed on demand into a dedicated `~/.superagent-r/rmemory/skills.db` (separate from conversation memory) and re-indexed automatically when the skill list changes. Query embedding + cosine similarity runs in under 10ms after warm-up. The TF-IDF keyword fallback is unchanged and activates if embedding fails.

## [1.2.413] - 2026-07-17

### Added
- **Indonesian Discussion Classifier Keywords**: Added `diskusi`, `ngobrol`, `diskusi aja`, `cuma nanya`, `cuma diskusi`, `hanya diskusi`, `kita diskusi`, `mari diskusi`, `mau diskusi`, `mau ngobrol`, `ngobrol aja`, `cuma ngobrol` to the `requestClassifier` heuristic keywords and phrases. This prevents conversational discussion requests from triggering complex execution plans or worktree steps.

## [1.2.412] - 2026-07-17

### Fixed
- **`mapNormToOrigIndices` Offset Bug**: Fixed a critical bug where column offsets in the normalized-to-original character map were computed from position 0 of the normalized (trimEnd-ed) line instead of from the actual character position in the original line. With `trim()`, leading whitespace was stripped from both ends, making `col` in normalized space != character offset in original space, which could cause wrong splice boundaries and silent file corruption on indented code. The fix correctly tracks that with `trimEnd()`, normalized col 0 maps directly to original col 0 (leading chars are preserved), while the end sentinel now correctly points past the last normalized character — not past trailing whitespace.
- **`normalizeForMatching` Trim Direction**: Changed from `line.trim()` (strips both leading and trailing whitespace) to `line.trimEnd()` (strips trailing whitespace only). Indentation is semantically significant in TypeScript, Python, YAML and similar languages — `"  foo"` and `"foo"` are different code constructs. Preserving leading whitespace makes matching more precise and prevents accidental cross-indentation matches.

### Improved
- **Actionable Not-Found Errors**: When `targetContent` or `oldString` is not found in a specified line range, all three edit tools (`edit`, `replace_file_content`, `multi_replace_file_content`) now return the actual content of the searched range (up to 400 chars) in the error message, enabling AI agents to self-correct without a separate read step.
- **Line Drift Detection**: Not-found errors now also check if the target exists elsewhere in the file. If found, the error includes a hint with the approximate line number where the target actually is (`Hint: The target was found near line N. Update startLine/endLine to cover that range.`), directly surfacing line-drift as the likely cause and providing the fix.
- **Atomic Rollback for `multi_replace_file_content`**: The single-file multi-chunk path now captures an `originalContent` snapshot before processing any chunk. If post-write verification fails (replacement not found after write), all changes are atomically rolled back to the original, preventing partial/corrupt state.
- **Post-Write Verification**: Both `replace_file_content` and `multi_replace_file_content` now read back the file immediately after writing and verify the replacement content is present. If verification fails (silent corruption), the file is rolled back to its original content and an error is returned.

## [1.2.411] - 2026-07-17

### Fixed
- **Classifier Double-Register Bug**: Removed `"coba"` from `COMMAND_KW` where it was incorrectly duplicated — it already exists in `CONVERSATION_EXACT` for exact-word matching. Previously inputs like `"coba jalankan"` could produce inconsistent classification when individual words were checked against both sets.

### Improved
- **Expanded Indonesian Conversation Vocabulary**: Extended `CONVERSATION_EXACT` with widely-used Indonesian short replies and affirmations: `"iya"`, `"ya"`, `"sip"`, `"siap"`, `"mantap"`, `"mantul"`, `"keren"`, `"bagus"`, `"gas"`, `"gass"`, `"ngerti"`, `"paham"`, `"mengerti"`, `"hai"`, `"yaudah"`, `"ya udah"`, `"udah"`, `"sudah"`, `"betul"`, `"tepat"`, `"setuju"`, `"trims"`, `"benar"`, plus English additions: `"next"`, `"skip"`, `"pass"`, `"excellent"`, `"got"`.
- **Expanded Conversation Phrase Patterns**: Added Indonesian multi-word conversational phrases to `CONVERSATION_PHRASES`: `"oke lanjut"`, `"lanjut aja"`, `"silakan lanjut"`, `"bisa lanjut"`, `"oke siap"`, `"siap bos"`, `"oke paham"`, `"iya paham"`, `"sudah paham"`, `"iya betul"`, `"iya benar"`, `"gass aja"`, `"sip lanjut"`, `"gas bro"`, plus English additions: `"makes sense"`, `"got it thanks"`, `"that works"`, `"you're welcome"`, `"no worries"`, `"fair enough"`.
- **Conversation Fast-Path**: Added `runConversationFastPath` — when the classifier identifies a high-confidence conversational message (greetings, acknowledgments, short replies) on the `single` or `master` tier, the agent now bypasses the full `runAgentLoop` entirely. It calls a lightweight `streamText` directly with a minimal system prompt and conversation history, skipping workspace discovery, tool loading, plan state injection, concurrency and rate limiter acquisition. This significantly reduces latency and token overhead for simple chat interactions.


### Optimized
- **Low-Spec Local Embedding Optimization**: Implemented `OptimizedLocalTextEmbeddingProvider` utilizing `Xenova/all-MiniLM-L6-v2` as the default local embedding model (reducing layer count from 12 to 6, cutting CPU overhead in half). Integrated thread limiting for ONNX Runtime (`intraOpNumThreads: 2`, `interOpNumThreads: 1`) to ensure local embedding generation never consumes 100% CPU on multi-core systems, keeping the terminal CLI highly responsive during background indexing.

## [1.2.408] - 2026-07-17

### Fixed
- **RMemory Sync Batching and Truncation**: Implemented batch processing (max 8 messages at a time) and text truncation (max 8,000 characters per message/pin) during conversation and pinned knowledge indexing in the RMemory utility. This prevents ONNX Runtime memory allocation failures (OOM) and extremely high CPU consumption on startup when syncing long conversation histories.

## [1.2.407] - 2026-07-17

### Added
- **Single-Mode Memory Status**: Added RMemory connection status display to the footer status bar of the single-agent console interface. The footer now displays "Mem: ON", "Mem: OFFLINE", "Mem: CHECKING", or "Mem: OFF", matching the multi-agent dashboard footer layout.

## [1.2.406] - 2026-07-17

### Fixed
- **CLI Startup Hang**: Resolved a major issue where the terminal UI would freeze and become unresponsive to keyboard inputs on startup when RMemory is enabled. Moving the CPU-intensive history search syncing process (`syncAllHistoryToRMemory`) to a detached background child process prevents it from blocking the main process event loop.

## [1.2.405] - 2026-07-17

### Added
- **RMemory History & Pinned Knowledge Search**: Integrated RMemory semantic vector search as the primary engine for `/search-history` and `/knowledge` commands.
- **RMemory Transcript Loading**: Enabled `load_pinned_session` to retrieve session transcripts directly from RMemory using `getConversationMessages(sessionId)`.
- **RMemory Pinned Knowledge Syncing**: Configured pinned knowledge additions, updates, and removals to automatically synchronize to the RMemory database, and added background synchronization of existing pins when `/knowledge` is run.

## [1.2.404] - 2026-07-17

### Fixed
- **Planning Narration Nudge**: Fixed a bug where the agent loop would auto-continue and nudge the LLM on conversation and question requests. This prevents system message tags (`[SYS]`) from leaking to the user during simple chat/Q&A interactions.

## [1.2.403] - 2026-07-17

### Optimized
- **Cognitive Scale-Up Skill**: Expanded single-agent-cognitive-scaleup with five new advanced non-human, non-linear cognitive techniques: Multi-Verse Simulation, Fractal Decomposition, Evolutionary Solution Breeding, Constraint-Satisfaction Propagation (CSP), and Entropy Minimization. Also updated the Execution Workflow in SKILL.md to integrate these techniques.

## [1.2.402] - 2026-07-17

### Improved
- **Memory & History Output Layout**: Tidied up formatting of /memory status, search, list-scenes, read-scene, read-persona, and /search-history command results. Implemented unified, clean ASCII separators, removed forbidden markdown bold elements from the output text, and aligned columns for visual clarity.

## [1.2.401] - 2026-07-17

### Optimized
- **Batch Embedding Ingestion**: Modified addConversation to use the provider's embedTexts method for parallel batch embedding. This reduces sequential API calls (or local ONNX inference passes) during conversation synchronization, significantly improving performance and decreasing rate limit consumption.

## [1.2.400] - 2026-07-17

### Added
- **RMemory Documentation and Prompts**: Updated remembering-conversations skill instructions with the new native RMemory tools and slash commands. Added RMemory guidelines to the base system prompt instructions.

## [1.2.399] - 2026-07-17

### Optimized
- **RMemory Lazy Loading & Setup**: Replaced static imports of the `r-memory` package with dynamic, lazy-loading imports. This reduces CLI startup lag by ~1-2 seconds and reduces baseline RAM usage by 100MB+ when memory features are inactive.
- **Remote Embeddings Provider Support**: Added configuration settings (`rmemoryEmbeddingProvider`, `rmemoryEmbeddingModel`, and `rmemoryEmbeddingDimensions`) to allow users to use remote OpenAI-compatible embedding APIs instead of local CPU-heavy ONNX models.

### Changed
- **Slash Commands Re-enabled**: Re-implemented and re-enabled `/memory` and `/setting-rmemory` slash commands to work seamlessly with the local database client.
- **UI Status Hook**: Updated `useRmemoryStatus` hook to dynamically report status based on the `enableRmemory` setting.

## [1.2.398] - 2026-07-17

### Changed
- **Renamed TencentDB to RMemory**: Renamed all occurrences of "TencentDB" / "tencentdb" and tool prefix "tdai_" to "RMemory" / "rmemory" and "rmemory_" across the entire codebase. This includes updating filenames, class names, strategy registries, variable names, settings configuration keys, slash commands, and test suites.

## [1.2.397] - 2026-07-17

### Changed
- **TencentDB to R-Memory Migration**: Completed the migration of the memory system from the remote TencentDB gateway to the local `r-memory` library. Implemented a local `MemoryClient` adapter wrapping `r-memory`'s `RMemory` class and local file reads. Updated all memory strategy and tool test mocks to target `tencentdbUtil` directly.

## [1.2.396] - 2026-07-16

### Changed
- **Default Auto Vision Off**: Changed the default value of `autoVisionTokenSaving` from `true` to `false` in configuration defaults and all fallback checks throughout the codebase.

## [1.2.395] - 2026-07-16

### Fixed
- **JavaScript Heap Out of Memory**: Limited Vitest `maxWorkers` to 4 (or available CPUs) in `vitest.config.ts` to prevent OOM errors on high-core machines.
- **EventEmitter Memory Leak Warning**: Instantiated fresh EventEmitter mock sockets for each call in `tests/enhancedFeatures.test.ts` to stop listener accumulation on retries.
- **Robust Vision Server Tests**: Skipped `tests/visionServer.test.ts` gracefully if Python launcher or ML packages (torch, huggingface_hub, rfdetr) are missing.

## [1.2.394] - 2026-07-16

### Changed
- **Unified Vision Mode**: Removed Mode 1 (per-block image conversion) entirely, keeping Mode 2 (full history compilation to images) as the single unified vision token saving mode. Removed `visionMode` from configuration schema, settings defaults, validation/sanitation, and command suggestion descriptions.

## [1.2.393] - 2026-07-16

### Fixed
- **Mode 2 Image Compilation Cleanups**: Completely removed the system instructions from Mode 2's compiled history images to prevent duplication and save canvas rendering space, since the system instructions are already passed in the plaintext system parameter.

## [1.2.392] - 2026-07-16

### Optimized
- **System Prompt Vision Parser Instructions**: Added explicit parsing instructions to the system prompt text parameter in both Mode 1 and Mode 2, directing the model to use its vision capabilities to read and analyze the conversation history and dynamic context rendered as WebP images.

## [1.2.391] - 2026-07-16

### Fixed
- **System Prompt Text Parameter Reversion**: Reverted system prompt image conversion and prepending logic entirely, keeping the system prompt strictly as a plaintext parameter in both Mode 1 and Mode 2.

## [1.2.390] - 2026-07-16

### Fixed
- **Mode 2 Unified System Image Prepending**: Enabled system prompt image conversion and prepending for Mode 2 when it exceeds the token threshold. Prevented duplicate system prompt image compilation by skipping its inclusion inside the compiled history block in Mode 2 when it has already been prepended.

## [1.2.389] - 2026-07-16

### Fixed
- **Mode 1 System Image Payload**: Removed all text parts and assistant confirmations from the system instructions image conversion flow in Mode 1, keeping only pure image parts to align with the text-free vision token saving design.

## [1.2.388] - 2026-07-16

### Fixed
- **Mode 2 System Text Removal**: Completely removed the system text placeholder prompt in Mode 2, leaving the text system parameter empty (or only containing development hook overrides) to ensure zero double-sent system text.

## [1.2.387] - 2026-07-16

### Fixed
- **Mode 2 Pure Image Payload**: Removed all text parts from the Mode 2 user message content array, leaving only image parts for the vision model, rendering a true pure-image prompt delivery.

## [1.2.386] - 2026-07-16

### Optimized
- **Mode 2 Prompt Wording**: Refined the system instructions and user message headers for Mode 2 to improve vision model adherence to instructions within images and instruct the model not to mention the image rendering details to the user.

## [1.2.385] - 2026-07-16

### Fixed
- **Mode 2 Pure Image Flow**: Integrated the dynamic execution context (which contains plan state, workspace state, scratchpad, etc.) directly into the compiled images in Mode 2 instead of appending it as a plaintext user message part. This completely eliminates large text inputs from Mode 2 API payloads.

## [1.2.384] - 2026-07-16

### Fixed
- **Mode 2 Token Saving**: Minimized the system prompt text to a placeholder notice when Mode 2 is active, preventing the full system instructions from being sent twice (once as text and once inside the compiled images), achieving true visual-only token savings.

## [1.2.383] - 2026-07-16

### Fixed
- **Mode 2 Image Rendering**: Implemented a `wrapLongLines` helper to wrap lines longer than 120 characters in the text-to-image pipeline. This prevents WebP encoder dimension failures (which happen when lines exceed 1800+ characters, causing the canvas to exceed WebP's 16383px limit) and dramatically improves OCR readability for the vision model.

## [1.2.382] - 2026-07-16

### Added
- **Guideline Loader**: Introduced `GuidelineLoader` to dynamically load, compress, and inject mandatory skills (such as `karpathy-guidelines` and `pragmatic-minimalism`) directly into system prompts. Avoids redundant re-reading of skills by flagging them as preloaded.

### Modified
- **Context & Token Management**: Added event emitter cleanup/disposal logic in `ContextManager` and optimized token calculation in `TokenTracker`.
- **Agent Framework**: Cleaned up codebase logic inside `agent.ts` and UI dashboards.

## [1.2.381] - 2026-07-16

### Added
- **Verification & Reliability**:
  - Added a `verify:extension-js` script to validate extension JavaScript files.
  - Added a `docs/tool-reliability.md` guide to document best practices for tool execution, handling of failed edits, and Windows command guidelines.
- **Prompts & Guidelines**:
  - Improved BATCH_OPS guidelines to enforce batching of multi-file, multi-edit, multi-task, and multi-agent operations.
  - Added guidance on parallel subagent execution and batch planning.

## [1.2.380] - 2026-07-16

### Optimized
- **Resume Command Performance**:
  - Implemented directory name timestamp parsing to sort and filter folders before executing file operations, reducing statSync calls.
  - Added a limit parameter to `listHistorySessions` to restrict metadata parsing to only the top N newest sessions.
  - Resolved session mode mismatch where single-agent mode wizard loaded multi-agent cache and vice versa.

## [1.2.379] - 2026-07-16

### Changed
- **Documentation**:
  - Marked Chrome Extension Integration and 3-Tier Multi-Agent Orchestration (`--multi`) features as experimental in the README.

## [1.2.378] - 2026-07-16

### Optimized
- **Resume Session Wizard Performance**:
  - Implemented a unified `history-metadata.json` cache file in the history folders to store metadata (name, message count, preview, workspace, modification timestamp) for all history sessions.
  - Optimized `listHistorySessions` to use memory cached session metadata directly without executing synchronous `statSync`, `readFileSync`, or `JSON.parse` operations for every folder.
  - Enabled automatic updates to `history-metadata.json` during both asynchronous and synchronous history saves.

## [1.2.377] - 2026-07-16

### Optimized
- **Conversation History Serialization**:
  - Saved history JSON files (`{sessionId}.json`) in minified format instead of pretty-printing with 2-space indentation, reducing file size and CPU/disk usage.
  - Optimized `stripOldToolResults` to skip already truncated results, avoiding redundant regex execution, string splits, and array slicing.

## [1.2.376] - 2026-07-16

### Optimized
- **Terminal Input Rendering Performance**:
  - Replaced O(N) character-by-character loops with O(1) string slices in `ChatTextInput.tsx` for rendering collapsed pasted block prefixes, suffixes, and long visible text windows.
  - Eliminated terminal freeze and input lag when navigating or typing in inputs with large pasted segments.

### Fixed
- **Paste State Duplication & Reset**:
  - Unified paste state detection by calling `updatePasteState` in `multi-agent-dashboard.tsx` instead of duplicate implementation.
  - Reset `pastePrefixLength` and `pasteSuffixLength` when clearing/submitting inputs in `app.tsx`.

## [1.2.375] - 2026-07-16

### Fixed
- **Empty Response on Resume**:
  - Fixed empty response bug and NaN token usage when resuming large sessions using custom providers (such as 9router) that return `content-type: text/event-stream` for non-streaming requests.
  - Skips text/event-stream SSE reconstruction if the response body is a plain JSON object starting with `{`.
  - Cleans up `transfer-encoding` and `content-length` headers from reconstructed `Response` objects to prevent stream reading issues in the client.
  - Refactored fetch interceptor try-catch block to return a new `Response` instead of a consumed response object upon parsing/formatting failures.

## [1.2.374] - 2026-07-16

### Optimized
- **Session History Loading (/resume command)**:
  - Optimized the session listing logic by introducing a tiny metadata.json cache next to the main {sessionId}.json file inside the history directories.
  - Avoided reading and JSON-parsing large session history files synchronously on startup, leading to sub-millisecond execution times for history retrieval.
  - Automatically writes metadata.json on every history save (saveToFile and saveToFileSync) and lazily backfills it on the first list request if missing or outdated.
  - Eliminated redundant fs.existsSync calls before fs.statSync in the listing loop.

## [1.2.373] - 2026-07-16

### Improved
- **Bulk Tool Usage Prompts**:
  - Enhanced instructions and examples in BATCH_OPS_RULE inside prompts.ts to provide precise parameter schemas for array-based bulk tool calls (read, edit, write_to_file, replace_file_content, multi_replace_file_content, apply_patch, manage_subagents, manage_tasks).
  - Clarified chunks parameter usage for single-file vs multi-file edits in multi_replace_file_content tool guidelines inside base.ts.

## [1.2.372] - 2026-07-15

### Fixed
- **Custom Provider Tool Calling**:
  - Fixed 400 Bad Request error ("request is invalid for this model") when using tool calling on custom proxy endpoints (such as OpenRouter and Nexotao).
  - Modified the custom `fetch` wrapper in `models.ts` to automatically strip the `"strict": true` property from tool definitions for custom base URLs/providers. This ensures maximum compatibility with upstream models that do not support OpenAI's strict tool schemas.

## [1.2.371] - 2026-07-15

### Fixed
- **Mistral Model Limits**:
  - Updated context window limits for Mistral flagship/latest models (such as `mistral-large-latest`, `mistral-small-latest`, `codestral-latest`, and `mistral-medium-latest` along with their corresponding `~` prefixed aliases) to correct sizes (262,144 or 256,000 tokens) in `model_limits.ts`.
  - Added new version-specific fallback checks in `getStaticModelLimit` to ensure correct matching of context lengths for these model groups.

## [1.2.370] - 2026-07-15

### Fixed
- **Workspace Truncation Bug in Chrome Extension**:
  - Increased `MAX_SAVED_WORKSPACES` limit from 10 to 100 in `sidepanel.js` to prevent the workspaces list from being truncated/sliced to 10 when switching or saving workspaces.

## [1.2.369] - 2026-07-15

### Added
- **Instant Paste Mode in Browser Control Tab**:
  - Introduced a new `paste` action to the browser tab control tool `control_browser_tab`.
  - Implemented the `pasteTextInstant` function in the Chrome extension sidepanel-browser script to bypass key-by-key typing delays and simulated typos, allowing instant text insertion.
  - Updated validation and descriptions inside `otherTools.ts`.

## [1.2.368] - 2026-07-15

### Added
- **Interactive Input Tags System in Chrome Extension**:
  - Introduced autocomplete suggestions when typing `@` (`@inspect` and `@tab`) to reference page elements or the active tab.
  - Implemented tag chips container inside the input wrapper above the textarea for visual rendering of active tags.
  - Added a "Tag Active Tab" button (🌐) in the toolbar.
  - Refactored element inspection to capture the inspected element's full HTML code (`outerHTML`).
  - Added a "Tag Details" modal overlay allowing the user to view the full HTML code of an inspected element and edit custom description context for any tag.
  - Integrated tag details and HTML code directly into `window.sendChatMessage` prompt context injection.

## [1.2.367] - 2026-07-15

### Fixed
- **Browser Control Tab Wait Action**:
  - Made target parameter optional for the wait action, allowing simple duration-based waiting using only the value parameter.
  - Added validation check to ensure at least target (selector/duration) or value (duration) is specified.
  - Enhanced browser extension side panel implementation to support numeric durations in either target or value, and added specific handling for page_load/document_load checks with configurable timeouts.
  - Added comprehensive test suite for browser control wait action validation.

## [1.2.366] - 2026-07-15

### Added
- **Local-Only Python Inference Daemon Server**:
  - Replaced slow subprocess execution with a persistent, local-only (`127.0.0.1:8095`) Python HTTP server.
  - Pre-loads `racineai/UI-DETR-1` once at startup, reducing inference latency from ~4s to ~150ms.
  - Automatically spawns the daemon on Node server boot and cleans it up on process termination/exit.
- **Sequential Action Chaining**:
  - Added `execute_chain` action to run a sequence of multiple browser operations (clicks, keypresses, scrolls) in a single tool call.
- **Hover Highlight Syncing**:
  - Synchronized item hover states from the extension Vision sidebar to both the canvas overlay and the actual webpage via `highlight_element`.
- **Smart DOM Selector Fallback**:
  - Enhanced coordinate resolution to support target coordinates with backup CSS selectors (e.g. `"X,Y|selector"`).
  - Automatically falls back to standard DOM selectors if coordinate targets drift due to scrolling.

## [1.2.365] - 2026-07-15

### Added
- **Interactive Vision Panel in Chrome Extension Sidebar** (#2):
  - Added a dedicated "Vision" tab to the extension sidebar that renders the active tab's screenshot on a canvas.
  - Automatically draws bounding boxes with category labels and confidence percentages directly over the visual elements.
  - Added an interactive element list next to the canvas showing coordinates and labels, with click-to-trigger coordinate automation.
  - Placed a confidence threshold slider in the panel to live-filter detections.
- **On-Page Bounding Box Overlay** (#1):
  - Added `show_detections` action to inject a high-priority, absolute-positioned canvas overlay in the active page DOM, displaying color-coded borders and tags over detected components.
- **Pre-Click Visual Element Highlight** (#4):
  - Injected an orange animated highlight ring that flashes around coordinate click targets for 400ms before triggering events, improving user visibility.
- **Auto-Detect Navigation Trigger** (#5):
  - Added `webNavigation.onCompleted` listener in `background.js` to broadcast main frame loads.
  - Injected a visual alert dot badge on the Vision tab button, warning when the current screenshot is out of date.
- **DOM-to-Vision Reconciliation** (#6):
  - Added `dom_info` action that queries elements at coordinate targets using `document.elementFromPoint()`.
  - Automatically parses unique CSS selectors (using data-testid, IDs, input tags, or nth-of-type paths) and merges them with coordinate predictions in `detect_ui` outputs.
- **Base64 Screenshot Handling** (#3):
  - Enhanced `detect_ui` backend logic to natively support base64 PNG dataURLs and write them directly, eliminating hardcoded filesystem dependencies.

## [1.2.364] - 2026-07-15

### Added
- **Visual UI Detection via UI-DETR-1 Model** (`detect_ui` action):
  - Added `detect_ui` action to `control_browser_tab` tool. When called, it automatically takes a screenshot of the active Chrome tab, runs the `racineai/UI-DETR-1` object detection model (via `scripts/detect_ui.py`), and returns a list of all detected interactive UI elements with their visual coordinates.
  - Output format: `- <label> at coordinate X,Y (box: [...], confidence: <score>)` — coordinates can be passed directly to `click`, `type`, and `hover` actions.
  - Added `scripts/detect_ui.py` — Python inference script using the Hugging Face `transformers` pipeline to load and run `racineai/UI-DETR-1`. Supports a configurable confidence threshold (default: 0.35).
- **Coordinate-Based Browser Interactions** (`X,Y` target pattern):
  - `click`, `type`, `hover`, and `keypress` actions in the Chrome extension (`sidepanel-browser.js`) now accept a coordinate string (e.g., `"320,480"`) as the `target` parameter in addition to CSS selectors.
  - When a coordinate target is detected, the extension resolves the element at those coordinates via `document.elementFromPoint(x, y)` and dispatches mouse events at the exact coordinate, enabling visual-based automation that is robust against DOM/class name changes.

## [1.2.363] - 2026-07-14

### Fixed
- **Chrome Extension console.error Hook Safety**:
  - Wrapped chrome-extension/main-world.js console.error interception in safe try-catch blocks to prevent potential JSON.stringify circular structure exceptions and event dispatch failures from interrupting/breaking host web pages.

## [1.2.362] - 2026-07-14

### Fixed
- **Failing Payload Too Large Retry Test**:
  - Appended a question mark to the mock success texts and assertions in tests/agentPayloadTooLargeRetry.test.ts to prevent the agent from classifying the mock response as planning narration and triggering the auto-continue loop.

## [1.2.361] - 2026-07-14

### Fixed
- **Paste Leak Bug Fix**:
  - Extracted paste state logic to `updatePasteState` helper in `src/utils/text.ts` and added unit tests in `tests/paste.test.ts`.
  - Fixed an issue where pasted content split across multiple chunks ended up leaking into input suffix/prefix and showing in the console.
  - Refactored `handleInputChange` in `src/app.tsx` to delegate to `updatePasteState`.

## [1.2.360] - 2026-07-13

### Fixed
- **GPT-5.5 / Non-Claude Model Loop Stops After 1 Iteration**:
  - **Probe cache TTL (24h)**: `probeToolCallSupport` in `promptBasedToolCalling.ts` now stores `{ value, timestamp }` instead of a bare `boolean` on disk. Cache entries older than 24 hours are treated as stale and re-probed automatically. Legacy bare-boolean entries (from older sessions) are also treated as expired and re-probed on next use. This fixes the root cause: a stale `false` cache entry for `localhost:8087/gpt-5.5` caused Superagent to activate XML prompt-based tool fallback — a Claude-specific format that GPT-5.5 does not follow — resulting in text-only responses and immediate loop termination.
  - **Auto-continue for planning narration responses**: In `agent.ts`, when a model outputs a short text-only response (no tool calls) on the first two iterations and the text does not end with a question mark, Superagent now injects a `[SYS] Continue. Use the available tools...` nudge message and continues the loop instead of breaking immediately. This handles models like GPT-5.5 that announce their intent as text before acting, rather than issuing tool calls directly.

## [1.2.359] - 2026-07-13


### Fixed
- **Anthropic 400: tool_result.tool_use_id Field Required**:
  - Added guard in `buildMessages()` to skip individual tool results where `toolCallId` is falsy (undefined/empty), preventing the invalid `tool_use_id` field from reaching the Anthropic API.
  - Added guard to skip empty `toolResults` arrays early, avoiding an empty `role: "tool"` message being pushed to `coreMessages`.
  - Added guard to skip pushing a `role: "tool"` `coreMessages` entry when all its `contentParts` were filtered out.
  - Added post-loop orphan guard in `PruningStrategy` after the token-budget `while` loop to mirror the existing byte-budget guard — prevents a `role: "tool"` message from being left at the start of `toKeep` after its paired `role: "assistant"` was pruned.

## [1.2.358] - 2026-07-13

### Added
- **Interactive Prompt Detection in android_cli**:
  - Imported `detectInteractivePrompt` into `otherTools.ts`.
  - androidCliTool now auto-kills and returns an error if a y/n or password prompt is detected during execution.
- **Unified Verification Helper (`runStreamedVerification`)**:
  - Extracted a reusable `runStreamedVerification` async helper inside `superagentTools.ts`.
  - Combines live streaming, interactive prompt detection, and per-run log file persistence into a single function.
  - Build and test verification in both `invokeSuperagentTool` and `sendMessageToSuperagentTool` now use this helper.
  - Verification log files are saved to `.superagent/logs/build-<timestamp>.log` and `test-<timestamp>.log` inside each worktree.
- **Output Throttling in state.ts**:
  - `appendActiveToolOutput` now batches UI listener notifications using a 50ms `setTimeout` throttle.
  - `clearActiveToolOutput` cancels any pending throttled notification and immediately notifies listeners with an empty string.
- **Background Process Live Stream**:
  - Added `stream` action to `manageBackgroundProcessTool` in `shellTools.ts`.
  - When used, the action pipes all future stdout/stderr from the target background process into `SYSTEM_CALL_OUTPUT (LIVE)` in real-time, blocking until the process exits or times out.

---

## [1.2.357] - 2026-07-13

### Added
- **Live Output Streaming for CLI and Verification Tools**:
  - Added SYSTEM_CALL_OUTPUT (LIVE) streaming for `android_cli` in `otherTools.ts`.
  - Added streaming for `npm run build` and `npm test` pre-merge verification processes inside `invokeSuperagentTool` and `sendMessageToSuperagentTool` in `superagentTools.ts`.
  - Added proper subprocess cancellation using `killProcessTree` on abort signal for all three tools.

---

## [1.2.356] - 2026-07-13

### Added
- **Changes Summary Coloring**:
  - Implemented `renderDiffColors` inside `chat-line.tsx` and `chat-area.tsx` to automatically highlight added/deleted line statistics (e.g. `+10` in green, `-5` in red).
  - Integrated `renderDiffColors` into the text elements processed by `renderBoldTargetText` for seamless inline terminal styling.

---

## [1.2.355] - 2026-07-13

### Fixed
- **Prompt Instruction Leakage**:
  - Enclosed dynamic execution contexts inside `<system_context_do_not_echo_or_repeat>` tags in `agent.ts`.
  - Added system prompt rules telling models not to repeat tags.
  - Implemented `cleanAssistantResponse` in `text.ts` to strip echoed instructions and multi-line separator blocks (including shorter dividers like `---`) from assistant messages.
  - Called `cleanAssistantResponse` in `addAssistantMessage` to clean messages before saving to database.

---

## [1.2.353] - 2026-07-13

### Fixed
- **Chrome Extension Selection Caret Typing**:
  - Rewrote the human-like text input simulation (`typeTextHumanLike`) inside `sidepanel-browser.js` to target the active text selection caret.
  - Implemented the W3C Selection and Range APIs for writing and deleting characters in rich text/contenteditable containers (such as Medium, Notion, Google Docs) to prevent wiping out container HTML tag structures.
  - Aligned typing within input and textarea elements to target `selectionStart` and `selectionEnd`, moving the caret position forward dynamically.

---

## [1.2.352] - 2026-07-13

### Added
- **Chrome Extension Inspect & Annotation Picker**:
  - Integrated a visual Inspect Element tool (🔍 button) next to the chat input in the toolbar.
  - Clicking it injects a promise-based content picker overlay onto the active web page.
  - Hovering elements highlights them with a blue border and shows a tooltip containing their unique CSS selector and metadata annotation.
  - Clicking an element intercepts the click, resolves the selector, and inserts it at the current cursor caret position in the chat input.
  - Pressing Escape exits inspect mode.

---

## [1.2.351] - 2026-07-13

### Added
- **Chrome Extension Human-like Interaction Suite**:
  - Simulated biological tremors/micro-movements for the virtual cursor when stationary (low-frequency sub-pixel oscillation breathing effect).
  - Target-size aware movement duration following Fitts's Law (`ID = log2(2 * distance / size + 1)`), moving faster for large items and slowing down for precise adjustments on smaller targets.
  - Smooth scrolling for off-screen elements with settling detection (polling position until motion stops) to ensure elements are static before cursor tracking.
  - Character-by-character keyboard input simulation with randomized typing speeds (50ms - 150ms delay) and typo simulation (backspacing to fix mistakes).

---

## [1.2.350] - 2026-07-13

### Added
- **Chrome Extension Human-like Movement Overshoot**:
  - Integrated ghost-cursor inspired overshoot and self-correction algorithm for the virtual mouse movement. When distance is greater than 200 pixels, there is a 60% chance to overshoot the target with a slight angular offset, pause for a biological reaction delay, and then make a smooth corrective movement back to the target.

---

## [1.2.349] - 2026-07-13

### Fixed
- **Chrome Extension Automated Click Focus**:
  - Enhanced automated clicks to programmatically call `.focus()` on targeted elements and their contenteditable ancestors to ensure text carets appear correctly (e.g. in rich editors like Medium).
  - Selectively route click triggers: use native `.click()` for native interactive elements (inputs, links, buttons) to avoid double-triggering checkbox toggles, and use bubbling MouseEvents with exact coordinate values for generic elements (divs, spans, paragraphs).

---

## [1.2.348] - 2026-07-13

### Changed
- **Chrome Extension Automated Click**:
  - Replaced manual click guidance with fully automated browser clicks. The virtual cursor still animates to target elements to visually guide the user, but now automatically dispatches realistic mousedown, mouseup, and click events with natural biological delays to simulate a human interaction without blocking execution.

---

## [1.2.347] - 2026-07-13

### Fixed
- **Chrome Extension Virtual Cursor**:
  - Set `pointer-events: none !important` inline on the virtual cursor div and its inner SVG/path elements to prevent them from intercepting clicks in some environments or under custom styling.
  - Added fallback detection to the manual click guidance handler; if a click is intercepted by the virtual cursor, the target element is programmatically clicked and the step resolves successfully, preventing click blockages.

---

## [1.2.346] - 2026-07-13

### Fixed
- **Chrome Extension Newline Rendering**:
  - Added `white-space: pre-wrap;` to `.msg-content-text` and `.reasoning-block` in `sidepanel.src.css` (and compiled `sidepanel.css`) to preserve newlines and line breaks in AI response texts and reasoning blocks, fixing the issue where text runs together without formatting.

---

## [1.2.345] - 2026-07-13

### Added
- **Browser Macro Preset System**:
  - New `src/core/config/browserMacros.ts` module with typed `BrowserMacro` interface, disk-persistent CRUD helpers (`getBrowserMacros`, `saveBrowserMacro`, `deleteBrowserMacro`), and template interpolation utilities (`interpolateStep`, `resolveSteps`). Macros stored at `~/.superagent-r/browser-macros.json`.
  - New AI tools `control_browser_macro_save` and `control_browser_macro_run` in `otherTools.ts`. The save tool creates named, parameterized macro presets with `{{placeholder}}` support. The run tool executes all steps sequentially and returns per-step results.
  - Both tools registered in `masterToolset`, `superagentToolset`, and `chromeExtensionToolset` in `toolsets.ts`.
  - REST API endpoints `GET /api/browser/macros`, `POST /api/browser/macros`, `DELETE /api/browser/macros` added to `server.ts` for full CRUD access from the Chrome Extension.
  - Chrome Extension: new Macros sidebar tab (user icon) in `sidepanel.html` with a "Browser Macros" pane listing all saved macros with their name, description, params, and step count. Users can delete any macro from the UI. Tab integrates with the existing sidebar toggle/switch system in `sidepanel.js`.
  - 13 unit tests added in `tests/browserMacros.test.ts` covering save, overwrite, delete, multi-macro storage, case-insensitive lookup, interpolation edge cases, and resolveSteps.

## [1.2.344] - 2026-07-13

### Added
- **Chrome Extension Human-like Virtual Mouse & Manual Click Guidance**:
  - Implemented custom Bezier curve animation for the virtual mouse pointer with cubic ease-in-out easing and micro-jitters to mimic actual human hand motor controls.
  - Upgraded the virtual cursor to use a realistic cursor SVG instead of a simple red dot.
  - Added visual highlight pulsing effect to target elements.
  - Modified the click handler to act as visual manual guidance, waiting for the user to perform the click manually before resolving, ensuring complete immunity to bot detection.

---

## [1.2.343] - 2026-07-13

### Added
- **Chrome Extension Workspace Persistence & Synchronization**:
  - Exposed `trustedDirectories` from server configuration in the `/api/config` GET endpoint response.
  - Implemented client-side synchronization (`syncTrustedWorkspaces`) in the Chrome Extension side panel to automatically restore the saved workspaces list from the server's trusted directories list upon reloading or reinstalling.
  - Automatically pre-populates the workspace directory path input field on the setup screen using the server's last active workspace path.
  - Automatically synchronizes the selected orchestration mode (Single/Multi Mode radio buttons) on the setup screen with the server's current mode.

---

## [1.2.342] - 2026-07-13

### Added
- **Chrome Extension Tab Locking & Focus styling**:
  - Implemented automatic tab locking when the AI Agent is running to prevent context drift.
  - Automatically reverts tab changes back to the active tab, displays an inline warning banner, and handles agent-initiated tab creation/switching.
  - Added a global CSS override to `sidepanel.src.css` to disable focus outlines, rings, and box-shadow glows.

---

## [1.2.341] - 2026-07-13

### Added
- **Browser History, Reading List, Top Sites, and Management API Actions**:
  - Integrated 11 additional browser control actions: `top_sites`, `reading_list_add`, `reading_list_remove`, `reading_list_get`, `group_update`, `group_get`, `history_search`, `history_delete`, `history_clear`, `management_list`, `management_get`.
  - Added permissions for `history`, `readingList`, `topSites`, and `management` to `manifest.json`.
  - Expanded target parameter validation and updated CLI tool schemas.

---

## [1.2.340] - 2026-07-13

### Added
- **Extended Browser Tab & Window Control**:
  - Implemented 15 new browser control actions: `open`, `close`, `list`, `switch`, `duplicate`, `pin`, `unpin`, `mute`, `unmute`, `move`, `group`, `ungroup`, `discard`, `new_window`, `close_window`.
  - Added the `tabGroups` permission to the Chrome extension's manifest to support tab grouping APIs.
  - Updated the URL restriction handler to allow running background/lifecycle tab commands on system/restricted URLs.

---

## [1.2.339] - 2026-07-13

### Added
- **Image File Reading & Vision Integration**:
  - Enhanced `readTool` (`read`) and `readPeerSuperagentFileTool` (`read_peer_superagent_file`) to detect image file extensions and read them as base64 Data URIs rather than failing with a binary error.
  - Updated the agent execution loop in `src/core/agent.ts` to automatically scan tool outputs for base64 image Data URIs, clean them out of the raw text response, and append them as native vision image parts in subsequent turns.

---

## [1.2.338] - 2026-07-13

### Fixed
- **Chrome Extension Restricted Pages Handling**:
  - Added detection of restricted browser tabs (e.g., `chrome://`, `chrome-extension://`, `about:`, `edge://`) in `executeBrowserControl`.
  - Blocks content script injection and screenshot capture on restricted pages and returns a friendly, instructive error message guiding users to navigate to a regular webpage first.

---

## [1.2.337] - 2026-07-13

### Fixed
- **Chrome Extension Chat History Tool Calls Double Rendering**:
  - Prevented duplicate rendering of tool blocks in chat history logs when loading previous sessions.
  - Aligned lookahead matching logic to identify associated tool results inside subsequent messages of role `tool` and aggregate them cleanly within the primary tool call UI container.
  - Filtered out already-rendered tool calls in subsequent messages.

---

## [1.2.336] - 2026-07-12

### Optimized
- **Chrome Extension System Prompt & Context Rule**:
  - Rewrote Chrome Extension prompt context rules inside prompts.ts using Telegraphic English guidelines (removing conversational filler and pronouns).
  - Streamlined logic gates and structured workflow requirements to improve token efficiency and focus.

---

## [1.2.335] - 2026-07-12

### Added
- **Chrome Extension Tab Control Permissions**:
  - Added "tabs", "webNavigation", and "debugger" permissions to the manifest.json file to support full browser tab control, page navigation tracking, and Chrome DevTools Protocol automation.

---

## [1.2.334] - 2026-07-12

### Optimized
- **Plan Review Modal Integration**:
  - Expanded the Plan Approval Overlay modal width from 320px to 480px.
  - Embedded a scrollable, fully rendered Markdown plan details container inside the modal body.
  - Automatically fetches the generated `implementation_plan.md` via `/api/documents` and parses it into the viewport so the user can easily read and review the plan inline without having to open the workspace file manually.

---

## [1.2.333] - 2026-07-12

### Added
- **Browser Active Tab Indicator**:
  - Implemented a 9px active browser tab display banner at the top of the chat input wrapper.
  - Automatically queries the current browser window active tab title and URL dynamically on tab activations, title/URL updates, or panel loads.
  - Injected active tab title and URL context automatically into AI prompts (transparently to the user, except for direct terminal commands starting with `!`) to make the assistant fully context-aware of what page the user is currently viewing.

---

## [1.2.332] - 2026-07-12

### Fixed
- **Workspace Chat History Sync**:
  - Fixed a bug where switching chat sessions in the history tab would complete on the server but fail to update the chat message bubble list in the UI.
  - Ensured switching workspaces automatically refreshes the chat sessions list in the left sidebar history tab to always align with the active workspace.
  - Enabled passing `mode` as a query parameter when fetching previous history sessions to resolve correct directory (single vs multi) even if the active server session is not yet initialized.

---

## [1.2.331] - 2026-07-12

### Changed
- **Collapsible Process Logs**:
  - Re-architected job finish layout to collapse all previous execution logs (tool cards and reasoning blocks) under a clean header showing "Finished in Xm Xs" instead of hiding the summary response.
  - Left the main summary text bubble always visible for immediate readability when the agent completes its job.

---

## [1.2.330] - 2026-07-12

### Fixed
- **Right Side Panel Update Reliability**:
  - Globalized the custom fetch wrapper to `window.fetch` so it is inherited by the monitor and file explorer scripts loaded in the sidepanel.
  - Resolved race conditions where initial updates returned early because the panel was hidden during DOM load.
  - Implemented immediate refreshes for workspace file explorer and git changes when toggling the right side panel open or switching workspaces.

---

## [1.2.329] - 2026-07-12

### Fixed
- **Redundant Tool Log Rendering**:
  - Filtered out redundant plain text log lines (e.g., `web_search >` or `fetch_url >`) from message markdown rendering, resolving the visual double-show tool bug when tools are already displayed as interactive UI cards.

---

## [1.2.328] - 2026-07-12

### Changed
- **Response Stream and Summary Consistency**:
  - Configured response text to format as Markdown incrementally in real-time while streaming, ensuring visual consistency between the stream and the final state.
  - Simplified the job finish collapsible footer to directly toggle the visibility of the original chat bubble element instead of duplicating text in a separate summary card.

---

## [1.2.327] - 2026-07-12

### Changed
- **Preset Model Information**:
  - Configured preset select dropdown options to display their active target model name (e.g., `fast (gemini-2.5-flash)`) for better model visibility.
  - Adjusted header and toolbar select dropdown max-width limits to avoid excessive text truncation.

---

## [1.2.326] - 2026-07-12

### Changed
- **Workspace Listing Improvements**:
  - Redesigned workspace list items to display the workspace directory name, its parent path, and an initials-based circular avatar.
  - Used theme-safe dynamic colors (pastel backgrounds and matching texts) for workspace avatars.
- **Chrome Active Tab Attachment Removal**:
  - Removed "Attach Chrome Active Tab context" button and status badge from the chat input toolbar.
  - Deleted the active tab context grabbing feature from browser scripts.

---

## [1.2.325] - 2026-07-12

### Changed
- **Material-Style Visual Redesign for Chrome Extension**:
  - Redesigned color scheme, typography, and layout of the Chrome Extension side panel using premium Material-style design tokens (matching modern cloud platform console styling).
  - Configured Outfit and Roboto typography pairings for UI elements and JetBrains Mono/Roboto Mono for logs/terminals.
  - Reimplemented conversational chat bubbles with rounded corners (18px) and soft shadow systems for User (Material Blue tint card aligned right) and Agent (editor background card aligned left).
  - Updated Tailwind v4 border radiuses (`--radius-*`) and shadow parameters in CSS.
- **Project Guidelines Update**:
  - Updated styling guidelines in `AGENTS.md` to specify Material Design aesthetics instead of legacy dark theme rules.

---

## [1.2.324] - 2026-07-12

### Fixed
- **Workspace-Scoped History Session Filtering**:
  - Defined resolveWorkspacePath(req) to resolve the client's current workspace directory via headers, even if no agent session has been active or initialized yet.
  - Configured /api/history/sessions and related endpoints to use the resolved workspace path, correcting chat history session filtering.

---

## [1.2.323] - 2026-07-12

### Changed
- **Activity Bar Cleanup**:
  - Removed the redundancy of the Chat button icon in the Left Activity Bar.
  - The left menu now only contains "Workspace" and "History" tabs.

---

## [1.2.322] - 2026-07-12

### Changed
- **Removed Single Session Fallback**:
  - Removed the generic single session fallback inside resolveSession on the backend server to ensure workspace-scoped routing.
  - Fixes auto-reconnecting to background CLI sessions when the extension does not have an active workspace connected.

---

## [1.2.321] - 2026-07-12

### Changed
- **Workspace Empty State Screen**:
  - Hides the active chat panel completely and displays a full-screen "No Workspace Connected" placeholder panel (#workspace-empty-state) when no workspace is active.
  - Added a "+ Connect Workspace" trigger button in the empty state screen that summons the workspace add modal overlay.
  - Automatically toggles between the empty state panel and the active chat panel based on connection/switching status.

---

## [1.2.320] - 2026-07-12

### Changed
- **Mandatory Workspace Validation on Chat Inputs**:
  - Hides the "New Chat" button and chat action bar if no active workspace is connected.
  - Disables the chat input text field and displays a placeholder message instructing the user to connect a workspace first.
  - Automatically restores input state and shows chat actions when a workspace session is activated.

---

## [1.2.319] - 2026-07-12

### Added
- **Workspace-Scoped Session History Loading**:
  - Automatically loads and resumes the last active chat session and conversation history when switching workspaces on the server /api/switch-workspace endpoint.

---

## [1.2.318] - 2026-07-12

### Changed
- **Removed Saved Workspaces Header**:
  - Removed the redundant Saved Workspaces section heading from the Left Sidebar workspace tab layout to optimize visual space.

---

## [1.2.317] - 2026-07-12

### Changed
- **Removed Active Workspace Card**:
  - Removed the redundant Active Workspace card from the Left Sidebar workspace switcher.
  - Retained the active-workspace-text span element in the HTML as a hidden element to ensure script configuration backwards compatibility.

---

## [1.2.316] - 2026-07-12

### Changed
- **Add Workspace Modal Overlay**:
  - Moved the folder path input, browse button, and add workspace action button from the Left Sidebar into a dedicated overlay modal (#add-workspace-overlay).
  - Added a "+" trigger button to the Left Sidebar's Workspace panel header to display the modal overlay.
  - Hides the Add Workspace modal automatically upon a successful local server workspace session initialization.

---

## [1.2.315] - 2026-07-12

### Added
- **Draggable Left Sidebar Resizer**:
  - Inserted a draggable splitter handle (#sidebar-resizer) between the Left Sidebar and the Right Content Panel.
  - Implemented real-time resizing logic on mouse drag with min-width/max-width boundaries (120px to 380px).
  - Persisted the user's custom sidebar width locally via chrome.storage.local to maintain consistency across sidepanel restarts.

---

## [1.2.314] - 2026-07-12

### Changed
- **Activity Bar Workspace Tab Integration**:
  - Reorganized the Left Sidebar layout to run as a unified tab-view switcher container.
  - Added a dedicated Workspace folder icon button (#tab-workspace) to the Left Activity Bar.
  - Moved the Workspace Switcher list and Chat History list into the Collapsible Left Sidebar, displaying them dynamically under the 'Workspace' and 'History' headings.
  - Made the Chat panel view occupy the primary right main content view adjacent to the Left Sidebar, maintaining full editor height and maximizing visual workspace efficiency.

---

## [1.2.313] - 2026-07-12

### Fixed
- **Summary Response Duplication and Truncation**:
  - Saved raw streamed markdown directly onto the element dataset before HTML rendering inside sidepanel.js.
  - Updated appendJobFinishFooter to use this raw markdown, preventing the double-formatting of stripped plain text.
  - Removed the character length limits and truncation warnings from the collapsible summary card.
  - Removed white-space: pre-wrap from .job-summary-body and #summary-text modal elements, allowing correct markdown document flow and layout.

---

## [1.2.312] - 2026-07-12

### Changed
- **Activity Bar Panel Toggling**:
  - Implemented smart toggling of the Left Sidebar panel by clicking the active tab button in the activity bar, enabling users to hide/show the workspace sidebar to expand or collapse the main chat area layout.

---

## [1.2.311] - 2026-07-12

### Changed
- **Chrome Extension Branding and Logo Refresh**:
  - Renamed the extension to 'Super Agent R - AI Autonomous your working.' inside manifest.json and updated the sidepanel title.
  - Replaced the extension logo icons (16x16, 48x48, and 128x128) with a newly generated abstract glowing logo.
  - Simplified the header logo container inside sidepanel.html by renaming the heading to 'Super Agent R' and removing the decorative glow-dot.

---

## [1.2.310] - 2026-07-12

### Changed
- **Chrome Extension Welcome Screen and Sidebar Refactor**:
  - Simplified welcome/setup screen to only ask for the orchestration mode, API token, and session resume toggle.
  - Relocated orchestration mode and preset select dropdown into the main top header bar.
  - Implemented a dedicated Left Sidebar for workspace browser/selector management featuring a list of saved workspaces, current active workspace status card, and a "+ Add Workspace" folder path input.
  - Added seamless lazy-initialization logic that defers server session startup (`/api/init`) until a workspace is selected or added inside the main workspace view.

---

## [1.2.309] - 2026-07-12

### Added
- **Interactive Tool Execution Rows in Chat Stream**:
  - Upgraded tool block headers in `sidepanel.js` and `sidepanel-history.js` to display the raw tool name and a summary of call arguments formatted inside parentheses (`tool_name(arg: val)`).
  - Added a live status indicator to the header row that displays `running...` (blue) while the tool executes, and updates to `✓ done` (green) or `✗ failed` (red) upon completion.

---

## [1.2.308] - 2026-07-12

### Added
- **Completed Tasks 15-second Decay and Auto-Hide**:
  - Implemented a 15-second countdown timer (`~ Hide in (Xs)`) inside `renderTasks` in `sidepanel.js` for completed tasks, matching the CLI task checklist behavior.
  - Setup a local 1-second interval execution loop in the extension that re-renders the tasks panel dynamically while completed tasks with active countdown timers are present.
  - Configured automated filtering that excludes completed tasks once their decay countdown is completed.

---

## [1.2.307] - 2026-07-12

### Fixed
- **Chrome Extension Link Style and Custom List Icons**:
  - Implemented the `.text-vscode-bright` CSS class inside `sidepanel.src.css` using the vscode bright color `#007fd4` so that markdown and file links are visibly styled as blue links.
  - Upgraded raw filepath detection regex in `sidepanel-markdown.js` and `sidepanel-ui.js` to match Windows/POSIX directory paths and file names safely using lookbehinds.
  - Replaced browser default bullet points (`disc` dots) for messages with a clean absolute-positioned dash prefix `-` inside `sidepanel.src.css`.

---

## [1.2.306] - 2026-07-12

### Removed
- **Redundant Halt Execution Button**:
  - Removed the `btn-abort` ("HALT EXECUTION") button from the workspace session header inside `sidepanel.html`.
  - Cleaned up the `btnAbort` reference and its click listener event registration inside `sidepanel.js`.

---

## [1.2.305] - 2026-07-12

### Fixed
- **Chrome Extension Markdown Link Parsing**:
  - Restored links and list parsing inside `formatMarkdown` in `sidepanel-markdown.js` which previously overrode `sidepanel-ui.js` and caused markdown links to render as plain text.
  - Added a global click listener inside `sidepanel.js` to catch clicks on local `file:///` links and send a request to a new `/api/workspace/file/open` server endpoint.
  - Implemented the `/api/workspace/file/open` endpoint in `src/server.ts` to launch local files in their default associated programs using `execa` with path traversal protection.

---

## [1.2.304] - 2026-07-12

### Added
- **Chrome Extension Tasks Collapse/Expand Feature**:
  - Implemented an interactive header toggle with a geometric chevron pointer (`▼` / `▶`) inside `sidepanel.html` that allows users to collapse or expand the persistent tasks checklist content.
  - Added click listener registration on `#persistent-tasks-header` inside `sidepanel.js` to toggle visibility of `#persistent-tasks-content`.
  - Configured `renderTasks` and `clearChatMessages` to automatically expand the checklist and reset the chevron back to expanded (`▼`) whenever tasks are updated or cleared.

---

## [1.2.303] - 2026-07-12

### Changed
- **Chrome Extension Tasks Checklist Spacing and Font Size**:
  - Decreased the font size of the persistent task checklist panel to 10px (header to 8.5px, count to 8px, task items to 10px, icons to 9px).
  - Reduced padding and gap sizes across the panel (p-1.5, gap-1) and decreased row vertical spacing (py-[1px], gap-1.5).
  - Reduced the max-height constraint from 58px to 50px to fit 3 smaller items perfectly.

---

## [1.2.302] - 2026-07-12

### Changed
- **Chrome Extension Tasks Checklist Layout**:
  - Replaced the in-stream task message cards with a dedicated persistent task checklist panel positioned right above the input box.
  - Implemented a visible limit of 3 task items max (`max-h-[58px]`) with scrollability for overflow.
  - Refactored `renderTasks` and `renderAgentsTree` to target the new persistent panel, and added clear/reset routines inside `clearChatMessages`.

---

## [1.2.301] - 2026-07-12

### Fixed
- **Chrome Extension First Message Loading Indicator**:
  - Introduced `window.isWaitingForAgentStart` state to track when a chat message has been sent but the agent hasn't started running yet.
  - Updated the background status polling checks to not reset the thinking spinner and send button state while waiting for agent execution.

---

## [1.2.300] - 2026-07-11

### Fixed
- **Chrome Extension Streaming Scroll Follow**:
  - Configured a dynamic scroll threshold that increases to 200px while the AI is actively processing or thinking, ensuring auto-scroll successfully follows fast-streaming logs and content without being broken by large layout updates.

---

## [1.2.299] - 2026-07-11

### Changed
- **Chrome Extension Inline Task Checklist Updates**:
  - Re-architected task list rendering to dynamically append a new task checklist card directly in the scrollable chat message list only when the task state changes, preserving a historical timeline of checklist transitions.
  - Linked active subagent and superagent chips to render dynamically inside the most recently appended checklist card.

---

## [1.2.298] - 2026-07-11

### Fixed
- **Chrome Extension Smart Auto-Scrolling**:
  - Implemented a smart scroll behavior inside `scrollToBottom` that only auto-scrolls to the bottom when new content/progress is received if the user was already near the bottom.
  - Allowed forcing the scroll behavior explicitly during direct user actions (like sending messages).

---

## [1.2.297] - 2026-07-11

### Fixed
- **Chrome Extension Dropdowns Dark Mode**:
  - Configured dark background and light text styling for all standard `<select>` and `<option>` elements to adhere strictly to the extension's VS Code dark theme aesthetic.

---

## [1.2.296] - 2026-07-11

### Fixed
- **Chrome Extension Checklist Persistence**:
  - Restored tasks checklist card persistence by removing overridden, buggy `clearChatMessages` definitions.
  - Set checklist card to remain visible constantly in the chat pane, displaying a clean "No active tasks" state instead of being hidden when empty.

---

## [1.2.295] - 2026-07-11

### Changed
- **Chrome Extension UI Relayout**:
  - Moved the execution task checklist card directly into the scrollable chat messages area (above the typing indicator) instead of showing it on top of the prompt inputs.
  - Placed active subagents and superagents list inside the same execution tasks card.
  - Removed the collapsible bottom terminal drawer completely, streaming active tool terminal logs and outputs directly inside the auto-expanded tool result details within the chat message stream.

---

## [1.2.294] - 2026-07-11

### Fixed
- **Chrome Extension Preset Select Dropdowns**:
  - Restored rendering and population of standard quick-preset-select and input-preset-select dropdown selectors.
  - Linked selection changes to active preset update APIs correctly.

---

## [1.2.293] - 2026-07-11

### Added
- **Chrome Extension Tool Parameter Details and Full Result Expanse**:
  - Added an Expand Full Result button to truncated tool output results inside the chat message stream.
  - Added an Expand Full Summary button to truncated job summary cards.
  - Improved tool detail rendering inside `buildToolDetail` to present rich snippets of parameter values (command lines, queries, file relative path segments, lines ranges, subagent roles, and prompts) instead of only printing simple filenames.

---

## [1.2.292] - 2026-07-11

### Fixed
- **Chrome Extension UI Auto-Hiding**:
  - Automatically hide the status checklist strip (Tasks and Agents) when no tasks are present in the list and no subagents/superagents are running.
  - Automatically hide the collapsible bottom terminal panel by default on load, when there is no active process running, and when the terminal output logs are empty.
  - Added CSS utility overrides and script checks to toggle visibility dynamically.

---

## [1.2.291] - 2026-07-11

### Added
- **Chrome Extension Workspace Monitor Side Panel**:
  - Implemented a collapsible right-side panel layout showing active file changes, running background processes, and active subagents/superagents.
  - Added backend endpoints in `server.ts` (`/api/git/changes`, `/api/background-tasks`, `/api/background-tasks/kill`).
  - Added toggle button in the header bar with persistence state saved in local storage.
  - Created `sidepanel-monitor.js` script to fetch, map status levels, and render live updates.

---

## [1.2.290] - 2026-07-11

### Removed
- **Chrome Extension Plan, Tasks, and Walkthrough Left Tabs**:
  - Deleted Plan, Tasks, and Walkthrough tab button triggers from the left activity bar.
  - Deleted the corresponding view panes (`view-plan`, `view-tasks`, `view-walkthrough`) from the layout.
  - Simplified the switch tab listener logic and cleaned up unused DOM element references and handlers in `sidepanel.js`.

---

## [1.2.289] - 2026-07-11

### Fixed
- **Chrome Extension Tasks Layout and Sync**:
  - Relocated the status checklist strip (Tasks and Agents) from the top of the chat view to the bottom, positioned directly above the input footer.
  - Implemented collapsible capability for the status strip with a toggle button click listener (Tasks ▾ / Tasks ▸) to minimize vertical space usage.
  - Fixed `/api/tasks` and `/api/documents` backend endpoints to fetch plan, task, and walkthrough markdown content from the session-specific history path (via `session.agent.getTaskFilePath()`, etc.) instead of workspace root directories when a session is active.

---

## [1.2.288] - 2026-07-11

### Fixed
- **Chrome Extension Loading/Process Button States**:
  - Prevented premature hiding of the spinner and reverting of the send button state on intermediate events like `text`, `reasoning`, and `tool_end`.
  - Added robust synchronization of spinner visibility, chat input text disabled state, and process button (send/stop) state with the `/api/status` endpoint's `data.agentRunning` value.
  - Enabled active/generating feedback on text and reasoning streams instead of resetting UI early.

---

## [1.2.287] - 2026-07-11

### Refactored
- **Chrome Extension Code Modularization**:
  - Split `chrome-extension/sidepanel.js` (previously 1880+ lines) into modular scripts to keep all codebase files strictly under 1000 lines.
  - Created `chrome-extension/sidepanel-ui.js` (670 lines) containing all DOM rendering, helpers, tool labels, and formatting logic.
  - Created `chrome-extension/sidepanel-history.js` (240 lines) containing all chat history and session switching controls.
  - Reduced `chrome-extension/sidepanel.js` to 959 lines containing core orchestrators, SSE events, and event listeners.
  - Updated `chrome-extension/sidepanel.html` to load split modules in correct dependency order.

---

## [1.2.286] - 2026-07-11

### Changed
- **Chrome Extension Finished Flow Enhancements**:
  - The job summary card is now default expanded (open) when a job finishes.
  - Automatically scrolls the summary card smoothly into view when a job completes.
  - Tool execution blocks (tools usage) are now automatically collapsed (hidden) when a job finishes.
  - Clicking the "Finished in Xm Xs" badge row will toggle the visibility of the collapsed tool blocks.

---

## [1.2.285] - 2026-07-11

### Changed
- **Chrome Extension Tool Stream Redesign**:
  - Tool execution blocks now render as clean single-line rows matching the screenshot style: `● Ran git add … ›` instead of the previous JSON-heavy verbose layout.
  - Added `getToolLabel()` that maps tool names to human-readable verbs: `Ran`, `Edited file`, `Read file`, `Explored directory`, `Searched`, `Spawned subagent`, etc.
  - Added `buildToolDetail()` to extract the key inline detail (filename basename or truncated command) shown in muted text next to the label.
  - Added `buildResultSuffix()` for inline result stats: edit tools show `+14 -0` diff counts, grep tools show `N matches`.
  - Status indicator changed from blinking bullet `•` to a 6px dot (blue=running, green=done, red=error).
  - Chevron `›` toggles to `⌄` on expand; expanded section shows args JSON + result output.
  - CSS fully replaced: removed old `.tool-header/.tool-indicator/.tool-name/.tool-desc` in favor of `.tool-row/.tool-status-dot/.tool-row-label/.tool-row-detail/.tool-row-suffix/.tool-row-chevron/.tool-expand`.

---

## [1.2.284] - 2026-07-11

### Added
- **Chrome Extension Job Finish Footer**:
  - After an agent finishes a task, a "Finished in Xm Xs" elapsed-time badge (green pill) now appears below the agent message in the chat.
  - A "Summary ▾" toggle button lets users expand/collapse a collapsible summary card showing the last portion of the agent's final response.
  - Timer starts on the first meaningful agent event (text output or tool execution) and stops on the `done` event.
  - All elements styled with VS Code dark theme aesthetics matching the existing extension design.

---

## [1.2.283] - 2026-07-11

### Added
- **Chrome Extension Plan Approval Flow**:
  - Server now exposes `planState` in `/api/status` response so the extension can detect when the agent is waiting for plan approval.
  - Added `/api/plan/approve` POST endpoint accepting `{ action: "approve" | "reject" }`. Approve calls `agent.approvePlan()` and resumes execution; Reject sets planState to IDLE and aborts.
  - Server broadcasts a `plan_approval_required` SSE event (with `planState`) when the agent emits a `done` event while in `PLANNING_PENDING` state.
  - Added a Plan Approval modal overlay in the Chrome extension side panel, following the VS Code dark theme, with Approve & Proceed and Reject Plan buttons.
  - Extension handles `plan_approval_required` SSE events to show/hide the overlay automatically.
  - `/api/status` polling fallback ensures the overlay re-appears on extension reload if the agent is already in `PLANNING_PENDING` state.

---

## [1.2.282] - 2026-07-11


### Changed
- **Chrome Extension Dedicated History Tab**:
  - Moved the chat session history switcher from a dropdown menu into a dedicated vertical tab in the left-side Activity Bar.
  - Added a History tab button and a dedicated `view-history` panel containing the list of previous sessions for the active workspace.
  - Configured client-side redirection to load the session and switch the active tab back to Chat when a session history item is clicked.

---

## [1.2.281] - 2026-07-11

### Changed
- **Chrome Extension Activity Bar Layout**:
  - Restructured the horizontal workspace tabs layout into a vertical, VS Code-style left Activity Bar.
  - Added SVGs for Chat, Plan, Tasks, and Walkthrough menu items.
  - Styled the vertical icons with hover states and a sleek left border highlight for the active menu option.

---

## [1.2.280] - 2026-07-11

### Added
- **Chrome Extension New Chat and Session History**:
  - Added New Chat and History buttons at the top of the Chat view in the extension panel.
  - Added a dropdown list of historical chat sessions for the active workspace, showing metadata (display name, preview, message count, and timestamp) for each session.
  - Implemented client-side switching to load a specific session history when clicked.
  - Implemented the ability to trigger a fresh empty chat session directly from the extension UI.
  - Exposed a new `GET /api/history/sessions` endpoint in server.ts.
  - Enhanced `listHistorySessions` in history.ts to accept a custom workspaceDir parameter and return the session ID.

---

## [1.2.279] - 2026-07-11

### Fixed
- **Chrome Extension JS Cleanup**:
  - Removed remaining references to the deleted `startServerTooltip` variable inside the global document click event listener block in sidepanel.js, resolving a ReferenceError.

---

## [1.2.278] - 2026-07-11

### Fixed
- **Chrome Extension Overlay Layout**:
  - Fixed a missing closing `</div>` tag for the `question-overlay` container in sidepanel.html which caused subsequent overlays (including the settings panel and job summary overlays) to be nested inside it, preventing the settings gear from opening.

---

## [1.2.277] - 2026-07-11

### Removed
- **Chrome Extension Server Controls**:
  - Removed start server help button, stop server button, and the start server command tooltip from the sidebar panel header.
  - Cleaned up event listeners, DOM elements, status visibility logic, and the shutdown/stop server API request function from sidepanel.js.

---

## [1.2.276] - 2026-07-11

### Changed
- **Chrome Extension Settings Panel**:
  - Relocated advanced settings from the setup screen body into a global settings modal overlay.
  - Added a settings gear button (`btn-header-settings`) in the top right corner of the extension header, allowing real-time access to presets, streaming config, rate limits, and concurrency limits from both the setup and active workspace screens.

---

## [1.2.275] - 2026-07-11

### Added
- **Chat History Loading in Chrome Extension**:
  - Implemented public `getConversationMessages()` helper in `Agent` class to return the messages.
  - Implemented `/api/history` GET endpoint in the extension server to serve conversation history of the active session.
  - Added support in `sidepanel.js` to fetch and render chat history (with formatting for reasoning blocks and collapsible tool blocks) when initializing a session, auto-reconnecting, or switching workspaces.

---

## [1.2.274] - 2026-07-11

### Added
- **Browser Control Tool**:
  - Implemented active control status banner overlay. A dark translucent banner with a pulsing red indicator dot and operation label now displays at the top center of the webpage during active browser automation steps, showing the current action and element target, and fading out after 3 seconds of inactivity.

---

## [1.2.273] - 2026-07-11

### Added
- **Browser Control Tool**:
  - Implemented visual virtual cursor simulation. An animated, translucent circular pointer now shows up and slides to target elements during `click`, `hover`, `keypress`, and `type` actions, showing clicks and type events with scaling/color animations and fading out after 3 seconds of inactivity.

---

## [1.2.272] - 2026-07-11

### Added
- **Browser Control Tool**:
  - Expanded `control_browser_tab` actions to support `hover` (trigger mouse hover states), `keypress` (trigger keyboards events like custom key values or simulated form submits), `wait` (pause for duration or wait for a CSS selector to exist), and `html` (retrieve elements' outerHTML).
  - Added new navigation actions: `reload` (page refresh), `back` (go back), and `forward` (go forward) using Chrome tabs history API.

---

## [1.2.271] - 2026-07-11

### Fixed
- **Browser Control Tool**:
  - Fixed `TypeError: Illegal invocation` error when executing the `type` action on custom elements or elements with `contenteditable="true"` (such as rich textareas on Gemini/Claude web interfaces) by checking element type before attempting to retrieve and call the native value setter.
  - Added proper fallbacks for `contenteditable` elements to use `innerText`.

---

## [1.2.270] - 2026-07-11

### Added
- **Workflow Job Summaries in Chrome Extension**:
  - Integrated subagent/superagent completion events in the extension server using `subscribeToSubagents`/`subscribeToSuperagents`.
  - Added SSE system messages broadcast when subagents/superagents complete, displaying report summaries directly inside the extension chat log.
  - Implemented automatic resume invocation for the parent agent via `agent.sendMessage` when background jobs complete.
  - Added `#summary-overlay` modal to display the detailed execution summary when clicking on completed agent chips in the status strip.
  - Styled task/agent chips with VS Code colors, hover states, and animations for active chips.

---

## [1.2.269] - 2026-07-11

### Added
- **Dedicated Extension Server & Multi-Session**:
  - Decoupled server execution from the CLI via support for the `--server-only` flag.
  - Implemented multi-session workspace tracking via `activeSessions` Map in the server.
  - Resolved sessions by checking a new custom request header `X-Workspace-Path`.
  - Added specialized browser system prompt and toolsets for extension-initiated agents.
  - Created `/api/documents` GET endpoint to fetch plan/tasks/walkthrough files.
- **Tabbed UI Sidepanel**:
  - Added Chat, Plan, Tasks, and Walkthrough tab navigation to the sidepanel.
  - Implemented visual markdown rendering for plans, checklists, and walkthroughs.
  - Enabled active chat logs and inputs even when connected to an active CLI session.
  - Allowed subagent status tree display in single mode.

---

## [1.2.268] - 2026-07-11

### Changed
- **Chrome Extension UI**:
  - Simplified tool block design by removing the toggle arrow button.
  - Replaced the indicator div with a simple bullet character (`•`) that changes color based on status (running is blue, success is green, error is red).
  - Made the entire tool header line clickable to toggle details expand/collapse state.

---

## [1.2.267] - 2026-07-11

### Added
- **Chrome Extension UI Streaming**:
  - Implemented real-time tool execution output streaming to the extension sidepanel client.
  - Subscribed `src/server.ts` to active command outputs and broadcasted them via SSE `tool_progress` event.
  - Added support in `sidepanel.js` to render the live stream inside the active tool block's result area, expanding it automatically.

---

## [1.2.266] - 2026-07-11

### Changed
- **Chrome Extension UI**:
  - Removed backgrounds and borders from tool execution blocks (`.tool-block`).
  - Reduced layout padding and margins for a flat, borderless, and compact terminal-style look.

---

## [1.2.265] - 2026-07-11

### Fixed
- **Chrome Extension UI**:
  - Fixed overlays (approval and question modals) and the processing indicator layout showing state.
  - Removed Tailwind's `hidden` utility class from toggled markup elements to prevent `!important` display locks.
  - Added dedicated styling rules for `.overlay` and `.processing-indicator` in `sidepanel.src.css` to govern their active state transitions.

---

## [1.2.264] - 2026-07-11

### Changed
- **Chrome Extension Styling**:
  - Fully refactored `sidepanel.html` to use Tailwind CSS v4 utility classes for all static layouts (forms, panels, buttons, cards, wrappers).
  - Cleaned and minimized `sidepanel.src.css` to only 438 lines, keeping only custom animations, scrollbars, and dynamic markup styling rules.

---

## [1.2.263] - 2026-07-11

### Changed
- **Chrome Extension Styling**:
  - Migrated styling compilation workflow to use Tailwind CSS v4.
  - Added `@tailwindcss/cli` devDependency and compilation scripts (`ext:css` / `ext:css:watch`) to `package.json`.
  - Refactored `sidepanel.html` components to use inline Tailwind utility classes.
  - Implemented `@theme` config inside `sidepanel.src.css` to map VS Code color variables.

---

## [1.2.262] - 2026-07-11

### Changed
- **Chrome Extension Styling**:
  - Redesigned the sidepanel UI with a premium VS Code Modern Dark theme aesthetic.
  - Replaced Roboto with Google Font "Inter" for UI text.
  - Rewrote `sidepanel.css` under 1000 lines (951 lines) to implement VS Code sidebar settings styles, flat border buttons, collapsible explorer-style tool trees, code-tab user messages, and comment-styled reasoning blocks.
- **Project Guidelines**:
  - Documented Chrome Extension Styling guidelines in `AGENTS.md` to enforce the VS Code theme style.

---

## [1.2.261] - 2026-07-11

### Fixed
- **Chrome Extension Tool Block Spacing**:
  - Removed separate backgrounds, borders, and margins from tool execution blocks (`.tool-block`) to integrate them inline with the message bubble background and border.
  - Resolved excessive/nested paddings by aligning tool headers and tool details directly to the message bubble's padding layout.

---

## [1.2.260] - 2026-07-11

### Fixed
- **Chrome Extension Spacing**:
  - Removed the background and border of the code/JSON arguments container (`.tool-args`) inside tool blocks to integrate it seamlessly with the tool detail block.

---

## [1.2.259] - 2026-07-11

### Fixed
- **Chrome Extension Padding and Spacing**:
  - Increased padding and spacing inside agent message bubbles, tool execution blocks, tool headers, and tool details in `sidepanel.css`.
  - Added border and comfortable padding around code/JSON arguments (`.tool-args`) in tool blocks to make them more readable and visually spacious.

---

## [1.2.258] - 2026-07-11

### Fixed
- **Overlay & Native Folder Browser Dialog Z-Index**:
  - Increased z-index of the `.overlay` element in `sidepanel.css` to 10000 to keep HTML dialogs topmost.
  - Enhanced the Windows PowerShell script in `src/server.ts` to show and activate the parent owner form when launching the native folder selection dialog, resolving the issue where the native directory picker opens behind the active browser window.

---

## [1.2.257] - 2026-07-11

### Added
- **Chrome Extension - Recent Workspaces History**:
  - Implemented a list of recently used workspace paths directly on the setup screen.
  - Added click handlers to automatically populate the workspace path input from history items.
  - Styled recent items under the workspace path input using Chrome-compliant variables.
  - Automatically refresh the list on the setup screen when new workspaces are loaded or switched.

---

## [1.2.256] - 2026-07-11

### Fixed
- **Chrome Extension - Setup Screen Scroll**:
  - Added overflow-y: auto and changed justify-content from center to flex-start in the #setup-screen section inside sidepanel.css to enable vertical scrolling and prevent top clipping of form controls when settings are expanded.

---

## [1.2.255] - 2026-07-11

### Changed
- **Chrome Extension - Modular Code Refactoring**:
  - Refactored `sidepanel.js` by splitting helper functions into separate files: `sidepanel-markdown.js` (markdown rendering), `sidepanel-workspaces.js` (workspace switcher), and `sidepanel-browser.js` (browser control). This keeps `sidepanel.js` and all other code files strictly under 1000 lines of code.
  - Updated `sidepanel.html` script loading tags to include the newly separated modules.

---

## [1.2.254] - 2026-07-11

### Added
- **Chrome Extension - Custom Log Row Styles**:
  - Implemented a parser in `sidepanel.js`'s `formatMarkdown` to detect tool action logs (such as `Edited`, `Explored`, `Ran`, `Worked`) and format them into cyberpunk/VS Code styled layout components.
  - Added CSS classes in `sidepanel.css` for file badges and diff stats rendering.

---

## [1.2.253] - 2026-07-11

### Added
- **Chrome Extension & Tooling - Text Extraction Action**:
  - Added the `text` action to the `control_browser_tab` tool in `otherTools.ts`.
  - Implemented the `text` action in the Chrome extension `sidepanel.js` scripting execution. It retrieves either a selector's text or the entire page's inner body text if no selector is passed.

---

## [1.2.252] - 2026-07-11

### Added
- **Chrome Extension Permissions**:
  - Added `<all_urls>` to `host_permissions` in `manifest.json` to enable capturing screenshots and executing scripts on all external web pages.

---

## [1.2.251] - 2026-07-11

### Changed
- **Chrome Extension - Compact Tool Spacing**:
  - Reduced top and bottom spacing of the tool execution blocks in the chat view to make them more compact.
  - Decreased padding inside the expanded tool details panel to 4px 8px.
  - Added targeted selector to lower the bottom padding of message content bubbles when they contain tool blocks, preventing excessive whitespace.

---

## [1.2.250] - 2026-07-11

### Changed
- **Chrome Extension - Thinking Indicator Inside Message Flow**:
  - Moved the processing (thinking) indicator inside the scrollable chat messages container so it flows inline with messages instead of sitting in a fixed position directly above the input box.
  - Adjusted the indicator spacing and padding to align with the left edge of agent message bubbles.
  - Updated chat messages clear and append operations to handle and preserve the inline indicator position.

---

## [1.2.249] - 2026-07-11

### Security
- **Extension Server - Localhost-Only Binding**:
  - Changed `server.listen(port)` to `server.listen(port, '127.0.0.1')` so the extension API server only accepts connections from the local machine. Previously it was binding to all network interfaces (`0.0.0.0`), making it reachable from other devices on the same network.

---

## [1.2.248] - 2026-07-11

### Fixed
- **Browse Dialog - "Bad Request" Error**:
  - Fixed `isBrowseDialogOpen` flag never being reset to `false` when the Windows folder picker dialog was cancelled or failed. An early `return` inside the inner catch block was bypassing the outer `finally` that resets the flag, causing every subsequent click on Browse to receive a 400 Bad Request response.
  - Fixed the extension showing the raw HTTP status text ("Bad Request") instead of the server's real error message. The extension now parses the JSON response body on non-ok responses and displays the actual error reason.

---

## [1.2.247] - 2026-07-11

### Changed
- **Chrome Extension UI - Chrome Browser Style**:
  - Replaced the cyberpunk dark neon theme with a clean, standard Google Chrome browser visual design.
  - Adopted a system-aware light/dark color palette matching Chrome's official color tokens (Google Blue `#1a73e8`, neutral greys, semantic greens/reds/ambers).
  - Switched font from Outfit to Roboto to match Chrome's native typeface.
  - Replaced hard square corners and neon glow effects with standard border-radius, subtle box shadows, and clean card borders.
  - Updated button styles to standard Chrome primary/secondary/danger patterns with no neon outlines.
  - Status badges now use soft pill shapes with semantic background tints.
  - Updated manifest description to remove cyberpunk reference.

---

## [1.2.246] - 2026-07-11

### Fixed
- **UI Visibility Issue**:
  - Added a generic `.hidden` class to the CSS styles to ensure that the Start Server button, command tooltips, and background panels are correctly hidden when the status is online.

---

## [1.2.245] - 2026-07-11

### Changed
- **Faster Status Polling**:
  - Decreased the server connection check interval from 5000ms to 1000ms in the extension, enabling instantaneous auto-detection when the local server starts up and goes online.

---

## [1.2.244] - 2026-07-11

### Added
- **Server Shutdown & Helper controls**:
  - Implemented a Stop Server button in the extension header that triggers a new `/api/shutdown` endpoint to terminate the local server process.
  - Implemented a Start Server help overlay that displays CLI launch instructions (`superagent --server`) when the extension is disconnected/offline.

---

## [1.2.243] - 2026-07-11

### Added
- **Cyberpunk Extension UI**:
  - Redesigned the Chrome Extension's side panel chat UI with a sleek, simple cyberpunk theme.
  - Implemented high-contrast dark backgrounds, neon accents (cyan, purple, pink, green), sharp borders, and monospace font styling.
- **Terminal Chat & Log Restriction**:
  - Restricted the Chrome Extension chat logs and input chat area when connected to a CLI-initiated session, replacing them with a status bridge screen.
  - Automatically spins up the extension API server silently in the background when running the `superagent` CLI.
  - Enabled dynamic registration of CLI-connected agents, ensuring active task checklists and subagents trees update in real-time in the Chrome Extension.

---

## [1.2.242] - 2026-07-11

### Added
- **Final Response Git Changes Summary**:
  - Implemented automatic git diff summary (+/- line count) of edited files at the end of each assistant run response in both CLI and dashboards.
  - Added new git snapshot comparisons to count lines added/deleted in tracked and untracked files relative to the start of the message process.
  - Conformed summary output styling to plain text and single-level bullet points without any markdown decoration.

---

## [1.2.241] - 2026-07-10

### Changed
- **Tool reliability optimization**:
  - Added recovery guidance for stale exact-match edits and risky batched edits.
  - Clarified one-path-per-call usage for `ripgrep_search`.
  - Clarified `manage_subagents` report action naming.
  - Added Windows Git Bash `npm.cmd` fallback handling for validation commands.

---

## [1.2.240] - 2026-07-10

### Changed
- **System prompt optimization**:
  - Removed unsupported `invoke_subagent` `Subagents` array guidance from prompt rules.
  - Replaced stale `manage_tasks_bulk` guidance with existing `manage_tasks` bulk actions.
  - Aligned Master Agent research workflow with available orchestration tools.
  - Simplified Superagent and Subagent final report formats to avoid conflicting markdown-style requirements.
  - Hardened process-kill guidance to require PID-specific termination across runtimes.
  - Scoped plain-text response rules to final user responses while preserving Markdown for plans and prompt templates.
  - Removed Indonesian plan-template aliases from new Master planning guidance.
  - Clarified direct research vs Superagent research escalation.
  - Constrained fallback/reviewer-like subagent toolsets to reduce unintended side effects.
  - Kept critical system guidance in text when large prompt image conversion is active.

---

## [1.2.239] - 2026-07-10

### Removed
- **Feature: tencentdb**:
  - Removed "Feature: tencentdb" configuration option from the model preset wizard and the keyboard handler's configuration menus.
  - Excluded "tencentdb" from the known subagents list in the `/model` command.

---

## [1.2.238] - 2026-07-10

### Added
- **Edit Option to /login Command**:
  - Added a new `edit` subcommand to `/login` for editing existing provider profiles: `/login edit <provider_id> [new_api_key]` and `/login edit <provider_id> custom <new_base_url> <new_api_key>`.
  - Added "Edit an Existing Provider" option in the interactive `/login` wizard (Step 1).
  - Implemented wizard steps to select a provider, edit the API Key, edit the Base URL, and run connection tests.
  - Added full test coverage for slash command edits and wizard edit flows.

---

## [1.2.237] - 2026-07-10

### Changed
- **Mouse Scroll Amount**:
  - Increased conversation log/chat scroll speed from 1 line to 10 lines per scroll tick in single-agent and multi-agent dashboard modes.
  - Increased focused response view scroll speed from 1 line to 10 lines per scroll tick.

---

## [1.2.236] - 2026-07-10

### Changed
- **Prevent Redundant Skill Discovery**:
  - Updated `loadAgentSkills` logic instructions to forbid the agent from running `get_skills` or `use_skill` for skills that are already preloaded or defined in its system prompt context (such as `karpathy-guidelines`, `pragmatic-minimalism`, `systematic-debugging`, etc.).
  - Guided the agent to check the prompt context first and use preloaded instructions directly, preventing redundant tool calls and token waste.

---

## [1.2.235] - 2026-07-10

### Changed
- **get_skills Prompt Optimization**:
  - Updated `loadAgentSkills` query construction instructions to guide agents to use specific queries when exploring a codebase (e.g. `learn codebase design technology`) or diagnosing a new problem (e.g. `[problem] [technology] debug`).
  - Replaced empty `call get_skills()` references in Master Agent, Researcher, Coder, and Reviewer system prompts with query-based `call get_skills(query)` alongside inline examples to discourage empty queries and optimize matching precision.

---

## [1.2.234] - 2026-07-10

### Added
- **Global Skills Directory**:
  - Added `$USERPROFILE/.agents/skills/` (using `path.join(os.homedir(), ".agents", "skills")`) to the default global search directories in `getInstalledSkills()`, allowing skills installed via `npx skills add` to be automatically recognized by the `use_skill` tool and other skill registries.
  - Added unit test coverage for verifying that skills in `~/.agents/skills` are correctly loaded.
- **Skills Prompt Update**:
  - Updated skills discovery and instruction loading prompts in the core agent and config to instruct agents to use the `use_skill` tool instead of `view_file`.

---

## [1.2.233] - 2026-07-10

### Changed
- **TencentDB Memory Gateway Disabled**:
  - Forced `isTencentdbActive` to always return `false`, disabling all TencentDB gateway checks.
  - Hardcoded `enableTencentdbMemory` setting default to `false` and forced useTencentdbStatus hook to return `"disabled"`.
  - Removed all `tdai_memory_save` references from system prompt rules.
  - Made `runTencentdbSetup` a no-op function to prevent automatic gateway installation and startup.
  - Disabled `/setting-tencentdb` and `/memory` commands to return a disabled feature message.

---

## [1.2.232] - 2026-07-10

### Changed
- **Wizard Option Labels**:
  - Renamed "Subagent: researcher", "Subagent: coder", "Subagent: reviewer", "Subagent: classifier", and "Subagent: tencentdb" labels to "Feature: researcher", etc. in the model selection wizard to clarify their feature-specific nature.

---

## [1.2.231] - 2026-07-10

### Fixed
- **Mouse Click Accuracy**:
  - Expanded collapsible log lines click detection width to full terminal width, fixing a bug where clicking right of emoji characters (like ❓, ↳, ✓, ⚡) would miss due to emoji characters being counted as single-width in `visibleLength()`.
  - Replaced reverse math offset calculation for wizard option clicks with a context-based forwarding offset calculation, ensuring correct click row alignment in multi-question ask_question prompts, login setup, and model preset configurations.
  - Fixed failing `tests/skillsFiltering.test.ts` test assertion checking for the outdated `use_skill` tool to expect `view_file` instead.

---

## [1.2.230] - 2026-07-10

### Fixed
- **Bulk Tool Result Display**: When clicking to expand a bulk tool call in the conversation log, the output section now lists all files that were read or edited instead of showing a truncated 500-character raw dump.
  - `read` with `filePaths` array: shows "Read N files:" followed by each file path.
  - `edit` with `edits` array (multi-file): shows "Edited N files:" followed by each unique file path.
  - `write` with `files` array: shows "Wrote N files:" followed by each file path.
  - `apply_patch` with `patches` array: shows "Patched N files:" followed by each file path.
  - Single-file and non-bulk tools continue to show truncated raw output as before.
- Added `toolCall?: ToolCall` to the `tool_end` `AgentEvent` type in `agent.ts` and pass `toolCall: tc` at the main execution emit site so the UI can access the original tool arguments when building the expanded result view.

---

## [1.2.229] - 2026-07-10

### Changed
- TencentDB Inactive Handling: Automatically exclude tools starting with `tdai_` and clean up `tdai_` references from the system prompt if the TencentDB Memory Gateway is disabled in settings or offline (unreachable).
- Caching: Implemented `isTencentdbActive` in `tencentdbUtil.ts` with a 15-second TTL cache for gateway checks to keep the agent execution loop fast.
- Tests: Added unit tests for connection and cache logic in `tests/tencentdbUtil.test.ts` and updated mocks across other tests.

---

## [1.2.228] - 2026-07-10

### Fixed
- Model Limits: Extended cache override logic to cover generic 200k fallback limits (such as for Claude models). This ensures that custom endpoints or proxies returning generic 200k limits are successfully overridden by the correct 1M static limits for Claude 5 models (Sonnet 5, Fable 5, Opus 5).

---

## [1.2.227] - 2026-07-10

### Fixed
- Model Limits: Prioritized rich static limit lookups over `models_cache.json` in `getContextWindowLimit()` to prevent placeholder/generic limits (like 128k) from custom endpoints or proxies overriding known limits.
- Suffix Stripping: Added support for stripping `-free` suffixes in addition to `:free` suffixes when determining model limits.

---

## [1.2.226] - 2026-07-10

### Changed
- Model Limits: Added fallback context window limits for Claude 5 models (Sonnet 5, Fable 5, Opus 5) to 1,000,000 tokens, and Grok 4.5 to 500,000 tokens in `model_limits.ts`.
- Verification: Added corresponding unit test assertions in `config.test.ts`.

---

## [1.2.225] - 2026-07-10

### Added
- Configurable Tiers: Added dedicated model preset configuration options for the request `classifier` and `tencentdb` subagent/gateway tiers.
- Wizard & UI: Updated the terminal model configuration wizard and the keyboard handler's selection menu to support configuring classifier and tencentdb models.
- Core Agent Integration: Updated request classification to use the dedicated classifier tier model (resolved via getModelInstanceForTier) rather than falling back to the main agent model by default.
- Robustness: Migrated keyboard handler model selections from index-based mapping to string-based parsing, resolving wizard test breaks.

---

## [1.2.224] - 2026-07-10

### Changed
- Prompt Optimization: Refactored the loadAgentSkills instruction prompt and system prompts (Master, Researcher, Coder, Reviewer) in prompts.ts using Concept A, B, and C guidelines to optimize token usage and enforce logic gate execution.
- Verification: Updated tests/skillsFiltering.test.ts to align with the new minified skills prompt structure.

---

## [1.2.223] - 2026-07-10

### Added
- Skill Execution: Added `use_skill` tool to explicitly activate and load instructions for specialized skills.
- Toolsets Integration: Registered `use_skill` tool in all agent tier toolsets (Master, Superagent, Subagents) and default subagent toolset.
- System Prompts: Updated system prompts (Master, Researcher, Coder, Reviewer) and dynamic skill loading configuration to mandate calling `use_skill` when relevant skills are found.
- Verification: Added comprehensive unit tests in `tests/skillsTool.test.ts` and updated assertions in `tests/skillsFiltering.test.ts`.

---

## [1.2.222] - 2026-07-10

### Fixed
- Browse Dialog: Resolved issues with the Windows FolderBrowserDialog by executing PowerShell with the `-NoProfile -ExecutionPolicy Bypass` flags and passing a topmost form owner to force the dialog window to the foreground.

---

## [1.2.221] - 2026-07-10

### Fixed
- Security & Compatibility: Resolved CSP (Content Security Policy) violations on external websites by migrating the console error interception script to a dedicated native main-world content script (`main-world.js`) registered via `manifest.json`, eliminating inline script tag injection.

---

## [1.2.220] - 2026-07-10

### Fixed
- Bug: Fixed string quoting syntax in PowerShell folder selector command line that prevented the native Windows Forms folder browser dialog from launching when requested by the Chrome extension.

---

## [1.2.219] - 2026-07-10

### Changed
- Configuration: Updated default local server port from 3000 to 7888 across the extension client, CLI parser, and documentation.

---

## [1.2.218] - 2026-07-10

### Added
- Feature: Added a native directory selection dialog triggered by a "Browse" button in the Chrome Extension, utilizing OS-specific commands (PowerShell on Windows, AppleScript on macOS, Zenity/KDialog on Linux) to safely populate the local workspace path.

---

## [1.2.217] - 2026-07-10

### Improved
- Documentation: Updated README.md to document the Chrome Extension integration and local server capability, including detailed setup, installation, and usage instructions.

---

## [1.2.216] - 2026-07-10

### Improved
- Security: Added support for optional local engine API token headers and storage (`lastApiToken`) to secure the connection to the Superagent server.
- Stability: Added robust try-catch and chrome.runtime.lastError verification to executeScript calls in the Chrome extension sidepanel script to prevent extension crashes on restricted pages (e.g., chrome:// tabs).
- Diagnostics: Configured main-world wrapping for console.error calls to capture page-specific console errors inside of the extension's __capturedErrors stream.
- Compatibility: Supported React/Vue-compatible typing in the browser automation control utility by overriding native property setters.

---

## [1.2.215] - 2026-07-10

### Added
- Added local HTTP and Server-Sent Events (SSE) server (`--server` / `-s` CLI flag) to programmatically orchestrate Single and Multi mode agents.
- Added a feature-rich, cyberpunk-themed Chrome Extension containing:
  - Mode switching between Single and Multi.
  - Streaming chat output separating Agent reasoning from standard text.
  - Interactive popup dialogs to handle tool execution approvals and decision questions.
  - Dynamic 3-Tier Multi-Agent hierarchy visualization.
  - Workspace task checklist synchronization.
  - Active tab context extraction to grab page content or code selections directly from Chrome.

---

## [1.2.214] - 2026-07-10

### Added
- Updated get_skills tool to automatically include matching skill file contents when queried, reducing the number of tool calls needed for the agent to read skill files.

---

## [1.2.213] - 2026-07-09

### Fixed
- Fixed API model fetching bug in /model wizard command by normalizing base URLs (ensuring protocol, stripping trailing slashes) to prevent failed to parse URL and double slash errors.
- Supported model fetching for custom Anthropic provider configurations by allowing models to be fetched when a base URL is specified instead of returning early.

---

## [1.2.212] - 2026-07-09

### Fixed
- Implemented parameter fallback resolution for `superagentIds` in `manage_superagents`.
- Implemented parameter fallback resolution for `superagentId` and `message` in `send_message_to_superagent`.
- Implemented parameter fallback resolution for `recipientId` and `message` in `send_message` (subagent tool).

---

## [1.2.211] - 2026-07-09

### Fixed
- Fixed `manage_subagents` tool schema mismatches by implementing fallback parameter resolution for `conversation_id`, `conversation_ids`, and `conversationId` into the expected plural `conversationIds` array.
- Updated `BATCH_OPS_RULE` in `src/core/prompts.ts` to instruct the AI to use `conversationIds` and avoid singular `conversation_id`.

---

## [1.2.210] - 2026-07-09

### Fixed
- Fixed tool description formatting displaying `(missing)` for file operations by checking for the `args.path` parameter alias in `getToolDescription` and `resolveFilePathFromArgs`.
- Fixed subagent invocation failure and `(missing)` UI labels by checking for `agent_name`, `agent_role`, and `initial_message` aliases inside the `invoke_subagent` tool execution and description parser.
- Fixed `multi_replace_file_content` failures by supporting `replacements` and `oldContent`/`newContent` chunk parameters aliases in both bulk and single-file mode.
- Support `branchName` and `agent_role`/`prompt` aliases for `invoke_superagent` to prevent arguments parsing mismatches.

---

## [1.2.209] - 2026-07-09

### Fixed
- Fixed 413 Payload Too Large infinite compaction loop by introducing a payload413Count limit of 3, progressive budget reduction factor, post-compaction size verification, and adaptive message truncation threshold.

---

## [1.2.208] - 2026-07-09

### Fixed
- Fixed payload compaction loop on low-limit gateways (e.g. 100KB) by dynamically parsing the body limit from 413 error messages.
- Cached the parsed payload limit on the Agent instance to proactively trigger pre-flight check compaction and prevent redundant failed API requests.

---

## [1.2.207] - 2026-07-09


### Fixed
- Fixed 413 Request Entity Too Large error handling to recover successfully on gateways with a strict 100KB request limit by lowering the minimum compaction byte budget floor from 100KB to 20KB.

---

## [1.2.206] - 2026-07-09

### Fixed
- Fixed a selection and model fetching bug in the model wizard (`/model`) where selecting an existing custom provider profile (e.g., `dddd`) at step 2 was not supported, resulting in an `Invalid provider type choice` error. The wizard now correctly recognizes existing provider profiles at step 2, transitions directly to the model selection step (step 15), and fetches models using the profile's configured base URL and API token.
- Fixed a lookup failure in `getContextWindowLimit()` where model names containing provider prefixes (e.g., `dddd@claude-sonnet-4.5-1m`) failed to match the models cache or static limits lookup because the prefix was not stripped, falling back to a default limit of 256000. It now strips the `@` prefix before matching.

---

## [1.2.205] - 2026-07-09

### Fixed
- Fixed an infinite loop during `413 Payload Too Large` retry attempts. The engine now progressively and dynamically halves the pruning byte budget on each consecutive retry attempt, successfully reducing payload size below the gateway's actual limit.
- Updated `compactHistoryIfNeeded` and its context manager helper methods to accept an optional `byteBudget` parameter.
- Updated unit test assertions to match the new compaction method signature.

---

## [1.2.204] - 2026-07-09

### Added
- Added support for the `claude-sonnet-4.5-1m` model by registering its static context window limit (1,000,000 tokens) in `model_limits.ts` and adding a fallback keyword matcher.

---

## [1.2.203] - 2026-07-09

### Optimized
- Optimized AI request classifier pipeline: heuristic-first with confidence threshold — skips LLM call entirely when heuristic returns high confidence, saving tokens and latency on every turn.
- Converted keyword arrays to Sets with word-boundary matching via splitKeywords/countKeywordMatches to eliminate substring false positives (e.g., "error" no longer matches inside "terrorist", "fix" no longer matches "prefix").
- Added meetsThreshold helper for clean confidence comparison logic.
- Precompiled all RegExp patterns (EDIT_VERBS_RE, EDIT_INTENT_RE, PUNCTUATION_STRIP_RE, WORD_SPLIT_RE) at module level instead of re-creating per call.
- Compressed LLM classification prompt from ~500 to ~300 characters, reducing token usage when LLM fallback is needed.
- Made the classifierConfidenceThreshold setting functional (was previously ignored in the pipeline).

---

## [1.2.202] - 2026-07-09

### Fixed
- Fixed baseUrl resolution when applying model presets by applying ensureProtocol right before constructing the model client and when retrieving connection details for a tier in models.ts.

---

## [1.2.201] - 2026-07-09

### Fixed
- Added a URL protocol normalization helper (ensureProtocol) to automatically prepend https:// (or http:// for local endpoints) to custom base URLs that do not have a protocol prefix, preventing URL parsing failures when connecting to custom/OpenAI-compatible endpoints.

---

## [1.2.200] - 2026-07-09

### Fixed
- Added Google Gemini option to the dashboard keyboard handler, keyboard helper navigation, and wizard option templates so option 6 is shown on step 2 of the login wizard.

---

## [1.2.199] - 2026-07-09

### Fixed
- Added Google Gemini to the /login command line usage output helper text.

---

## [1.2.198] - 2026-07-09

### Fixed
- Fixed Gemini login provider registration list to always show all default templates so users can add multiple provider profiles.
- Updated login wizard's resolved test model and model filtering logic for native Gemini provider type to correctly filter models by prefix and resolve test model.
- Fixed models cache logic in fetchAndCacheModels to correctly read inputTokenLimit and fall back to static limits or 128000 when missing/falsy.

---

## [1.2.197] - 2026-07-09

### Fixed
- Fixed a security/boundary check bypass in permissions.ts where the bulk patches array parameter (used by the apply_patch tool) was not evaluated during tool description, out-of-bounds, model-config, and sensitive environment file checks.

---

## [1.2.196] - 2026-07-09

### Fixed
- Fixed a bug where `args.filePaths` containing per-file option objects (e.g., `{ path, offset, limit }`) were incorrectly serialized as `[object Object]` in tool descriptions and bypassed out-of-bounds safety boundary checks. Now, file path objects are correctly extracted and checked.

---

## [1.2.195] - 2026-07-08

### Changed
- Strengthened the `PROTECT_PROCESS_RULE` in `src/core/prompts.ts` to explicitly forbid global taskkill or pkill commands on `node` / `node.exe` processes (which terminates the parent process and crashes the session).
- Instructed agents to only kill child processes by specific PID, or safely terminate `bun` / `tsx` processes globally if a process is locked.

---

## [1.2.193] - 2026-07-08

### Fixed
- Fixed a bug in `normalizePathsForImage` where Windows backslash paths containing brackets or parentheses (e.g. `Program Files (x86)`) were not normalized to forward slashes before text-to-image rendering, causing AI models to misread file paths.

---

## [1.2.192] - 2026-07-08

### Changed
- Added reasoning guidelines block to Master, Superagent, and Subagent system prompts to guide active models to think and verify assumptions when available.

---

## [1.2.191] - 2026-07-08

### Fixed
- Fixed stray `[/SYS]` tag leak in assistant message text streaming and final responses by adding handling for square brackets in `StreamXmlFilter` and cleaning `[/SYS]` tags case-insensitively in `parseXmlToolCalls`.
- Ensured `StreamXmlFilter` is always active during streamed responses to strip stray/verbose XML tags and `[/SYS]` tags even when native tool calling is supported/enabled.
- Ensured `parseXmlToolCalls` is always run on streamed and non-streamed text responses to clean up leftover tags and avoid duplicate tool call registrations.

---

## [1.2.190] - 2026-07-08

### Added
- Added support for capturing, logging, and displaying AI model reasoning/thinking tokens (such as DeepSeek R1 and Anthropic Claude 3.7) in both single-agent and multi-agent CLI modes.
- Added completed reasoning block formatted as `[Reasoning] ... [/Reasoning]` under assistant message header in CLI chat.
- Added live reasoning streaming updates in single-agent interactive chat.
- Added `🧠 REASONING` as a collapsible log group in the multi-agent dashboard log view.

---

## [1.2.189] - 2026-07-08

### Changed
- Optimized system prompts to strongly encourage parallel execution of independent tasks (e.g. concurrent subagent spawning via the 'Subagents' array parameter in 'invoke_subagent', and concurrent superagent spawning).
- Prescribed bulk actions ('add_bulk', 'update_bulk', 'remove_bulk') inside BATCH_OPS prompt instructions to minimize sequential task updates.

---

## [1.2.188] - 2026-07-08

### Changed
- Optimized prompts and system tool descriptions to accelerate multi-file workflows by ensuring agents prioritize bulk/array operations (`filePaths`, `edits`, `files`, `patches`) instead of sequential one-by-one tool calls.
- Consolidated `prompts.ts` by extracting highly duplicated system prompt rules (`PROTECT_PROCESS`, `BATCH_OPS`, `FAST_ANALYSIS`, `FILE_EDIT_SAFETY`, `SHARED_MEMORY_SCOPING`) into shared constants, saving 800+ tokens per LLM invocation.
- Enhanced `readTool` (`filePaths`) to support per-file targeted offsets and limits using `{path, offset, limit}` objects in bulk mode.
- Added multi-file bulk patching support to `applyPatchTool` via the new `patches` parameter and extracted patch logic into `applyPatchToContent` helper.

---

## [1.2.187] - 2026-07-08

### Changed
- Improved `get_skills` tool:
  - Updated LLM semantic filtering prompt to be more inclusive when searching for skills with concepts/synonyms (e.g. mapping "rbac" or "role" queries to authentication/authorization, security policies, identity management, etc.).
  - Replaced strict full-string substring matching fallback with a smart IDF-weighted keyword scoring algorithm to rank relevant skills correctly even when semantic search fails or is disabled.

---

## [1.2.186] - 2026-07-08

### Changed
- Transitioned request classifier to prioritize AI (LLM) classification when a model is provided, bypassing heuristic confidence threshold logic.
- Retained the heuristic classifier as a fallback when no model is provided or skipLLM is active, and resolved several bugs in it:
  - Fixed a punctuation matching bug where punctuation (exclamation marks, periods) on multi-word phrases like "thank you!" caused conversation matching to fail.
  - Resolved question mark hijacking where command or debug requests ending in a question mark were incorrectly early-returned as questions.
  - Fixed a regex duplicate quote typo.
  - Expanded Indonesian keywords for all intent categories.
  - Expanded complex keywords to prevent planning bypasses on complex tasks.
- Optimized the LLM prompt inside `classifyWithLLM` to align with telegraphic English and markdown structure guidelines.

---

## [1.2.185] - 2026-07-08

### Fixed
- Fixed terminal input freeze where pasting text blocked all normal typing and editing by keeping the `ChatTextInput` component mounted when paste is active.
- Added paste preservation logic in input change handlers (`app.tsx` and `multi-agent-dashboard.tsx`) to update prefix and suffix lengths if the pasted block remains intact, or clear paste status if the pasted block is modified or deleted.
- Added props `isPasted`, `pastePrefixLength`, and `pasteSuffixLength` to `ChatTextInput` and implemented custom rendering for active paste placeholders showing logical cursor positions within the prefix or suffix.
- Removed duplicate paste-related key handlers for backspace, delete, and return from `useKeyboardHandler.ts` and `useDashboardKeyboard.ts`.

---

## [1.2.184] - 2026-07-08

### Fixed
- Fixed tool list mismatch and infinite retry loops by refining request classifier and agent execution behavior.
- Added command detection heuristics to classifyHeuristic (recognizing keywords like pnpm, npm, git, coba, jalanin for Indonesian and English) to prevent command requests from being incorrectly classified as questions.
- Applied request classifier toolset filtering and plan settings consistently across all iterations of the agent loop instead of just the first turn.
- Injected a critical tool restriction warning into the system prompt when terminal execution tools (run_command and run_background_process) are stripped from the active tool schema to prevent the model from calling them.
- Classified "tried to call unavailable tool" errors as non-retryable in isRetryableError to immediately abort and cleanly report schema mismatch errors instead of retrying 10 times.
- Fixed vitest tests in tests/enhancedFeatures.test.ts to mock getSettings with classifierEnabled: false so they correctly test simple task behavior in isolation.

---

## [1.2.183] - 2026-07-08

### Added
- Multi-category request classifier (`src/core/requestClassifier.ts`) that classifies user input before the main agent loop into 7 categories: conversation, question, simple_edit, research, complex_task, debug, command.
- Two-phase classification: zero-cost heuristic keyword matching first, optional LLM fallback for ambiguous inputs.
- Category-based toolset filtering: conversation uses 0 tools, question/research use read-only tools, saving 8K-20K tokens per turn.
- Workspace discovery skip for conversation category (no file scan needed for "ok"/"yes"/"thanks").
- Plan state injection skip for conversation and question categories.
- Category-specific prompt addendums for focused model behavior.
- Settings: `classifierEnabled`, `classifierConfidenceThreshold`, `classifierKeywords` in `SystemSettings`.
- Slash commands: `/setting-classifier <on|off>` and `/setting-classifier-threshold <high|medium|low>`.
- 85 unit tests in `tests/requestClassifier.test.ts`.

---

## [1.2.182] - 2026-07-08

### Changed
- Added single character spacing to separator lines when `hideTimeline` is enabled in `src/components/chat-area.tsx` to provide visual separation between turns (e.g. between user and assistant blocks).

---

## [1.2.181] - 2026-07-08

### Changed
- Improved formatting when the timeline is hidden: decreased leading spacing/indentation in the terminal UI and adjusted line wrapping accordingly to shift conversation text closer to the left edge.

---

## [1.2.180] - 2026-07-08

### Changed
- Updated the task checklist status text in the terminal UI to use full text "completed" instead of "comp." and to only display the raw count of ongoing tasks.

---

### Added
- Added an option in settings to hide timeline connecting lines in the terminal-based UI.
- Created `/setting-hide-timeline <on|off>` command to toggle this behavior.
- Added autocomplete suggestions for `/setting-hide-timeline`.
- Updated chat rendering logic in `src/components/chat-area.tsx` and `src/components/wizard-dialog.tsx` to conditionally hide timeline borders when enabled.

### Fixed
- Fixed an argument parsing bug in the `/setting-force-prompt-tools` command where `args[0]` was used instead of `args.trim()`.

---

## [1.2.178] - 2026-07-08

### Added
- **Base Prompt Updates for Performance & Generic Builds**:
  - Added mandatory BULK_READ guidelines to base prompts to batch multiple file reads into a single call.
  - Added FAST_ANALYSIS guidelines to search/grep to locate targets before reading, read specific line ranges for large files, and exclude build/dependency directories.
  - Made compile and test validation commands generic (e.g. cargo build, pytest, go test) in base prompts instead of NPM-specific.
  - Added package manager auto-detection (bun/pnpm/yarn/npm) in master agent tools for executing build and test commands in worktrees.

---

## [1.2.177] - 2026-07-08

### Fixed
- **Workspace-Scoped Task Log Files**:
  - Task log files previously stored in a global shared `~/.superagent-r/tasks/` directory.
  - Now stored in `~/.superagent-r/workspaces/<cwd-hash>/tasks/` — fully isolated per project.
  - Added `getWorkspaceTasksLogDir()` helper to `src/core/config/paths.ts`.
  - Updated `shellTools.ts` (`run_background_process` fallback) and both log dir usages in `terminalCommand.ts` (inline bg-terminal + detached terminal) to use the scoped path.
  - Stale log files are now automatically pruned together with their workspace directory after 7 days.

---

## [1.2.176] - 2026-07-08


### Fixed
- **Legacy Task Migration & Stale Workspace Cleanup**:
  - Added one-time migration: on startup, tasks from the old global `background-tasks.json` (pre-v1.2.175) that belong to the current workspace are merged into the new workspace-scoped file, then the global file is deleted. Ensures no tasks are silently lost on upgrade.
  - Added `cleanupStaleWorkspaceDirs()`: prunes `~/.superagent-r/workspaces/<hash>/` directories not touched in 7+ days, preventing unbounded disk growth from many different projects over time. Runs once 5 seconds after startup, then daily.
  - Exported `cleanupStaleWorkspaceDirs` for testability and extended test suite to 11 tests.

---

## [1.2.175] - 2026-07-08


### Fixed
- **Workspace-Isolated Background Tasks**:
  - Background tasks are now namespaced per working directory using a CWD hash.
  - Each project gets its own `~/.superagent-r/workspaces/<cwd-hash>/background-tasks.json` file.
  - Prevents tasks from unrelated projects (e.g. a different dev server) bleeding into task notifications of another workspace.
  - Added `getWorkspaceId()` and `getWorkspaceTasksFilePath()` helpers to `src/core/config/paths.ts`.
  - Updated `savePersistedTasks()` and `loadAndSyncPersistedTasks()` in `state.ts` to use the scoped path.

---

## [1.2.174] - 2026-07-08


### Added
- **Active Preset Name in Status Bar Footer**:
  - Added `presetName` prop to `StatusBar` component.
  - Displays the current active model preset name (⚙ preset-name) in the footer between the model name and git branch.
  - Automatically refreshes when the model changes (e.g. after `/model` or `/login` wizard).

---

## [1.2.173] - 2026-07-08

### Fixed
- **Session-Specific Model Preset Loading**:
  - Modified the 1. Load/Apply Model Preset option in the /model wizard to load presets locally (persist: false) instead of globally.
  - Updated [conversation.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/conversation.ts) to serialize and store the active preset config inside the session's history JSON files.
  - Restored the active preset from history files back into memory upon session resume.

---

## [1.2.172] - 2026-07-08

### Fixed
- **Task Checklist Header Formatting**:
  - Removed the clipboard emoji (📋) from the active task checklist header.
  - Removed the instruction texts `(click header to collapse)` and `click header to expand` from the header.
  - Refactored task list status counting to display both completed and in-progress (ongoing) counts: `(X/N comp. | Y/N ongoing)`.
  - Simplified the checklist component by resolving dynamic agent status overrides early before rendering.

---

## [1.2.171] - 2026-07-08

### Fixed
- **Collapsible Logs Click Area**:
  - Restructured collapsible chat/log click handling in [useMouseScroll.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/hooks/useMouseScroll.ts) and [chat-area.tsx](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/components/chat-area.tsx) to check horizontal cursor position (`x`) and limit clicks to the visual length of the toggle header text.
  - Restricted click-to-expand / click-to-collapse behavior to only trigger on the first (header) line of collapsible groups, preventing inadvertent collapsing when clicking or highlighting text inside expanded content blocks.

---

## [1.2.170] - 2026-07-08

### Fixed
- **Custom Provider SSE/Stream Interception and Parsing**:
  - Resolved a Zod validation error (`choices[0].message: Required`) occurring when custom OpenAI-compatible provider endpoints returned SSE stream chunks for non-streaming requests.
  - Implemented `reconstructChatCompletionFromSse` in [models.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/config/models.ts) to accumulate streamed content and tool calls from SSE chunks into a standard, valid OpenAI non-streaming chat completion JSON response.
  - Enhanced body payload decoding in the custom fetch interceptor to support `ArrayBuffer` and `ArrayBufferView` (e.g. `Uint8Array`) formats, correctly identifying streaming requests.
  - Changed custom provider wrappers to use `openai.chat(modelName)` when custom `baseUrl` is configured, explicitly forcing the Chat Completions protocol.
  - Added test coverage in [openaiJsonParsingFix.test.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/tests/openaiJsonParsingFix.test.ts).

---

## [1.2.169] - 2026-07-08

### Fixed
- **Model Preset Loading Cache Invalidation**:
  - Fixed a critical issue where loaded/applied presets (either via `/model preset <name> --save` or `/model <tier> <model> --save`) failed to propagate to the current session due to an invalid memory cache in `sessionActivePreset`.
  - Updated `savePreset`, `deletePreset`, and `setActivePresetId` in [jsonConfig.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/config/jsonConfig.ts) to correctly clear/invalidate `sessionActivePreset` when presets are modified or switched.
  - Modified `getActivePreset` to avoid caching the default disk configuration directly into `sessionActivePreset` on first read, preventing it from shadowing subsequent disk changes.
  - Added unit test coverage in [modelPresets.test.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/tests/modelPresets.test.ts).

---

## [1.2.168] - 2026-07-07

### Fixed
- **Bulk Edits File Path Resolution and Permission Checks**:
  - Fixed an issue where getToolDescription resolved file paths as `(missing)` for bulk edits targeting nested paths inside `edits` or `files` arrays.
  - Enhanced `isSuperagentOutOfBounds`, `isToolCallOutOfBounds`, `isModelConfigAccess`, and `isSensitiveEnvFileAccess` in [permissions.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/permissions.ts) to correctly inspect nested paths within `edits` and `files` arrays.
  - Prevented model preset test failures by isolating test presets using `clearSessionActivePreset` in test hooks rather than aggressively clearing it inside `clearModelConfigCache`.
  - Added unit test coverage in [permissions.test.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/permissions.test.ts).

---

## [1.2.167] - 2026-07-07

### Added
- **Help Text and Autocomplete Suggestions for Session Presets**:
  - Updated `/model` slash command description and help texts in [modelCommand.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/commands/modelCommand.ts) to detail the new `--save` and `--global` flags.
  - Enhanced slash command autocomplete suggestions inside [app.tsx](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/app.tsx) to dynamically include available presets (e.g. `Rudy`, `nuzi`) and suggest the `--save` and `--global` options when writing commands.

---

## [1.2.166] - 2026-07-07

### Added
- **Session-Isolated Model Configuration and Presets**:
  - Implemented session-level model configuration isolation. When presets or individual models are modified via the `/model` or `/model preset` slash command, they are stored in the session memory instead of being written directly to the global `model-config.json` file.
  - Added support for a `--save` or `--global` option to the `/model` and `/model preset` commands to persist active preset changes globally to disk when desired.
  - Modified auto-repair config logic to update active presets in-memory for the current session.
  - Added comprehensive test coverage in [modelPresets.test.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/tests/modelPresets.test.ts).

---

## [1.2.165] - 2026-07-07

### Fixed
- **OpenAI Custom Endpoint JSON Response Parsing**:
  - Implemented a robust [extractJSON](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/config/models.ts#L149-L215) function in [models.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/config/models.ts) to find matching braces/brackets while ignoring literals and escapes.
  - Updated the custom OpenAI fetch interceptor to execute this JSON cleaning on all non-streaming response bodies, preventing "Unexpected non-whitespace character after JSON" errors from endpoints like Cloudflare Workers AI that append trailing garbage.
  - Added unit test coverage in [openaiJsonParsingFix.test.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/tests/openaiJsonParsingFix.test.ts).

---

## [1.2.164] - 2026-07-07

### Added
- **Wait Action in manage_background_process**:
  - Implemented a synchronous `wait` action in `manageBackgroundProcessTool` inside [shellTools.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/tools/shellTools.ts) to block and await a background process's completion.
  - Added a `timeout` option to configure wait duration limits (defaulting to 10 minutes).
  - Integrated `AbortSignal` listener support for wait cancellation.
  - Documented the wait action inside the guidelines in [base.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/config/base.ts) and added a `BACKGROUND_WAIT` critical system prompt rule in [prompts.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/prompts.ts) so agents leverage the wait action instead of polling.
  - Added a robust unit test verifying wait action timeout and completion behaviors.

### Fixed
- **Mock Background Task Check race condition**:
  - Fixed a race condition in [state.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/tools/state.ts) where background task PID synchronization logic incorrectly marked mock background processes (pid 0) as exited with code `-1` under Vitest.

---

## [1.2.163] - 2026-07-07

### Fixed
- **Conversation History Persistence on Interruption**:
  - Implemented synchronous file writes (`saveToFileSync`) and agent-level `saveHistorySync()` to ensure history is persisted to disk on forced exits (Ctrl+C, SIGINT, SIGTERM, or general exit).
  - Modified the catch block in the agent's run loop to save history asynchronously on `AbortError` (e.g. first Ctrl+C in a TTY).
  - Added synchronous saving in the CLI abort/exit handlers to guarantee state is saved before process termination.

---

## [1.2.162] - 2026-07-07

### Changed
- **Dimmed UI Terminal Borders and Separators**:
  - Softened terminal UI aesthetics by dimming connection/border lines, error borders, info borders, and other system/default lines using dimColor.

---

## [1.2.161] - 2026-07-07

### Fixed
- **Support filePaths Array in Permission Boundary and Descriptions**:
  - Fixed issues where bulk file reading tool calls using the `filePaths` array parameter resolved to `"(missing)"` in tool descriptions and bypassed out-of-bounds safety boundary checks. Now, all file paths inside the `filePaths` array are correctly description-formatted and strictly verified against worktree/workspace bounds.

---

## [1.2.160] - 2026-07-07

### Added
- **AI Semantic Search in get_skills**:
  - Implemented AI semantic filtering in the `get_skills` tool. It now sends candidate skills to the LLM to find semantically relevant matches, falling back to keyword substring matching if AI search fails or returns no results.

### Fixed
- **Flaky Mocks in MasterAgent Tests**:
  - Isolated mock counters (`genCallCount` and `streamCallCount`) in `tests/masterAgentWorkflow.test.ts` to prevent test failures caused by background model calls.

---

## [1.2.159] - 2026-07-07

### Changed
- **Removed System [SYS] Tag Rendering**:
  - Removed the bold yellow `[SYS]` prefix tag from system line displays in both `chat-area.tsx` and `chat-line.tsx` rendering layouts, leaving only the clean message content.

---

## [1.2.158] - 2026-07-07

### Changed
- **UI Theme Colors**:
  - Replaced bright green accents and highlights throughout the terminal UI (focused panels, borders, status bars, and cursors) with a softer, darker gray to fit the dark console styling.
  - Updated code block highlights and successful tool statuses to use gray instead of green.
  - Used white circle emoji (⚪) instead of green circle (🟢) for successful tool call indicators.

---

## [1.2.157] - 2026-07-07

### Added
- **Diff Stats to Edit Tool**:
  - Integrated `buildEditSummary` support into the `edit` tool (both bulk and single-file options) in `systemTools.ts`. It now computes and appends diff summaries (e.g. `+45 -10`) when editing files.
  - Cleaned up tool start/auto-approve colors and icons in `dashboardLogFormatter.tsx` to align with the soft gray design guidelines.

---

## [1.2.156] - 2026-07-07

### Changed
- **Tool UI Icons and Color**:
  - Removed the gear icon (⚙️) from the tool execution titles and descriptions in the chat log, active tool views, and inspector panel.
  - Updated the color of executing tool descriptions, border lines, and arguments from bright yellow to a softer dimmed gray (slightly dark white) to clean up terminal UI visuals.

---

## [1.2.155] - 2026-07-07

### Fixed
- **Terminal Chat Height limit**:
  - Fixed an issue where the conversation log lines would not extend down to the active task checklist or input area, causing a large empty gap.
  - Calculated `chatHeightLimit` using the exact bottom chrome height and banner height dynamically rather than using static/heuristic-based `chromeHeight` estimations.

---

## [1.2.154] - 2026-07-07

### Changed
- **Subagent Planning Requirements**:
  - Removed the requirement that spawning a Subagent (`invoke_subagent`) is blocked by implementation plan approval.
  - Spawning subagents now only requires tasks to be documented first via `manage_tasks(action: 'add' or 'add_bulk')`.
  - Updated system prompts and orchestration logic in `agent.ts`, `base.ts`, and `prompts.ts` to reflect this change.

---

## [1.2.153] - 2026-07-07

### Added
- **Bulk Add in manage_tasks Tool**:
  - Added support for bulk adding multiple tasks via the new `add_bulk` action in [manageTasksTool](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/tools/otherTools.ts).
  - Introduced the `texts` array parameter to allow specifying multiple task descriptions at once.
  - Added unit test coverage in [manageTasksTool.test.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/tests/manageTasksTool.test.ts) for validation and logic of `add_bulk`.

---

## [1.2.152] - 2026-07-07

### Optimized
- **Grep Tool Cache Interception**:
  - Intercepted [grepTool](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/tools/systemTools.ts) to filter files in-memory using picomatch over the cached file list from getWorkspaceCachePath, bypassing filesystem walking when cache is present.
  - Normalized path outputs in grep results to use forward slashes consistently across platforms.

- **Git-based Workspace Discovery**:
  - Enhanced [getWorkspaceFingerprint](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/workspaceDiscovery.ts) to check if the directory is a Git repository, and if so, query files using git ls-files.
  - Added concurrent fs.promises.stat execution in batches of 100 to gather metadata efficiently and generate MD5 fingerprints quickly.

---

## [1.2.151] - 2026-07-07

### Changed
- **System Prompt Optimization for File-Editing Safety**:
  - Added new `FILE_EDIT_SAFETY` instructions under `CRITICAL RULES` for both `SUPERAGENT_SYSTEM_PROMPT` and the `coder` subagent prompt in [prompts.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/prompts.ts).
  - Guides agents to retrieve fresh file contents before editing, ensure unique targets for string replacements, and strictly validate schema parameters for multi-replace actions.

---

## [1.2.150] - 2026-07-07

### Added
- **Speed Display in Status Bar Footer**:
  - Destructured and displayed lastSpeed (generation speed in tokens per second) in the primary StatusBar component's ready state layout in the CLI terminal footer.

---

## [1.2.149] - 2026-07-07

### Fixed
- **TencentDB Memory Gateway Scenario Read**:
  - Replaced client.readFile with client.readScenario in tdai_read_cos to fix the 404 error when running in local-first standalone mode.
  - Added scenario block file validation to correctly handle files that do not exist by returning a clean file not found message.

---

## [1.2.148] - 2026-07-07

### Performance
- **Cache Installed Skills**:
  - Implemented 5-second TTL cache for `getInstalledSkills` to resolve input typing lag/latency.
  - Automatically bypasses caching during test execution under Vitest.

---

## [1.2.147] - 2026-07-07

### Changed
- **Limit Session History List in Resume Wizard**:
  - Limited the number of displayed history sessions to the 10 newest in the `/resume` command and wizard dialog.
  - Sliced the session lists in `useKeyboardHandler.ts`, `useDashboardWizard.ts`, and `dashboardSuggestions.ts` to ensure consistent indexing and select operations.

---

## [1.2.146] - 2026-07-07

### Changed
- **WebP Image Format for Prompt-Level Canvas Renders**:
  - Changed prompt-level text-to-image canvas conversions from PNG to WebP format to reduce base64 transmission size and mitigate 413 errors.
  - Updated all associated message mimeTypes to `image/webp`.

---

## [1.2.145] - 2026-07-06

### Fixed
- **Compaction Loop and Byte-Size Enforcement in PruningStrategy**:
  - Enhanced `PruningStrategy` to support byte budget enforcement via `options.byteBudget` to prevent and resolve `413 Payload Too Large` loops.
  - Added aggressive message truncation for individual text fields and tool results exceeding 50KB to keep context under the limit without discarding whole messages.
  - Updated `ContextManager.compact` and `Agent`'s forced compaction path to propagate a 3.0 MB byte limit during emergency compaction.
  - Added full test coverage for the byte-size check and truncation routines.

---

## [1.2.144] - 2026-07-06

### Added
- **413 Payload Too Large Recovery**:
  - Implemented automatic context compaction and retry when model generation (streaming or non-streaming) fails with a `Payload Too Large (status: 413)` or `Request entity too large` error.
  - Compaction is forced using the local, LLM-free `PruningStrategy` to guarantee rapid recovery without making further model calls.
  - Added unit test coverage to verify recovery in both streaming and non-streaming modes.

---

## [1.2.143] - 2026-07-06

### Changed
- **Image Prompt and Vision Token Saving System Enhancements**:
  - Implemented dynamic vision token saving thresholds tailored by provider (6,500 characters for Anthropic, 1,000 for Gemini).
  - Added a static, hash-backed image rendering cache in `Agent` to prevent redundant canvas drawing and PNG encoding.
  - Refined path normalization in `textToImage` to avoid mutating code-level backslashes (escape sequences, regex patterns).
  - Updated `TokenTracker` to simulate vision token pricing when active, aligning compaction estimates with actual API payloads.

---

## [1.2.142] - 2026-07-06

### Fixed
- **Multi-Replace Line Range Rejection**:
  - Updated `multi_replace_file_content` to reject out-of-bounds startLine or endLine parameters in chunks instead of silently coercing them.
  - Added robust validation and unit tests to verify out-of-bounds rejection behavior.

### Changed
- **Explicit Task Management Prompts**:
  - Updated system prompt guides for task tracking to explicitly specify action parameters, index structure, and valid status values for the `manage_tasks` tool.

---

## [1.2.141] - 2026-07-06

### Changed
- **Recursive Error Formatting**:
  - Enhanced the `formatError` function to recursively traverse error causes (chains of `.cause` or `.error` properties) to extract underlying status codes, response bodies, and cause details from nested API/network errors.

---

## [1.2.140] - 2026-07-06

### Fixed
- **Custom Provider Response Cleaning**:
  - Implemented a custom `fetch` interceptor in the OpenAI provider configuration (`models.ts`) that sanitizes incoming HTTP response bodies by stripping trailing non-JSON artifacts (such as buggy `data: [DONE]` text blocks appended by some API endpoints or proxies) before JSON parsing.

---

## [1.2.139] - 2026-07-06

### Changed
- **Enhanced Error Formatting**:
  - Improved `formatError` in `agent.ts` to extract and print additional error details such as HTTP status codes, raw response body snippets, and error causes (for example, when parsing invalid JSON response bodies from proxy/server gateway failures).

---

## [1.2.138] - 2026-07-06

### Added
- **Manual Custom Model Entry**:
  - Added a "+ Custom Model (Input manually)" option to the model selection list in both the login setup wizard and the model selection wizard.
  - Added a new input step (step 16) in both wizards to capture manual model ID input when the custom model option is selected.
  - Added transition logic from step 16 to the test message connection check (for login) or to the vision compatibility query (for model configuration).

---

## [1.2.137] - 2026-07-06

### Added
- **Bulk Task Management**:
  - Added support for bulk operations in the `manage_tasks` tool.
  - Added new `update_bulk` and `remove_bulk` actions, and an `indices` array parameter.
  - Allowed `update` and `remove` actions to also accept the `indices` parameter for backward compatibility.
  - Handled index deduplication and safe descending line removal to prevent shifting bugs.
  - Added comprehensive unit tests covering all bulk operations and validation edge cases.

---

## [1.2.136] - 2026-07-06

### Changed
- **High-Contrast Vision Rendering**:
  - Changed the background of converted prompt/message images in `textToImage.ts` from dark gray (`rgb(30, 30, 30)`) to high-contrast pure white (`rgb(255, 255, 255)`), and the text color to pure black (`rgb(0, 0, 0)`). This matches document OCR training distributions, significantly improving character recognition (OCR) reliability for vision models.

### Fixed
- **Flaky Hook Status Tests**:
  - Replaced unstable fixed `setTimeout` checks (50ms) in `tests/useTencentdbStatus.test.ts` with clean, condition-based polling `waitForCondition()` to prevent asynchronous test flakes when the test runner runs under high CPU/disk load.

---

## [1.2.135] - 2026-07-06


### Added
- **Vision-Powered Tool Result Retention**:
  - Added `visionMode` property and `setVisionMode(enabled)` method to `Conversation`. When the active model supports vision and `autoVisionTokenSaving` is on, `stripOldToolResults` now retains full tool results for 8 cycles (up from 2) instead of truncating them to a 20-line preview.
  - In vision mode, `buildMessages()` in `agent.ts` already converts large tool results to PNG images on-the-fly before sending to the API. This means the AI can read the complete output of any old tool call through vision — no blindness, no context loss.
  - Images are generated dynamically at API call time and are never stored in the history file, so disk usage is not affected.
  - In text-only mode (model does not support vision), the 20-line / 800-char preview strategy from v1.2.134 is still used as a fallback.
  - `agent.ts` calls `this.conversation.setVisionMode(useVisionTokenSaving)` once per iteration, immediately after the vision capability check, so the mode always reflects the actual model in use.

---

## [1.2.134] - 2026-07-06


### Fixed
- **Tool Result Truncation — AI Blindness**:
  - Replaced the blind `[Output truncated for token efficiency (success)]` wipe with a meaningful preview strategy in `conversation.ts`. Old tool results now retain the first 20 lines (capped at 800 chars) with a `... [truncated — N more line(s) omitted]` suffix instead of being erased entirely.
  - Results already under 800 chars are preserved verbatim with no truncation.
  - Error results keep up to 300 chars (up from 150) so failure reasons remain visible.
  - Routine tools (`read_file`, `grep`, `list_dir`, etc.) age out at `keepCycles - 1` rounds using `Math.max(1, keepCycles - 1)` instead of a hardcoded `1`, making the logic consistent with the configurable cycle parameter.
  - Updated `conversation.test.ts` to use long synthetic results that exceed the 800-char preview threshold, correctly exercising the new truncation behavior.

---

## [1.2.133] - 2026-07-06


### Fixed
- **Image Prompt System — Path Issues**:
  - `workspaceBoundaryNotice` (workspace root path) moved from `systemPrompt` into `dynamicContext` so it is always delivered as plaintext and never converted to a PNG image. Previously the AI had to OCR workspace paths from rendered images, causing path misreads.
  - `planStateNotice` (plan/task file absolute paths) similarly moved exclusively to `dynamicContext`, eliminating a duplication bug where the same paths appeared both in the system prompt image and in plaintext with potentially different `[EXISTS]` / `[NOT YET CREATED]` statuses between the two — creating conflicting information for the AI.
  - Added `normalizePathsForImage()` in `textToImage.ts` that converts Windows-style backslash separators (`C:\foo\bar`) to forward slashes (`C:/foo/bar`) before rendering any text to PNG. This prevents AI vision models from misreading ambiguous backslash characters in path strings.
  - Increased canvas font size from `14px → 15px` and line height from `18 → 20` in `textToImage.ts` for improved legibility of rendered text images.

---

## [1.2.132] - 2026-07-06


### Changed
- **Workspace State Context**:
  - Injected workspace CWD, agent tier, and active Git branch directly to the top of the live workspace state block to prevent agent context drift.
- **Vision Token Saving**:
  - Split and paired multi-page text-to-image conversions (system prompt, user messages, TencentDB memory, tool outputs) with explicit page numbers and contextual labels (e.g. `[Page X of Y]`) to improve vision model layout processing and prevent page-ordering confusion.

---

## [1.2.131] - 2026-07-06

### Changed
- **Footer (Status Bar)**:
  - Replaced the simple flashing text spinner with a beautiful bouncing block spinner (`[▰▱▱▱▱]`) styled in solid `blueBright`.

---

## [1.2.130] - 2026-07-06

### Changed
- **Header (Banner)**:
  - Replaced the pipe separator (`│`) with a bullet point (`●`).

---

## [1.2.129] - 2026-07-06

### Changed
- **Header (Banner)**:
  - Removed `COGNITIVE SYSTEM` text from the header title row, keeping only `v{version}`.

---

## [1.2.127] - 2026-07-06

### Changed
- **Header (Banner)**:
  - Removed logo/mascot (garuda ASCII art) from the header.
  - Removed `│ ● READY` indicator from the header title row.
- **Footer (Status Bar)**:
  - Added `Proc` (running tasks) and `Sub` (running subagents) counters to the idle status bar.
  - Proc and Sub counts highlight in color (yellow/cyan) when > 0, remain gray when idle.

---

## [1.2.126] - 2026-07-06

### Fixed
- **Idle Status Bar**:
  - Restored a clean, one-line status bar when idle (`!isProcessing`) displaying ready state, model name, branch, message count, and context token percentage.

---

## [1.2.125] - 2026-07-06

### Added
- **Log Execution Summary**:
  - Automatically generate a concise summary of the active session actions, changed files, and workspace state using the LLM when execution completes successfully.
  - Write this summary to the global execution log (`superagent.log`) under a `SUMMARY` prefix.
  - Injected this real execution summary into the `goal_done` event payload instead of a generic static message.
  - Disabled summary generation during Vitest unit testing to prevent test failures or unexpected model calls.

---

## [1.2.124] - 2026-07-06

### Changed
- **Simplified Colorful Footer**:
  - Replaced the multi-line stats footer with a simplified, 1-line layout.
  - Added a colorful scanning spinner and animated rolling-rainbow loading text for the processing state.
  - Kept a stable blank line when idle to prevent layout shifts.
  - Reduced status bar height bounds and total rows to reclaim terminal rows for the chat view.

---

## [1.2.123] - 2026-07-06

### Improved
- **Image Prompt Context Headers**:
  - Enhanced the headers and instruction text accompanying auto-vision token-saving image parts (system prompts, user inputs, memory context, and tool results).
  - Explicitly instructs the vision-enabled models to read, transcribe, and follow instructions/data embedded within the images rather than treating them as generic user attachments.

---

## [1.2.122] - 2026-07-06

### Changed
- **Implementation Plan Prompting**:
  - Added clear instructions, structures, and regular expression requirements for the three valid implementation plan templates (Full, Quick, Refactor) into all system prompts (`MASTER_AGENT_SYSTEM_PROMPT`, `SUPERAGENT_SYSTEM_PROMPT`, and base config prompt).
  - Resolves plan validation wizard rejections by ensuring agents always construct plans matching the expected templates.

---

## [1.2.121] - 2026-07-06

### Changed
- **Subagent Spawning Plan Mandate**:
  - Removed the check that blocked subagent spawning if the parent agent's implementation plan was pending approval or not approved. Spawning subagents is no longer constrained by the plan state.

---

## [1.2.120] - 2026-07-06

### Added
- **Maximum Compression Mode Rules**:
  - Inserted maximum compression mode guidelines into the base system prompt in `base.ts`.
  - Added specific directives to minimize token usage, prefer noun phrases & imperative fragments, omit filler, pronouns, articles, and apply strict symbol mappings.

---

## [1.2.119] - 2026-07-06

### Added
- **TencentDB Memory Context Vision Conversion**:
  - Automatically convert TencentDB Agent Memory Context user messages into image pages when vision token saving is active.
  - Ensures memory context is compressed into visual tokens for vision-supporting models to optimize context length.

---

## [1.2.118] - 2026-07-06

### Fixed
- **Conversation Log Scrolling**:
  - Ensured that clicking anywhere in the conversation log (including collapsible tool output headers) correctly activates `"chat"` focus mode.
  - Added full PageUp, PageDown, Ctrl+Arrows, and Shift+Arrows keyboard scrolling support when in `"chat"` focus mode.

---

## [1.2.117] - 2026-07-06

### Fixed
- **Terminal UI Click & Focus Responsiveness**:
  - Accounted for the `HistoryPanel` and active wizard question heights in layout and section boundary calculations to prevent input/statusbar clipping and alignment issues.
  - Enhanced mouse click detection to robustly focus the text input when clicking on the statusbar or any empty bottom regions.
  - Added click selection and mouse wheel scroll support for entries in the command history panel.

---

## [1.2.116] - 2026-07-06

### Removed
- **FastContext**:
  - Removed FastContext codebase exploration tool (`fastcontext`), wrapper scripts, and startup setups.
  - Deleted obsolete `tests/fastcontextTool.test.ts` and `.agents/skills/fastcontext` skill folder.
  - Cleaned up `vendor/fastcontext` directory and `README.md` / `.gitignore` references.

### Changed
- **System Prompts**:
  - Updated Master Agent, Superagent, and specialized Subagent system prompts to spawn the `researcher` subagent for codebase exploration instead of running `fastcontext`.

---

## [1.2.115] - 2026-07-06

### Added
- **System Prompt Vision Token Saving**:
  - Implemented automatic conversion of large system prompts to image parts when vision token saving is enabled and threshold is exceeded.
  - Prepended system prompt images inside a user message to `generateText` and `streamText` calls.
  - Added unit test in `tests/visionTokenSaving.test.ts` to verify correct conversion behavior.
  - Reduced the default vision saving threshold fallback from 4000 to 2000 characters for earlier token saving optimization.

---

## [1.2.114] - 2026-07-06

### Added
- **Help and Autocomplete for Vision Settings**:
  - Updated the `/help` command output to describe `/setting-auto-vision` and `/setting-vision-threshold`.
  - Added autocomplete support (with subcommands) for both slash settings inside `dashboardSuggestions.ts`.
  - Added unit tests for new autocomplete suggestions inside `tests/slashCommands.test.ts`.

---

## [1.2.113] - 2026-07-06

### Added
- **Vision Token Saving Settings Commands**:
  - Added new slash commands `/setting-auto-vision <on|off>` and `/setting-vision-threshold <number>`.
  - Integrated the settings into the `/settings` display block.
  - Added comprehensive test coverage in `tests/slashCommands.test.ts`.

---

## [1.2.112] - 2026-07-06

### Changed
- **Refactored Text-to-Image Rendering**:
  - Replaced platform-specific OS-dependent text-to-image rendering (using PowerShell on Windows and Python/Pillow on Linux/Mac) with the high-performance `@napi-rs/canvas` library.
  - Implemented inline HTML5-compatible Canvas text rendering using the `@napi-rs/canvas` API.
  - Removed temporary file storage logic and directly generated base64 PNG data in memory.

---

## [1.2.111] - 2026-07-06

### Added
- **Google Gemini Native Provider**:
  - Installed and integrated `@ai-sdk/google` (v1.x for compatibility with SDK v4.x).
  - Added support for `gemini` in provider types and command-line `/login add gemini <api_key>` commands.
  - Implemented auto-detection of Gemini keys (prefix `AIza`).
  - Added native Gemini models (e.g., `gemini-2.5-flash`, `gemini-2.5-pro`) to provider wizards, fallback options, and static token limit configs.
  - Resolved `gemini` provider prefix in runtime model instance creation.

---

## [1.2.110] - 2026-07-06

### Added
- **Automatic Context-to-Image Conversion**:
  - Implemented automatic text-to-image conversion for prompt context (user prompts and tool results) exceeding a configured character threshold.
  - Slices text blocks into 150-line pages (up to 3 pages) and renders them using PowerShell (.NET `System.Drawing`) on Windows or Python (`Pillow`) on macOS/Linux.
  - Replaces large tool results with placeholders and appends the rendered images in immediate subsequent user messages to satisfy provider API protocols.
  - Added new configuration settings: `autoVisionTokenSaving` and `visionTokenSavingThreshold`.
  - Added support for configuring custom model vision capability overrides via the `/model` interactive wizard, prompting the user and saving the settings directly inside presets and tier configs.
  - Added unit test suite in `tests/visionTokenSaving.test.ts`.

---

## [1.2.109] - 2026-07-06

### Changed
- **Planning-First Spawning Rules**:
  - Updated system prompts for the Master Agent, Superagent, and Single Mode CLI to mandate creating or updating implementation plans/checklists before invoking any subagent or superagent.

---

## [1.2.108] - 2026-07-06

### Changed
- **Android CLI Startup Setup**:
  - Automatically check and download/configure the Android CLI dependencies (including curl and Android CLI itself) on application startup inside `src/cliMain.tsx` (using `ensureAndroidCliInstalled`), rather than waiting for it to be run lazily when `android_cli` is first called, ensuring a smooth and uninterrupted experience when using mobile/emulator commands.

---

## [1.2.107] - 2026-07-06

### Changed
- **Ripgrep Startup Setup**:
  - Automatically download and configure ripgrep (`rg`) on application startup inside `src/cliMain.tsx` (using `ensureRgInstalled`), rather than waiting for it to be run lazily when `ripgrep_search` is first called, preventing potential delay or runtime setup errors when agents execute search commands.

---

## [1.2.106] - 2026-07-06

### Fixed
- **System Prompts Configuration**:
  - Audited and updated the base system prompt in `src/core/config/base.ts` to remove references to unregistered and obsolete background process tools (`write`, `kill_background_process`, `view_background_processes`), preventing potential tool hallucination by the AI models.

---

## [1.2.105] - 2026-07-06

### Changed
- **Assistant Timeline UI Theme**:
  - Colored the timeline tree prefix (`┌───`, `├───`, `│`), agent name (`✦ SUPERAGENT`), and turn index (`[#lineIndex]`) with a single dark gray color (`gray`) to improve aesthetic readability and visual cohesion.

---

## [1.2.104] - 2026-07-06

### Fixed
- **FastContext Setup & Vendoring**:
  - Removed `.git` from `vendor/fastcontext` and updated `.gitignore` to track `vendor/fastcontext` to vendor the FastContext repository explorer source code. This prevents GitHub credentials prompts during startup setup since Microsoft took down the public `microsoft/fastcontext` repository.
  - Modified `bin/setup-fastcontext.ps1` and `bin/setup-fastcontext.sh` to bypass Git pull checks if the directory does not contain a `.git` subfolder, ensuring the setup runs successfully offline/from vendored files.

---

## [1.2.103] - 2026-07-06

### Fixed
- **Input Focus and Caret Display**:
  - Separated the mouse click boundary handlers for `input` and `wizard` in `src/hooks/useMouseScroll.ts` to ensure that clicking the text input box always focuses it and displays the caret, even when a wizard dialog is active.
  - Implemented focus-gaining cursor sync in `src/components/ChatTextInput.tsx` to automatically snap the cursor to the end of the text when the input field is focused.

---

## [1.2.102] - 2026-07-06

### Fixed
- **Terminal Scroll Functionality**:
  - Restored full scroll capabilities by returning a copy of the cached text wrapping array (`[...cached]`) from `wrapTextForDisplay` inside `src/utils/responseScroll.ts` to prevent reference-sharing issues and potential mutations.
  - Wrapped all `logMouseDebug` calls in `src/hooks/useMouseScroll.ts` with explicit `process.env.DEBUG_MOUSE === "true"` checks to prevent expensive template string evaluation, `JSON.stringify` overhead, and uncaught serialization exceptions on hover, click, and scroll events.

---

## [1.2.101] - 2026-07-06

### Optimized
- **Terminal Scroll Performance**:
  - Implemented a Least-Recently-Used (LRU) style cache for `wrapTextForDisplay` inside `src/utils/responseScroll.ts` to skip character-by-character scan and wrap logic on subsequent renders of unchanged text.
  - Resolved terminal scrolling lag in single-agent mode by adding a conditional `logMouseDebug` helper in `src/hooks/useMouseScroll.ts`. The helper suppresses synchronous directory/file checks and writes during mouse events unless explicitly enabled via `process.env.DEBUG_MOUSE === "true"`.

---

## [1.2.100] - 2026-07-06

### Optimized
- **CLI Startup Performance**: Restructured CLI entrypoint and lazy-loaded dependencies (React, Ink, App, MultiAgentDashboard, TrustPrompt) to improve startup performance. The help command (`--help` / `-h`) now executes instantly without parsing or evaluating heavy UI framework files.
- **Lazy Initialization**: Shifted all runtime initialization operations (FastContext setup, TencentDB setup, MCP initialization) to be deferred until after the arguments have been parsed and the runner is ready to boot, saving startup overhead.
- **CLI Execution Restructuring**: Moved CLI runner execution logic into `src/cliMain.tsx` to enable cleaner dynamic imports and modular boot execution.

---

## [1.2.99] - 2026-07-06

### Added
- **Ctrl+O Cycling Expand Keyboard Shortcut**: Replaced click-to-toggle tool entry log panels with the Ctrl+O keyboard shortcut. Toggling via Ctrl+O cycles through each visible collapsible log entry in both single-agent and multi-agent dashboard interfaces.
- **Ctrl+O UI Hint Labels**: Updated all tool logs, system information blocks, and question prompts to guide the user to toggle logs using the `Ctrl+O` shortcut instead of mouse clicks.

### Changed
- Refactored `useKeyboardHandler` and `useDashboardKeyboard` hooks to receive context refs for visible elements, group log boundaries, and expand toggle states to support the keyboard cycling logic.

---

## [1.2.98] - 2026-07-04

### Fixed
- **Bang Shortcut Suggestion Support**: Added support in the suggestion engine to map inputs starting with `!` shortcut to terminal commands, returning corresponding terminal suggestions (e.g., `!init`, `!bg`, `!stop`, etc.) and showing them properly in the terminal UI and dashboard suggestions panel.
- **Tab Completion for Bang Prefix**: Allowed tab completion trigger and cycle/selection logic when the user input starts with `!` command shortcut.
- **Immediate Update for Bang Prefix**: Disabled input debouncing in `ChatTextInput` when typing the `!` prefix, ensuring instant suggestion list updates.

### Added
- Added unit tests in `tests/bangSuggestions.test.ts` verifying suggestions mapping and tab completion behavior for the bang command prefix.

---

## [1.2.97] - 2026-07-04

### Added
- **File Concurrency Locking**: Implemented a Promise-based `FileLockManager` to serialize read/write operations for the same file path, preventing race conditions when multiple file write/edit tools run in parallel.
- **Improved Edit/Patch Accuracy**: Refactored the `edit` and `apply_patch` (search-replace block mode) tools to use `mapNormToOrigIndices` for character index mapping, resolving misalignment issues when files contain trailing whitespace.

### Tests
- Added unit and concurrency tests in `tests/fileEditingConcurrency.test.ts` verifying concurrent serialization, `edit` alignment under trailing whitespace, and search-replace patch alignment.

---

## [1.2.96] - 2026-07-04

### Changed
- **Relocated and Restyled Loading Footer Indicator**: Redesigned the status bar loader to use a cyberpunk-themed scanner block spinner (`[▰▱▱▱▱]`) and moved the processing block to the leftmost position of the footer/status bar in both single-agent and multi-agent dashboard layouts.

---

## [1.2.95] - 2026-07-03

### Added
- **Plan Editing via Manage Plan Tool**: Added support for an `edit` action in the `manage_plan` tool. This allows updating the implementation plan using either a full replacement `planContent` or incremental find-and-replace using `targetContent` and `replacementContent`.
- **System Prompt and Instruction Updates**: Exposed and documented the plan editing capability in `MASTER_AGENT_SYSTEM_PROMPT` and `SUPERAGENT_SYSTEM_PROMPT` to let agents modify plans through the tool rather than direct file writes.
- **Agent Rule Updates**: Updated planning rules in `src/core/agent.ts` to allow `edit` under the `manage_plan` tool.

### Tests
- Added unit tests in `tests/managePlanTool.test.ts` verifying edit action, parameters error checking, full replacement, and find-and-replace synchronization.

---

## [1.2.94] - 2026-07-03

### Added
- **Interruption and Interactivity (Sanggah)**: Allowed the user input box to remain visible and active during processing in both single-agent and multi-agent dashboard modes. Submitting a new message while the agent is running immediately aborts the active run and queues the new prompt to run.
- **Footer Status Bar Loading Indicators**: Moved the processing/loading spinner and "Processing..." status text to the bottom status bar footer in both single-agent and multi-agent modes.

### Tests
- Added unit tests in `tests/sanggahInterruption.test.ts` to verify `queueMessage` function and interruption queuing logic.

---

## [1.2.93] - 2026-07-03

### Added
- **Get Skills Tool for Discovery**: Added `get_skills` tool to list and search installed skills across all directory locations (workspace-local, hooks, global config, packages) with optional query filtering and clean non-markdown output.
- **Direct Skill Discovery Prompting**: Updated the `loadAgentSkills` system instructions and the main `SKILL CHECK` step in Master and Subagent (Coder, Researcher, Reviewer) prompts to guide agents to call `get_skills` rather than manually listing directories or checking static environment arrays.

### Tests
- Added unit tests in `tests/skillsTool.test.ts` to verify `get_skills` output formatting, empty states, and case-insensitive query filtering.
- Updated `tests/skillsFiltering.test.ts` assertions to align with the new prompt instructions.

---

## [1.2.92] - 2026-07-03

### Added
- **Keyboard Navigation and Log Output for Active Processes**: Enabled keyboard navigation (up/down arrow keys) for the active processes panel in both the single-agent console and multi-agent dashboard. Pressing Enter while focusing a running process prints the last 40 lines of its output/logs directly in the terminal chat/master logs. Added the Ctrl+B shortcut to quickly toggle focus to the active processes panel when processes are running.

### Fixed
- **Tool Registry Consistency**: Added `readPeerSuperagentFileTool` to the exported `allTools` array in `tools/index.ts` to maintain registry integrity.
- **Mock Cleanup in Post-Merge Validation Tests**: Fixed `fs.existsSync` mocks in `tests/postMergeValidation.test.ts` to return `false` for lockfiles (`bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`), preventing test failures caused by dynamic package manager detection on machines with Bun/PNPM installed.

---

## [1.2.91] - 2026-07-03

### Fixed
- **Project-Specific Background Processes**: Fixed a bug where background processes ("ACTIVE PROCESSES") from all projects were loaded globally across all terminal dashboards and CLI commands. Added `cwd` path tracking to `BackgroundTask` and `PersistedTask` structures in `background-tasks.json`. Added workspace filtering via `isTaskInWorkspace` helper across dashboard panels, slash commands (`/processes` and `/terminal`), agent prompt injections, checkpoint restores, and exit handlers.

### Tests
- Added unit tests in `tests/backgroundTasksSync.test.ts` to verify workspace directory filtering (`isTaskInWorkspace`) and task directory serialization/deserialization.

---

## [1.2.90] - 2026-07-03

### Fixed
- **Edit/Replace Tool Overlap & Duplication**: Fixed an issue where `replace_file_content` and `multi_replace_file_content` could match incorrect duplicate substrings within a range (e.g. matching strings starting after `reject: false`) and corrupt files.
- **Uniqueness Check**: Both tools now check if the normalized target content is unique within the specified line range. If there are multiple occurrences and `allowMultiple` is not true, they abort with a descriptive error.
- **Multiple Replacements Support**: Added `allowMultiple` (and alias `AllowMultiple`) support to allow replacing all occurrences safely using character index mapping from right to left (bottom to top) to prevent character shift corruption.

### Tests
- Added unit tests in `tests/systemTools.test.ts` to verify duplicate checks and multiple replacement correctness for `replace_file_content` and `multi_replace_file_content`.

---

## [1.2.89] - 2026-07-03

### Added
- **Dynamic Package Manager Detection**: `masterAgent.ts` now auto-detects the project's package manager (bun, pnpm, yarn, npm) from lockfiles before running build/test/lint validation. Previously hardcoded to `npm`, causing failures on pnpm/yarn/bun projects. New exported helper `detectPackageManager(cwd)` checks for `bun.lockb` > `pnpm-lock.yaml` > `yarn.lock` in priority order.
- **Subagent Context Inheritance**: `invoke_subagent` gains optional `inheritContext: boolean` parameter. When `true`, a compact workspace snapshot (task progress, plan objective, working directory) from the parent agent is prepended to the subagent's system prompt (capped at 2000 chars). Reduces redundant re-research and fastcontext calls from freshly spawned subagents.
- **Pre-merge Branch Verification**: `merge_superagents` now checks each completed Superagent's result report for failure signals (`Build: failed`, `Status: Blocked/Partial`) before attempting `git merge`. Branches that self-report as broken are skipped immediately with a clear error message, avoiding expensive merge+abort cycles.
- **Intent-Context Conflict Resolution**: When the Master Agent spawns a conflict-resolver subagent, it now first collects `git log --oneline` and `git log -p` from the conflicting branch and injects them as a `BRANCH INTENT CONTEXT` section into the resolver's prompt (capped at 3000 chars). The resolver now understands *what* each branch was trying to achieve, not just *where* the conflict markers are.
- **Peer Worktree Read Access**: New `read_peer_superagent_file` tool added to `superagentToolset`. Allows a running Superagent to read a file from another Superagent's worktree in read-only mode. Access is strictly path-validated against the registered worktree path (no traversal allowed), files over 512 KB are blocked, and only Superagent-tier agents (depth 1) may call it. Enables parallel Superagents to share generated schemas, types, or interfaces without waiting for a full merge cycle.

### Tests
- **detectPackageManager**: 6 unit tests in `tests/masterAgent.test.ts` covering npm (fallback), yarn, pnpm, bun, and priority conflicts.
- **Pre-merge verification**: 2 unit tests in `tests/superagentTools.test.ts` — build-failed report and status-blocked report both trigger skip-and-error without touching git.

---

## [1.2.88] - 2026-07-03


### Added
- **Sequential Message Queueing**: Replaced single pendingMessage property in agent.ts with pendingMessagesQueue array to prevent message loss on concurrent signals.
- **PID-Based Stale Lock Healing**: Added active process verification in rateLimiter.ts to instantly release concurrency and rate limit lock files if the holding process ID (PID) is dead, avoiding unnecessary timeouts.
- **High-Accuracy Token Estimation**: Pre-flight safety checks in agent.ts now query the tiktoken TokenTracker when ContextManager is initialized, improving token count accuracy.

### Tests
- **New tests/messageQueueing.test.ts**: Verifies sequential queueing and execution of multiple concurrent messages.
- **Limiter PID Healing Tests**: Added a test in tests/rateLimiter.test.ts to verify auto-healing of lock files holding dead PIDs.

---

## [1.2.87] - 2026-07-03

### Security
- **Workspace Boundary: Split Out-of-Bounds Session Bypass Flags**: Introduced a separate `allowSessionFileWriteOutOfBounds` flag for file write tools (`write_to_file`, `replace_file_content`, `multi_replace_file_content`, `edit`, `apply_patch`). Previously, a single `allowSessionOutOfBounds` flag granted by approving a shell or glob tool would silently bypass ALL subsequent file write permission checks for the session — allowing the agent to write files outside the workspace without further prompts. File write tools and shell tools now maintain independent bypass states.
- **Workspace Boundary: Non-Interactive Mode Blocks Out-of-Bounds File Writes**: Non-TTY (non-interactive) mode previously auto-approved ALL permission requests including out-of-bounds file writes. It now explicitly blocks all file write tools (`MODIFYING_TOOLS`) outside the workspace and returns `false`, while continuing to auto-approve shell and read tools.
- **Workspace Boundary: System Prompt Constraint Injection**: Every agent iteration now injects a `# WORKSPACE BOUNDARY — CRITICAL` section into the system prompt containing the exact workspace root path, preventing the LLM from hallucinating file write targets derived from bash command output (e.g., Git Bash `/c/Users/...` paths that map to a different drive than the configured workspace).

### Tests
- **New: `tests/workspaceBoundaryPermission.test.ts`**: 14 unit tests verifying the split flag defaults and independence, `MODIFYING_TOOLS` list correctness, and the non-interactive CLI handler blocking all file write tools while allowing shell/read tools.

---

## [1.2.86] - 2026-07-03

### Added
- **JSON Subagent Report Handshake**: `SUBAGENT_REPORT_INSTRUCTION` is now a function that embeds the concrete report file path (`~/.superagent-r/subagents/<id>_report.json`) per subagent ID. Subagents are instructed to write a structured JSON report on completion. `extractSubagentReport()` now prefers this file-based report (machine-readable, includes `verificationPassed` field) over regex-scanning chat history, with full markdown fallback for backward compatibility.
- **Live Workspace State Context Block**: New `WorkspaceStateTracker` module (`src/core/context/WorkspaceStateTracker.ts`) that builds a concise live state snapshot injected into the dynamic context on every agent iteration for master/single/superagent tiers. Displays task progress (done/total + next pending tasks), current plan objective, and active/completed subagent IDs — preventing context drift between turns.
- **`verificationPassed` Self-Report Field**: Subagent JSON report schema includes a `verificationPassed` boolean so the parent agent can instantly detect if a subagent verified its work (build/tests) or not, and spawn a reviewer automatically when needed.

---

## [1.2.85] - 2026-07-03

### Changed
- **Auto-Pinning for Plans and Checklists**: Added `autoPinKeyMessages` in `ContextManager.ts` to automatically scan conversation logs and pin user requirements, task lists, and implementation plan documents, preventing critical state from being compacted.

### Fixed
- **TencentDB Sync & Skills Discovery Build**: Built fixes to sanitize TencentDB sync payloads (avoiding HTTP 400 empty string errors) and skills discovery prompts (preventing search loop commands).

## [1.2.84] - 2026-07-03

### Changed
- **Global vs Per-Project Memory Scoping**: Added `scope` parameter (`"project"` | `"global"`) to `save_shared_memory` and `tdai_memory_save` tools to isolate workspace findings and prevent cross-project context pollution.
- **Agent Context Filtering**: Updated `sharedMemoryNotice` in `agent.ts` to filter shared memories based on current workspace path, rendering distinct `GLOBAL AGENT MEMORIES` and `PROJECT AGENT MEMORIES` sections with token allocation caps.
- **System Prompts Update**: Added `SHARED_MEMORY_SCOPING` rule to `MASTER_AGENT_SYSTEM_PROMPT` and `SUPERAGENT_SYSTEM_PROMPT` in `src/core/prompts.ts` to guide agents on selecting appropriate memory scopes.

---

## [1.2.83] - 2026-07-03

### Fixed
- **Dynamic Hooks Toolset Guard**: Added `Array.isArray()` guard before calling `.push()` and `filterArray()` on `subagentToolsets[key]` in `refreshDynamicHooks()` (`tools/index.ts`). When running the full test suite, cross-test module state could result in a key existing in `subagentToolsets` with an `undefined` value, causing `Cannot read properties of undefined (reading 'push')` errors.

---

## [1.2.82] - 2026-07-03


### Fixed
- **Skills Discovery Order Bug**: Fixed `getInstalledSkills()` in `skills.ts` to discover superagent package built-in skills **first** (as the base), then project-local `.agents/skills` are appended last as overrides. Previously, project-local skills were searched first, causing built-in package skills to be silently dropped when a name collision occurred — so the agent never saw them in the INSTALLED AGENT SKILLS list.
- **Deduplication Logic**: Changed from "skip on duplicate name" to **"replace on duplicate name"** — a later (higher-priority) skill with the same name now replaces the earlier package version. This ensures project-local customizations always win while all unique package skills remain visible.

---

## [1.2.81] - 2026-07-03


### Changed
- **Optimized Prompt Caching**: Modified `injectDynamicContext` in `agent.ts` to only include the step-counter warning when remaining steps are 5 or fewer. This keeps the message history static for the vast majority of execution turns, allowing near 100% LLM prompt cache hits across steps.
- **Softened Single-Agent Subagent Delegation**: Softened subagent delegation rules in `singleModeSubagentDirective` for single-agent mode (`tier === "single"`), allowing direct file editing, reading, and command execution for simple tasks without process-spawn overhead.
- **Concurrency & Rate Limit Lock Optimizations**: Implemented in-process locking and queuing (`processQueue`, `processLocked`) in `SharedConcurrencyLimiter` and `SharedRateLimiter` within `rateLimiter.ts` to coordinate lock acquisitions in memory before polling the filesystem, significantly reducing lock contention and I/O latency.

---

## [1.2.80] - 2026-07-03

### Changed
- **Empty Workspace Optimization for FastContext**: Added an early check `hasExploreableFiles` to `fastcontextTool.ts` that recursively detects if the workspace contains any non-hidden, non-ignored files. If the workspace is empty or contains only configuration/hidden files (like `.git`), FastContext will skip execution and return immediately, preventing unnecessary API calls, token usage, and process spawning.

---

## [1.2.79] - 2026-07-03

### Changed
- **Input Performance Optimization**: Optimized typing latency by adding local state tracking and a 100ms debounced update system to the terminal input box (`ChatTextInput`). Updates are propagated immediately under conditions such as slash commands, active wizard prompts, empty values, or pasted blocks to ensure no loss of functionality or responsiveness.
- **UI Render Optimization**: Memoized peripheral components (including `ActiveAgentsList`, `TaskChecklist`, `HistoryPanel`, `StatusBar`, `ActiveProcessesPanel`, `ActiveSubagentsPanel`, and `DashboardStatusBar`) using `React.memo` to eliminate redundant renders during input updates.

---

## [1.2.78] - 2026-07-03

### Added
- **Preset List Search-Filtering & Navigation**: Expanded query-based filtering, item pagination (max 10 visible items), and up/down arrow keyboard navigation to all model preset lists (Apply Preset: step 4, Select Preset to Edit: step 30, and Select Preset to Delete: step 40) for both single-agent and multi-agent modes.

---

## [1.2.77] - 2026-07-03

### Added
- **Model Provider Profile List Filtering & Navigation**: Enabled query-based filtering, pagination (max 10 visible items), and up/down arrow keyboard navigation in the provider profile selection screen (steps 3, 25, 35) for both single-agent and multi-agent modes.

---

## [1.2.76] - 2026-07-03

### Changed
- **Tidy Up Log/Session History**: Nested Superagent and Subagent session folders under their parent Master/Super Agent session directory respectively (using `process.env.SUPERAGENT_SESSION_PATH`) to keep history folder layout clean and self-contained.
- **Ignore Category Subdirectories**: Updated `listHistorySessions` to explicitly filter out `superagents` and `subagents` subdirectories to prevent them from being scanned or processed as history sessions.

---

## [1.2.75] - 2026-07-03

### Added
- **Tier-Level Tool Validation**: Exposed `getActiveTools()` on the `Agent` class to retrieve allowed tools per tier. Implemented strict runtime checks in `executeToolCall()` (permissions layer) to block unauthorized tools at the execution level across all tiers.
- **Forced Prompt-Based Override**: Added `forcePromptBasedToolCalling` config flag to `SystemSettings` and default configuration to allow developers to force prompt-based (XML) tool calling.
- **Resilient XML Parser**: Enhanced XML regexes and cleanup helpers to support optional attributes in XML tags (e.g. `<tool_call id="...">`), improving stability under mixed model outputs.

---

## [1.2.74] - 2026-07-03

### Fixed
- **Persistent Tool Support Probe Cache & Increased Timeout**: Implemented disk-based persistence for `probeToolCallSupport` in `~/.superagent-r/tool_support_cache.json` to prevent repeated latency-inducing API calls on every CLI invocation. Increased the probe HTTP request timeout from 10 seconds to 30 seconds to allow slower local models or custom OpenAI-compatible proxies (such as local Orbit presets) to successfully complete the initial probe, resolving a bug where slow custom endpoints timed out during the probe, fell back to `supportsNativeTools = false`, and subsequently crashed Vercel AI SDK with a "Model tried to call unavailable tool... No tools are available" error.

---

## [1.2.73] - 2026-07-03

### Added
- **DAG Cycle Detection**: Integrated dynamic DFS-based cycle detection in `invokeSuperagentTool` to prevent deadlocks from circular agent dependencies (e.g., C -> A -> B -> C).
- **Shared Memory Compaction & TencentDB Sync**: Updated the shared memory system to automatically prune entries older than 7 days (TTL compaction) and enforce a maximum limit of 30 entries. Connected compaction to delete pruned findings atomically from TencentDB Memory if enabled.
- **Conflict Resolver Telemetry**: Added conflict resolver UI telemetry piping to improve UI feedback during automated git merge conflict resolution.

---

## [1.2.72] - 2026-07-03

### Added
- **Multi-Agent Optimizations & Superpowers**:
  - **DAG Task Scheduling**: Added `dependsOn` arrays to `invoke_superagent` with wait loops and dependency branch pre-merging.
  - **Programmatic Conflict Resolver**: Integrated a programmatic subagent fallback in Master Agent `mergeBranch` to resolve git conflicts in conflicted files if line-based auto-resolution fails.
  - **Spin-Locked Shared Memory**: Created `save_shared_memory` tool with concurrent spin-lock file safety for shared agent discoveries, and injected findings into system prompts.
  - **Skill Token Compression**: Minified preloaded `SKILL.md` documents via telegraphic English replacements.
  - **Fast Provisioning**: Added detailed master execution logs for `node_modules` provisioning.

---

## [1.2.71] - 2026-07-03

### Fixed
- **Multi-Agent Collapsible Tools & Clicks**: Fixed a bug where tool log groups that are not nested under an agent/user message (such as immediate tool calls at the start of a Superagent session) were unclickable/unexpandable, failing to render their merged results and output. Made the click handler in `useDashboardMouse.ts` strictly check for clicks within the visible vertical bounds of the log box to avoid misalignments.

---

## [1.2.70] - 2026-07-02

### Changed
- **Aligned Log Console Layout & Removed Dividers**: Adjusted the log console formatting in `dashboardLogFormatter.tsx` to align tool inputs, outputs, and separator lines perfectly with the expanded tool header by substituting spaces for extra inner vertical tree line elements. Completely removed the horizontal divider line (`──────────`) from expanded tool logs.

---

## [1.2.69] - 2026-07-02

### Changed
- **Multi-Agent Mode Footer Simpler Layout**: Simplified the redesigned status bar to use a clean and minimal cyberpunk text layout, replacing the heavy pseudo-tree bracket characters with clean label tags and simple vertical dividers (`│`).

---

## [1.2.68] - 2026-07-02

### Fixed
- **Prompt-based Tool Calling History Format**: Resolved an issue where reasoning/thinking models or custom endpoints would get stuck in a "Communication error: Model tried to call unavailable tool..." retry loop. This occurred because previous turns executed native tool calls, but subsequent calls to the model had native tool calling disabled (`supportsNativeTools = false`), causing the LLM provider API to reject the history containing native tool-call/tool-result blocks. Fixed by resolving `supportsNativeTools` early in the execution loop and converting the history messages containing native tool calls and results to standard XML text prompts when native tools are disabled.

---

## [1.2.67] - 2026-07-02

### Changed
- **Multi-Agent Mode Footer Redesign**: Restructured the multi-agent mode footer (`src/components/dashboard/dashboard-status-bar.tsx`) to use a clean, structured cyberpunk panel style with consistent border characters (`┌───`, `├───`, `└───`), colored tags for engine status and statistics, and aligned layout rows to match height budgeting, eliminating word-wrapping issues.

---

## [1.2.66] - 2026-07-02

### Fixed
- **Multi-Agent Collapsible Log Group Clicks**: Resolved a click-to-expand bug where collapsible tool/think log headers were unclickable for `SUPERAGENT` sessions. The layout math of `logBoxStartRow` and `logBoxHeight` now dynamically accounts for the taller Title box (2 lines instead of 1) in sessions that render a git worktree path, preventing mouse coordinate misalignment.
- **Collapsed Header Duplicate Emojis**: Removed the redundant icon prefix rendering in collapsed log headers. The headers now correctly rely solely on the beautiful emoji prefixes defined directly on each group's label.

---

## [1.2.65] - 2026-07-02

### Fixed
- **Tool Error Log Truncation**: Increased the log truncation slice limit from 200 to 2000 characters for `appendMasterLog` and `appendToolsErrorLog` in `src/core/permissions.ts`, as well as `src/core/tools/subagentTools.ts`. This prevents absolute folder paths and detailed error messages from being truncated (e.g., cutting off in the middle of session folder names), resolving cosmetic errors that look like path resolution bugs in the multi-agent UI.

---

## [1.2.64] - 2026-07-02

### Fixed
- **Tool Support Probing with Reasoning Models**: Improved the `probeToolCallSupport` utility by changing the test probe prompt to explicitly instruct the model to call the probe tool, increasing the token limit to 128 to accommodate thinking/reasoning prefixes, and ensuring strict boolean coercion of the result. This prevents tool-capable models on custom/local endpoints (like Cohere) from failing the probe and triggering "unavailable tool 'manage_plan'" errors during subsequent runs.

---

## [1.2.63] - 2026-07-02

### Fixed
- **Multi-Agent Collapsible Tool Logs Clicks**: Unified log parsing, nesting, merging, and line wrap calculations between `computeLogGroupBoundaries` and `computeWrappedLogs` in `dashboardLogFormatter.tsx`. Correctly accounted for stripped prefixes in boundary wrap math and added line count mappings for expanded tool divider and output streams, ensuring terminal click actions perfectly align with log entries for expansion and collapse.

---

## [1.2.62] - 2026-07-02

### Fixed
- **Multi-Agent Provider Preset Routing**: Resolved a bug where custom model presets saved from the model wizard omitted the provider prefix (e.g. `cohere/north-mini-code:free` instead of `openrouter@cohere/north-mini-code:free`) if they matched the active provider. When applied, these presets resolved `providerProfileId` to `""`, causing the connection details resolver to fall back to the first available provider with a key (e.g., local proxy on port 8085), leading to connection failures. Fixed by always prepending the provider prefix in the wizard and adding automatic parsing of `@` strings in `setTierModel`/`setAllTierModels`.

---

## [1.2.61] - 2026-07-02

### Fixed
- **Multi-Agent Log Stream Carriage Return Resolution**: Fixed an issue where carriage returns (`\r`) in the master log queue were stripped prior to stream concatenation, preventing correct in-place countdown updates and causing wrapped lines to duplicate rather than overwrite. Updated the log processing interval in `MultiAgentDashboard` to retain raw carriage returns and apply `resolveCarriageReturns` across concatenated master agent log text.

---

## [1.2.60] - 2026-07-02

### Fixed
- **Multi-Agent & Subagent Retry Countdown Formatting**: Resolved an issue where communication retry countdowns (`\rRetrying in Xs...`) in multi-agent mode and subagents caused line wrapping collisions, text corruption (e.g. `ttempt 1/10...ation error:`), and log file pollution. Updated `resolveCarriageReturns` in `src/utils/text.ts` to cleanly handle trailing carriage returns from CRLF and inline updates, and integrated it into `appendToThinkingNode` across `subagentTools.ts`, `superagentTools.ts`, and `cli.tsx`.

---

## [1.2.59] - 2026-07-02

### Fixed
- **TencentDB Gateway Silence Persistence**: Fixed an issue where the `tencentdb-gateway` process would still appear in the Active Processes list in single or multi mode. Added `isHidden` to the persisted tasks schema in `background-tasks.json` so that the hidden status is preserved across CLI sessions. Also updated the `/processes` slash command and the keyboard dashboard navigation hooks to correctly filter out hidden tasks.

---

## [1.2.58] - 2026-07-02

### Fixed
- **XTerm SGR Mouse Click Leak Fix**: Fixed an issue where rapid or partial XTerm SGR mouse tracking escape sequences (e.g. `[<0;1;5M`) would leak directly into the terminal prompt. Implemented a robust prefix-based filter in the dashboard keyboard hook `useDashboardKeyboard` and the text input component `ChatTextInput` to catch and ignore all full and partial mouse click sequences.

---

## [1.2.57] - 2026-07-02

### Added
- **TencentDB Gateway Daemon Silence**: Added `isHidden` flag support to `BackgroundTask`. Configured TencentDB Memory Gateway auto-started background processes to run completely silently in the background by excluding them from the terminal dashboard's Active Processes list, Workspace Registry list, and active agents list, resolving clutter in multi-agent mode.

---

## [1.2.56] - 2026-07-02

### Fixed
- **UI Log Scroll Lock**: Fixed an issue where the conversation log/history could not be scrolled using the Up/Down arrow keys during thinking or streaming (when the agent is processing). Also implemented dynamic scroll-pinning so that if the user scrolls up to view past logs, the viewport does not slide downwards when new streaming tokens or logs are appended at the bottom.

---

## [1.2.55] - 2026-07-02

### Fixed
- **MCP Live Process Bleed**: Fixed `McpManager` passing no `stderr` option to `StdioClientTransport`, which caused the MCP SDK to default to `stderr: 'inherit'`. This made subprocess output from MCP server processes (e.g. `pip install`, build logs) flood directly into Superagent's terminal UI as an unexpected "live process". Now `stderr: 'pipe'` is passed explicitly, capturing all subprocess output internally. Captured stderr is surfaced in error messages when the MCP connection fails, providing richer diagnostics without polluting the terminal.

---

## [1.2.54] - 2026-07-02

### Fixed
- **Workflow Testing**: Mocked `execa` in `tests/masterAgentWorkflow.test.ts` to prevent executing real git commands (such as creating the `feat/test` worktree/branch) on the host repository during test runs.

---

## [1.2.53] - 2026-07-02

### Added
- **Pragmatic Minimalism Skill**: Consolidated a new pragmatic-minimalism skill guidelines to promote simple, minimal, and high-impact solutions.
- **Coding Guidelines Update**: Added coding best practices, maintainability, scalability, and modularity guidelines to `AGENTS.md`.

### Changed
- **Best Practices Refinement**: Refined best practices guidelines in `AGENTS.md` to use token-efficient, telegraphic English.

---

## [1.2.52] - 2026-07-02

### Changed
- **Gitignore Update**: Added `node_modules/`, `dist/`, `bin/python/`, `vendor/`, and local temporary test directories to `.gitignore` to keep git status clean.

---

## [1.2.51] - 2026-07-02


### Added
- **Keyboard Auto-Refocus**: Typing any printable character (letters, spaces, symbols) while a non-input panel (like logs, registry, or checklist) is focused will automatically switch focus back to the input box and append the typed character to the input query.

---

## [1.2.50] - 2026-07-02

### Changed
- **Help Text and Documentation**: Updated `/help` command output and setting descriptions in `/settings` command helper messages to clarify that setting the value to `0` configures `unlimited` max iterations and `auto` context window limits.

---

## [1.2.49] - 2026-07-02

### Changed
- **Unlimited Iterations Limit**: Added support for setting the agent loop iteration limit (`maxIterations`) to `0` for unlimited execution. Updated display strings in settings and loop messages to show `"unlimited"` instead of `0` or `Infinity`.

---

## [1.2.48] - 2026-07-01

### Changed
- **Skills Prompt Optimization**: Replaced the detailed list of installed agent skills with a concise, telegraphic instruction set in the system prompt. This directs the agent to locate and read relevant skills under the `.agents/skills/` directory on-demand, saving thousands of prompt tokens and reducing system prompt bloat.

---

## [1.2.47] - 2026-07-01

### Fixed
- **Test Stability**: Increased polling timeout to 10s and reduced polling step to 10ms in `agentAbortInterrupt.test.ts` to prevent flaky failures under high CPU load or concurrent test execution.

---

## [1.2.46] - 2026-07-01

### Changed
- **System Prompts Optimization**: Redesigned and audited all system prompts in the codebase (`MASTER_AGENT_SYSTEM_PROMPT`, `SUPERAGENT_SYSTEM_PROMPT`, and all four `SUBAGENT_SYSTEM_PROMPTS`) using Concepts A, B, and C (Telegraphic English, Markdown structure, and Pseudocode logic gates) to achieve a ~50% reduction in token count and increase reasoning reliability.
- **System Prompt Guidelines**: Added a dedicated `System Prompt Guidelines` section to `AGENTS.md` to serve as a project specification and reference for writing and maintaining system prompts.

---

## [1.2.45] - 2026-07-01

### Fixed
- **Malformed XML/JSON Tool Call Parsing**: Fixed a bug where the model's blended/malformed XML and JSON tool calls (e.g. `<tool name="..." "arguments": {...}}` or `<tool_name="..." "arguments": {...}}`) would fail to parse and leak onto the user's terminal as plain text. Added robust brace balancing fallback parsing and updated the stream filter (`StreamXmlFilter`) to correctly block these malformed tool blocks from being printed to the stdout stream.

---

## [1.2.44] - 2026-07-01

### Fixed
- **TencentDB Memory Client API Alignments**: Updated `/memory` slash command and `tdai_memory_save` tool execution logic to match the updated `@tencentdb-agent-memory/memory-tencentdb` signature where `updateAtomic` parameters do not include `type` or `upsert` fields. Fixed corresponding unit and integration tests.

---

## [1.2.43] - 2026-07-01

### Added
- **Multi-Agent vs Single-Agent Skill Grouping**: Added `isMultiAgent` filtering in `loadAgentSkills`. When running in single-agent mode, multi-agent specific skills (such as `master-agent-orchestration`, `team-composition-patterns`, `team-communication-protocols`, and `dispatching-parallel-agents`) are automatically filtered out and excluded from the agent skills prompt to prevent unnecessary token consumption and guidelines clutter.

---

## [1.2.42] - 2026-07-01

### Added
- **State-Based Preloaded Skills Optimization**: Optimized preloaded guidelines/mandatory skills inside `Agent` system prompt. Skills (like `superagent-planning`, `executing-plans`, `systematic-debugging`) are now dynamically preloaded based on the agent's current planning/execution state and query keywords, saving another 4,000–7,000 tokens on every turn. Added an in-memory caching system to prevent redundant disk I/O when dynamically building guidelines.

---

## [1.2.41] - 2026-07-01

### Added
- **Dynamic Skill Filtering & Prompt Optimization**: Implemented query-based dynamic filtering for loading agent skills. This replaces the static all-skills injection, reducing initial system prompt tokens by up to 10,000–15,000 tokens. It uses whole-word keyword matching against the user's recent queries while permanently retaining a core set of operational skills (like `karpathy-guidelines` and `getting-started-with-skills`).

---

## [1.2.40] - 2026-06-30

### Fixed
- **XML Tool Call JSON Parsing Robustness**: Implemented a regex-based JSON parser and repair fallback in `xmlToolParser` to successfully extract and parse tool arguments containing unescaped double quotes. This prevents slightly malformed JSON outputs (e.g. from local/custom models trying to execute bash commands) from failing to parse and leaking as raw XML/JSON text in the terminal.

---

## [1.2.39] - 2026-06-30

### Added
- **Focus Commands Help & Autocomplete**: Added autocomplete suggestions for `/setting-focus` and `/focus` subcommands in the CLI. Added `/setting-focus` and `/setting-focus-budget` commands to the `/help` output.

---

## [1.2.38] - 2026-06-30

### Added
- **Focus Setting (Reasoning Depth Control)**: Implemented a rebranded focus level setting (`off`, `low`, `medium`, `high`, `xhigh`, `max`, `custom`) allowing users to control reasoning thinking token budgets for Anthropic Claude 3.7+ models and reasoning effort for OpenAI o-series models.
- **Focus Slash Commands**: Implemented `/setting-focus` (alias `/focus`) and `/setting-focus-budget` commands to configure focus levels and budgets from the CLI.
- **Focus UI Display**: Integrated focus level status indicators dynamically onto the terminal `StatusBar` footer.

---

## [1.2.37] - 2026-06-30

### Changed
- **Release Sync**: Version bump for release synchronization.

---

## [1.2.36] - 2026-06-30

### Added
- **Help and Suggestions for MCP**: Updated `/help` command output to describe `/mcp` subcommand usage. Added autocomplete tab-completion suggestions for `/mcp` subcommands (`list`, `add`, `remove`, `reload`) in the CLI.

---

## [1.2.35] - 2026-06-30

### Changed
- **Footer UI cleanup**: Removed the keyboard shortcuts legend and the green `🟢 ONLINE` connection indicator/text from both the single-agent `StatusBar` footer and multi-agent `DashboardStatusBar` footer.
- **Help Command Updates**: Moved and expanded the keyboard shortcuts info to the `/help` command output.

---

## [1.2.34] - 2026-06-30

### Added
- **AI Agent MCP Management**: Exposed the `manage_mcp` tool to the AI agents (`masterToolset`, `superagentToolset`, and `defaultSubagentToolset`). This allows agents to programmatically add, remove, list, and reload MCP servers during feature implementation.
- **Pengujian**: Extended tests in `tests/mcp.test.ts` to cover `manage_mcp` tool execution actions.

---

## [1.2.33] - 2026-06-30

### Added
- **MCP Client Feature**: Integrated Model Context Protocol (MCP) client features. Superagent can now connect to local/remote stdio-based MCP servers and register their tools dynamically across all agent tiers (Master, Superagent, and Subagents).
- **McpManager**: Created `src/core/mcp/McpManager.ts` to manage the lifecycle of MCP server connections and tools.
- **MCP Slash Command**: Implemented `/mcp` command (with `list`, `add`, `remove`, `reload` subcommands) in `src/core/commands/mcpCommand.ts` to easily inspect and configure MCP servers from the terminal.
- **Tests**: Created a comprehensive mock-based test suite in `tests/mcp.test.ts` to verify MCP configurations and tool loading.

---

## [1.2.32] - 2026-06-29

### Audited & Improved
- **System Prompts**: Audited system prompts across all tiers (Master, Superagent, Subagents).
- **Windows Command Separator Support**: Added explicit Windows PowerShell command separator (`;` instead of `&&`) instructions to `coder`, `reviewer`, and `manual-tester` subagent prompts to ensure robust command execution on Windows.
- **Manual Tester UI/UX Checks**: Integrated high-quality visual UI/UX / design taste checks into the `manual-tester` system prompt.
- **Redundant Prompts Clean-up**: Imported `SUBAGENT_SYSTEM_PROMPTS` directly into `src/core/tools/index.ts` for subagent registration, preventing drift and eliminating duplicate/redundant hardcoded prompts.
- **Duplicate Reports Prevention**: Updated `subagentTools.ts` to skip appending the generic `SUBAGENT_REPORT_INSTRUCTION` if the resolved subagent prompt already defines a custom report format, preventing model confusion from duplicate instructions.
- **Documentation Refinement**: Removed outdated comment about `loadAgentSkills` inside `prompts.ts` to keep codebase docs accurate.

---

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
