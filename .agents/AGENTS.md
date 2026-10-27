# Project-Scoped Rules (Superagent Workspace)

## Response Formatting

- **Readable & Structured Markdown Formatting**: Use clean GitHub-flavored markdown formatting (including headings `##`/`###`, bold highlights `**text**`, bullet points, code blocks, and tables where appropriate) to make responses well-structured, clear, and easy to read. Avoid plain, unformatted walls of text.
- **Display File Changes**: In every superagent process, if there are file changes (created, modified, or deleted files), they MUST always be displayed at the end of the response.
- **Project Completion Conclusion**: Every time a project, feature, or multi-step task is completed, the final response MUST include a clear conclusion/summary outlining the outcome, key changes, verification results, and next steps before listing changed files.

## Mandatory Skills

- **Design Tasks**: When building, designing, or refactoring user interfaces, layouts, components, or web applications, you MUST treat the hallmark skill (.agents/skills/hallmark/SKILL.md) as a mandatory skill and read its instructions using the view_file tool before proceeding.
- **Debugging Tasks**: When investigating bugs, runtime errors, failures, or diagnosing issues, you MUST treat the non-linear-debugging skill (.agents/skills/non-linear-debugging/SKILL.md) as a mandatory skill and read its instructions using the view_file tool before proceeding.

# Project Specifications (agents.md) 

This file contains key information about the project for AI agents to study and align with when working on Superagent.

## Project Overview
- **Name**: Superagent
- **Description**: An interactive, terminal-based AI coding assistant featuring a cyberpunk style terminal UI, context token tracking, and a 3-tier multi-agent orchestration system (Master Agent → Superagent → Subagent).
- **Technology Stack**: Node.js, TypeScript, React, Ink (Terminal UI Components), Vercel AI SDK, Execa, Vitest
- **Desktop Client Integration (t-line)**: Superagent integrates with [t-line](file:///D:/backup%20from%20pc%20asus/Documents%20Development/t-line), which is the desktop version of the superagent CLI. This is supported via a client/server bridge mode (`superagent --server [port] --client-mode tline`).

## Runtime Ownership and T-Line Integration (2026-10-26)

**Mandatory deployment contract for all new Core, MCP, OAuth, desktop and recovery work:**

- **ONE primary SuperAgent runtime stack** serves normal CLI and T-Line use. Its Core, MCP and OAuth services may have **separate authenticated OS process owners**; "one runtime" does **not** mean forcing them into one shared PID. Normal T-Line operation runs **ONE T-Line backend**, never an additional backend for staging.
- **Testing is temporary, not a second permanent environment**: use a fresh, existing private child profile beneath `~/.superagent-local-staging/` and separate loopback ports owned by the test run. Stop verified test-owned processes and release listeners after a bounded test; preserve evidence, and do not delete a profile while process/effect ownership is uncertain. Do not install persistent Windows tasks, tunnels, or alternate T-Line services as a test shortcut.
- **Startup-only T-Line target selection**: T-Line uses `TLINE_SUPERAGENT_RUNTIME=primary|testing`, `TLINE_SUPERAGENT_CORE_PORT`, `TLINE_SUPERAGENT_OWNER_MODE=supervised-external` (testing only), and a matching `SUPERAGENT_CONFIG_DIR`. This is a Core routing/bootstrap exception to the provider/model configuration policy below: model credentials and settings still belong in JSON, not environment variables.
- **No hot-switch or hidden fallback**: never reroute active chats, MCP sessions, approvals, WebSockets or external tool actions between primary and testing. The test Core must already exist and pass the private authenticated owner contract; if missing/unverifiable, fail closed without launching or taking over a new owner. Before changing runtime at startup, drain/finish active work and independently verify its target identity.
- **Protect existing listeners and owners**: 6759, 6789, 7888 and 9877 are known legacy/protected ports (not a complete permanent port list). Always inspect the current OS listener PID and process birth identity and authenticate private owner readiness. A PID file, an old snapshot, a responsive HTTP port or a missing listener does NOT grant adoption/kill permission. Never signal/restart/stop the shared production Core/MCP PID from a test or use PID-only termination.
- **MCP and OAuth isolation**: Core restarts must not implicitly restart the independent MCP owner; an MCP replacement must invalidate old in-memory sessions and require fresh initialization. No implicit POST/tool replay, legacy OAuth token import or session-ID reuse. Default tools remain safe-scoped and require permission checks at execution.
- **MCP YOLO privilege ceiling**: YOLO OFF denies every dangerous MCP call regardless of `--allow-dangerous`, OAuth write/admin scopes, granted project capabilities, cached discovery or gateway recursion. Scoped YOLO enforces its path/project boundary and protected-file guard. Full YOLO only broadens local path permissions; tool exposure, explicit OAuth scopes, project authorization and hard blocklists remain mandatory. Recheck persisted YOLO mode for every call even in long-lived/independent owners, and fail closed on missing/unreadable state. Only the authorized operator may change YOLO mode; never enable it automatically based on agent prompts, requested grants, or scopes.
- **Release gates stay enforced**: R0–R7 `blocked` means NO automatic production cutover. Public HTTPS/TLS, isolated OS keystore/ACL, installed native desktop E2E, Windows recovery, extended soak, rollback and explicit per-client PKCE reauthorization/operator approval require genuine evidence. Passing staging unit tests does not certify production.
- **Reuse existing modules/components first**: extend the existing Core supervisor, MCP owner lifecycle, T-Line routing and UI components rather than introducing duplicate registries, daemons, providers, state stores or selectors. Keep one source of truth per domain. Never stage/commit unrelated worktree changes from other agents.
- **Verification and commits**: for each change, run focused tests and `bun run build` when source changes; capture real OS evidence for lifecycle claims. Commit only explicitly related files; update version/changelog and evidence/plan documents as required by the repository policy. A passing build is not an installed-desktop certification.

**Canonical references:** `docs/guides/runtime-primary-and-temporary-test-profile.md`,
`docs/plans/2026-10-26-runtime-p1-p4-parallel-activation-e2e-release-execution-plan.md`,
`docs/guides/runtime-r0-r7-2026-10-26-evidence.md`.
T-Line implements the other side in `backend/src/superAgentRuntimeTarget.ts`,
`backend/src/superAgentCoreOwnership.ts` and
`docs/guides/single-superagent-runtime-target.md` in its own repository.

## 3-Tier Multi-Agent Architecture

Superagent supports a full 3-tier agent hierarchy activated via `superagent --multi`:

```
Master Agent  (orchestrator)
  └── Superagent  (per-feature, isolated in git worktree)
        └── Subagent  (atomic ops, ephemeral)
```

### Tier Responsibilities
| Tier | Role | Toolset | Isolation |
|------|------|---------|-----------|
| **Master Agent** | Orchestration, planning, result merging | `invokeSuperagentTool`, `awaitSuperagentsTool`, `mergeSuperagentsTool`, `manageSuperagentsTool`, `manageSubagentsTool`, `gitWorktreeTool` | Main repo |
| **Superagent** | Feature-level development | Shell + File tools + `invokeSubagentTool`, `manageSubagentsTool`, `gitWorktreeTool` | Isolated git worktree (`~/.superagent-r/worktrees/<name>`) |
| **Subagent** | Ephemeral subagent types (e.g. `researcher`, `coder`, `reviewer`, `software-tester`, `chrome-agent`). Note that Chrome/browser control is isolated to `chrome-agent`. | Tools allowed per subagent type | Ephemeral, within parent worktree |

### Key Files
- `src/core/masterAgent.ts` — Master Agent entry point and orchestrator logic
- `src/core/tools/types.ts` — Shared types: `AgentTier`, `SubagentInstance`, `ToolSet`
- `src/core/tools/toolsets.ts` — ToolSet definitions keyed per tier (`masterToolset`, `superagentToolsets`, `subagentToolsets`)
- `src/core/tools/prompts.ts` — System prompts per tier with dynamic context injection
- `src/core/tools/state.ts` — Shared subagent registry, instances map, event emitters
- `src/core/tools/superagentTools.ts` — Master tier tools: invoke/list/merge/manage Superagents
- `src/core/tools/subagentTools.ts` — Superagent tier tools: spawn ephemeral Subagents
- `src/core/context/ContextManager.ts` — Central orchestrator for context window management (state machine, strategy selection, recovery)
- `src/core/context/TokenTracker.ts` — Model-specific token counting via tiktoken (includes tool calls/results)
- `src/core/context/CompactionStrategy.ts` — Pluggable strategy interface for compaction algorithms
- `src/core/context/strategies/SummarizationStrategy.ts` — LLM-based summarization (with heuristic fallback)
- `src/core/context/strategies/PruningStrategy.ts` — Emergency pruning with summary preservation (never silent context loss)
- `src/core/context/strategies/PinningStrategy.ts` — Preserve critical pinned messages during compaction
- `src/core/context/SemanticAnalyzer.ts` — Topic boundary detection, importance scoring, key point extraction
- `chrome-extension-remote/` — Standalone lightweight Chrome Extension (Manifest V3) for remote-controlling any Chrome profile/browser from Superagent CLI via serverless WebSocket bridge (port 9223). No sidepanel GUI; minimal footprint, multi-profile capable.
- `chrome-extension/` — Full Superagent AI assistant Chrome Extension (Manifest V3) with sidepanel GUI for browser control, tab/DOM management, text/markdown extraction, console/network logs, storage/cookies management, device emulation, and more. Installed directly in target browser it controls (`clientMode = "chrome-extension"`). Must NOT be confused with `chrome-extension-remote/` or port 9223.
- `src/core/tools/remoteChromeBridge.ts` — Serverless WebSocket server (port 9223) auto-initialized on-demand by Superagent CLI; communication backbone for `chrome-extension-remote/`.
- `src/core/gateway/` — Omnichannel Messaging Gateway supporting Telegram, Discord, Slack, and Webhooks with session routing and outbound chunking.
- `src/core/daemon/` — Autonomous Headless Daemon & Cron Scheduler (`daemonScheduler.ts`, `cronParser.ts`, `daemonCli.ts`) with 5-field cron parsing.
- `src/core/skills/` — Autonomous Skill Synthesizer (`synthesizer.ts`, `skillValidator.ts`, `trajectoryExtractor.ts`) and `synthesizeSkillTool.ts`.
- `src/core/config/systemCache.ts` — Persistent 24-hour system check cache (`~/.superagent-r/system-cache.json`) for binary resolution.
- `src/components/startup-checker.tsx` — Parallelized dependency validator with decoupled background model warming.
- `src/components/startup-prompt.tsx` — First-run interactive choice dialog when no AI provider is configured.

## Recent Features (v1.5.146-v1.13.87)

- **Windows Path Resilience, Missing Description Elimination & Multi-Read Priority (`permissions.ts`, `ToolExecutor.ts`, `fileReadTools.ts`, `advisorHelpers.ts`, v1.13.87)**:
  - Fixed Windows path backslash parsing inside stringified JSON arrays (e.g. `filePaths: "[\"C:\\Users\\...\"]"`), converting unescaped backslashes before quotes to avoid `JSON.parse` escape errors.
  - Added upfront batch argument normalization in `ToolExecutor.ts` before tool description generation and boundary checks, completely eliminating `(missing)` path indicators.
  - Added `multi_replace_file_content`, `superagent_replace_file_content`, and `superagent_apply_patch` to Advisor `WRITE_TOOLS` so successful edits reset the unmutated read counters and avoid repetitive Advisor loop penalties.
  - Enforced `MULTI READ PRIORITY` across `ContextBuilder.ts`, `base.ts`, and `prompts.ts` to instruct models to read all relevant files concurrently in a single turn.
- **Resilient Batch Parameter Normalization & Read Loop Prevention (`ToolExecutor.ts`, `fileReadTools.ts`, `fileEditTools.ts`, `ContextBuilder.ts`, v1.13.86)**:
  - Added auto-normalization for stringified JSON arrays (e.g. `filePaths: "[\"path\"]"`) and single entries across all batch operations (`filePaths`, `files`, `edits`, `patches`), preventing models from being blocked by false single-file invocation errors and Advisor loops.
  - Enhanced JSON schema for `filePaths` with explicit `items: { anyOf: [...] }` to prevent LLMs from generating ambiguous stringified representations.
  - Added BATCH ARGS FORMAT prompt directives in `ContextBuilder.ts` and `base.ts` to reinforce clean array syntax.
- **Optimized Tool Discovery & Direct Describe Fast Path (`ContextBuilder.ts`, `toolDiscoveryTools.ts`, `prompts.ts`, v1.13.85)**:
  - Added DIRECT DESCRIBE fast path to base prompt, instructing models to call `describe_tool` directly with batch `names: [...]` when needed tools are known, bypassing redundant `list_tools` calls.
  - Enforced EXPOSURE GATE in system prompt: explicitly warned models that invoking undescribed tools fails immediately, preventing direct invocation attempts before schema inspection.
  - Refined `runListTools` description scoring to use exact substring and keyword token boundaries rather than loose subsequence matching, eliminating false positive matches across the catalog for queries like `audit`.
  - Prohibited natural language questions and conversational task descriptions in `list_tools(query)`.
- **MCP Muse Two-Way Chat & Readiness (`src/core/mcp/tools/remoteAgentChatMcpTools.ts`, v1.13.75)**:
  - Added safe `superagent_muse_chat_status` to report whether the active watcher and authenticated WebSocket can support direct chat.
  - Added dangerous/opt-in `superagent_muse_chat`, which waits for a Muse `chat` reply whose `reply_to` matches the outgoing request ID. Timeout or disconnect is an error, not success.
  - Split remote-agent MCP code into shared, tunnel, Telegram, and chat modules, aggregated by `remoteAgentMcpTools.ts`.
  - Added user guidance in `docs/mcp/muse-chat-workflows.md` and the README.
- **Chrome Screen Sharing & Display Media Capture Automation** (`src/core/tools/chromeCdpMedia.ts`, `src/core/tools/chromeCdpTools.ts`, `scripts/chrome-debug.bat`, v1.13.53):
  - Added `mock_display_media` (aliases `mock_screen_share`, `bypass_screen_share`) to `control_chrome_cdp` to intercept `navigator.mediaDevices.getDisplayMedia` and return a synthetic stream without triggering native browser dialogs.
  - Added `handle_screen_share` (aliases `accept_screen_share`, `dismiss_screen_share`) to `control_chrome_cdp` to automate OS-level tab selection and confirmation on active Windows `DesktopMediaPicker` dialogs.
  - Added `--auto-select-desktop-capture-source="Entire screen"`, `--use-fake-ui-for-media-stream`, and `--enable-usermedia-screen-capturing` flags to `scripts/chrome-debug.bat` and `chromeCommon.ts`.
  - Added `displayCapture` to `Browser.grantPermissions` in `executeInspectMediaDevices`.
- **CDP Responsive Device Emulation & Kinematic Drag-and-Drop** (`src/core/tools/chromeCdpTools.ts`, v1.13.43):
  - Added `emulate_device` command to `control_chrome_cdp` supporting built-in presets (`mobile` / iPhone 14, `tablet` / iPad, `desktop` / 1920x1080, and `reset`) with metrics override, touch emulation, and optional user-agent overrides.
  - Added realistic `drag_and_drop` (alias `drag`) with Bezier trajectory interpolation, customizable duration and steps, and automated DOM drag/drop events.
  - Added explicit schema parameters (`preset`, `device`, `orientation`, `width`, `height`, `scale`, `touch`, `userAgent`) to `control_chrome_cdp` for full model visibility and `describe_tool` introspection.
- **Interactive Tool Discovery & Inspection** (`src/core/commands/coreCommands.ts`, `src/core/tools/toolDiscoveryTools.ts`, `src/core/tools/index.ts`, v1.13.43):
  - Added `/tools` slash command supporting interactive tool listing (`/tools [list]`), tool schema inspection (`/tools describe <name>`), and fuzzy tool search (`/tools search <query>`).
  - Added resilient tool aliases: `get_tools`, `describe_tools`, `get_tool`, `cdp`, `emulate_device`, `drag_and_drop` to prevent invocation errors when models use alternate phrasing.
  - Updated `/help` listing and system prompts across all tiers and configurations to enforce `TOOL_FIRST` discipline and responsive browser testing workflows.
- **Set-of-Mark (SoM) Vision & Layout Audit Engine** (`src/core/tools/chromeVisionTools.ts`, `scripts/vision_server.py`, v1.13.30+):
  - Unified vision stack exclusively on `racineai/UI-DETR-1` (~535MB RF-DETR Medium); completely eliminated legacy Microsoft OmniParser.
  - Implemented Set-of-Mark (SoM) perception (`perceive_page`): draws prominent numeric badge labels (`[1]`, `[2]`, `[3]...`) and color-coded bounding boxes on screenshots.
  - Added direct coordinate interaction (`click_id`, `type_id`) via native CDP input dispatch to element centers, bypassing brittle CSS selectors, shadow-DOM, and canvas barriers.
  - Added visual layout auditor (`audit_layout`): detects element collisions (>40%), touch-target defects (<24px), off-screen elements, and unlabeled interactive controls.
  - Added visual state verification (`verify_visual_state`): computes before/after screenshot pixel diffs via `/diff`.
  - Added interactive canvas and category filtering in Chrome Extension sidepanel (`chrome-extension/sidepanel-vision.js`).
- **Chrome process tools** (`src/core/tools/chromeProcessTools.ts`, v1.5.146): `list_running_chrome` (EnumWindows multi-window enumeration, profile display names from Local State, per-window tab lists via UI Automation) and `close_chrome_profile` (kills only the exact `--profile-directory` match). See README.
- **Tunnel chat + ESC menu** (v1.5.147): `ESC` at the main input while a tunnel is active opens a menu (stop tunnel / message Muse / continue); `/muse tunnel msg <text>` sends a `chat` envelope via the active WS socket. Muse side: `listener.py` writes to `bridges/<name>/chat_inbox/` and the `ws-chat-inbox` hook wakes an agent to reply.
- **MCP via tunnel** (`src/core/mcp/mcpHttpTransport.ts`, `src/core/mcp/superagentMcpServer.ts`, and `src/core/mcp/tools/remoteAgent*.ts`): `/muse tunnel start --mcp` serves MCP over Streamable HTTP on loopback through Cloudflare Tunnel. MCP HTTP and the Muse WebSocket tunnel are separate transports. Use the live `tools/list` result as the source of truth; do not hardcode exposed tool counts. Safe tools are exposed by default; dangerous operations require explicit opt-in. Calls are audit-logged. See `README.md`, `docs/mcp/muse-chat-workflows.md`, and `docs/wiki/03-api-and-contracts.md`.
- **Bridge kit** (`bridge/`): sanitized publishable copy of the Muse-side WS bridge (`listener.py`, `bridge.sh`, `hooks/`, `bridges.json.example`, `SETUP.md`). Keep in sync with the live instance (`~/workspace/ws-bridge/` on the Muse machine) — never copy it raw, it contains real URLs/tokens.

## Coding Guidelines & Constraints
- **Language — English Only**: All user-facing text strings, UI labels, log messages, comments, variable names, documentation, and any other text content MUST be written in English. No exceptions.
- **Shell Commands**: On Windows, the actual shell is auto-detected (Git Bash is preferred over PowerShell). If using PowerShell, use `;` to separate commands instead of `&&`. Git Bash supports `&&` normally. The system prompt reports the detected shell accurately.
- **Strict Naming Rules**: Do NOT mention proprietary brand names like "Claude Code" or generic "CLI" terms in user-facing documentation or UI descriptions. Refer to the project as a terminal-based AI coding assistant.
- **Workspace Isolation & Database**: Session history, metadata, and cross-session search are indexed using SQLite (`~/.superagent-r/history.db` via `src/core/storage/historyDb.ts`). **SQLite is the single source of truth for chat transcripts** — messages are stored in the `messages` table with FTS5 full-text search. Artifacts (plans, tasks, walkthroughs) are stored in `~/.superagent-r/history/<mode>/<sessionId>/`. Superagent worktrees are stored under `~/.superagent-r/worktrees/<name>`. Configuration (`model-config.json`) and logs (`superagent.log`) remain in `~/.superagent-r/`.
  - **IMPORTANT**: The `.json` file at `~/.superagent-r/history/<mode>/<sessionId>/sess_*.json` is **NOT** a transcript storage file. It is a **0-byte placeholder** — its filePath is used only as a session key/identifier and for deriving plan/task/walkthrough file paths. **Do NOT read or write transcript data to/from the JSON file.** Always use SQLite (`loadSessionFromDb()` / `saveSessionToDb()` from `src/core/storage/historyDb.ts`) for chat transcript operations.
- **Model Config & Credentials — JSON ONLY, NO process.env**: All provider credentials, model configurations, active presets, tier models, profiles, and system settings are stored exclusively in `~/.superagent-r/model-config.json`. There is **NO** use of `process.env` for model, provider, or settings data anywhere in production code. This is a hard rule with NO exceptions:
  - **Reading models**: Use helper functions from `src/core/config/providers.ts`:
    - `getEffectiveMasterModel(mode)` — returns the primary model name for the given mode (`"multi"`, `"single"`, or `"auto"`)
    - `getTierModel(mode, tier)` — returns a specific tier's model (`tier`: `"master"`, `"superagent"`, `"subagent"`, `"researcher"`, `"coder"`, `"reviewer"`, or any custom subagent name)
    - `getAllTierModels(mode)` — returns a `Record<string, string>` of all tier models including subagent details
  - **Writing models**: Use helper functions from `src/core/config/providers.ts`:
    - `setTierModel(mode, tier, modelName, providerProfileId?)` — writes a specific tier's model to JSON and persists
    - `setAllTierModels(mode, modelName, providerProfileId?)` — writes ALL tiers at once to JSON and persists
    - `clearTierModel(mode, tier)` — clears a tier's model override
  - **Provider info**: Use `getActiveProviderName()` and `getConfiguredProviders()` — both read from JSON, never from env vars.
  - **System settings** (concurrency, rate limit, streaming, context window, max iterations): Use `getSettings()` to read and `updateSettings()` to write — both from `src/core/config/jsonConfig.ts`. These functions read/write directly to `model-config.json`. **NEVER use `process.env` to read or write settings.**
  - `/login` (add provider wizard): use `addProvider()` to save to JSON, then `switchActiveProvider()` to activate.
  - `/model` (model/preset wizard): use `savePreset()`, `applyModelPreset()`, `setTierModel()`, `setAllTierModels()` — all JSON.
  - `/settings` (settings commands): use `getSettings()` to display and `updateSettings()` to persist — all JSON.
  - **NEVER read or write `process.env.MODEL`, `process.env.MODEL_*`, `process.env.ACTIVE_PROVIDER`, `process.env.ANTHROPIC_API_KEY`, `process.env.CUSTOM_BASE_URL`, `process.env.OPENAI_API_KEY`, `process.env.SUPERAGENT_MAX_CONCURRENCY`, `process.env.SUPERAGENT_RATE_LIMIT_*`, `process.env.DISABLE_STREAMING`, `process.env.CONTEXT_WINDOW_LIMIT`, or `process.env.MAX_ITERATIONS`** — all of these have been fully migrated to JSON config helpers (`getSettings()`, `getTierModel()`, `getConfiguredProviders()`, etc.).
  - **`updateEnvFile()` has been removed** — it no longer exists. The file `src/core/config/env.ts` has been deleted. All config flows through `jsonConfig.ts` functions.
- **Interactive Prompts**: Ensure any executed shell command processes are monitored for interactive inputs (such as asking for yes/no confirmation) to alert the user rather than hanging in the background.
- **Test Location**: Always create and place all test files inside the `tests/` directory at the project root. Do not place test files under the `src/` directory.
- **Circular Dependency Prevention**: `toolsets.ts` and `prompts.ts` are imported by multiple tool files. Any tool file that needs to import from `toolsets.ts` or `prompts.ts` MUST use dynamic `import()` inside the `execute()` function body — never a top-level static import — to avoid circular module dependency errors.
- **Tier Enforcement**: Do NOT add orchestration tools (e.g., `invokeSubagentTool`) to Superagent or Subagent toolsets. Each tier must only have the tools listed in `toolsets.ts` for that tier.
- **Master Agent Planning**: The Master Agent is restricted from directly modifying codebase files and MUST delegate all feature implementation to Superagents. Therefore, the Master Agent's Implementation Plan and Task Tracking files MUST explicitly focus on spawning, monitoring, and merging Superagents (specifying their roles, git branches, and feature tasks) rather than detailing direct file edits as if it were performing them itself.
- **Commit, Versioning, and Changelog**: Every change, task, or completed feature must be staged and committed to the git repository. You must also bump the package version in `package.json` and document the changes in `CHANGELOG.md`.
- **Code Limits & Architecture**: Keep all code files strictly under 1000 lines to ensure readability. Always design with a single source of truth, focus on modularity, maintainability, scalability, optimization, and strictly adhere to industry best practices.
- **Best Practices, Maintainability, Scalability, and Modularity**: Follow industry best practices. Design codebase changes to be maintainable, scalable, and modular. Maintain separation of concerns, maximize code reuse, eliminate duplication, and document code effectively.
- **Exploration & Research**: When performing codebase exploration, investigation, or research, always spawn a subagent to handle the task.
- **Mandatory Skill Reading**: At the very start of the workflow to solve any user request (such as debugging, testing, QA, refactoring, new feature development, or any other task supported by our comprehensive skills), you MUST identify all relevant skills and read their `SKILL.md` instructions using the `view_file` tool before making plans or taking action.
- **Terminal Preset Names**: When creating or setting up terminal presets (e.g. via `/terminal init` or by writing to `terminal-presets.json`), preset names (keys in the JSON configuration) MUST be short, simple, lowercase, alphanumeric characters, and may use hyphens or underscores (e.g., `'dev'`, `'build'`, `'start'`, `'test'`). Emojis are strictly prohibited in preset names to ensure they are easy for users to type in the terminal when running `/terminal <preset_name>` or `/terminal preset <preset_name>`.
- **Chrome Extension Styling (chrome-extension/)**: The sidepanel GUI in `chrome-extension/` MUST adhere strictly to a clean, premium Material-inspired Design style (similar to modern cloud consoles) with light and dark theme options. This includes using modern styling: light theme with clean cool white/grey backgrounds (#ffffff, #f0f4f9, #f8f9fa), dark theme with dark grey/charcoal backgrounds (#1e1f20, #0f0f0f, #2d2f31), clean Material blue buttons/accents (#1a73e8 or #0b57d0 in light mode, #8ab4f8 or #a8c7fa in dark mode), Outfit or Product Sans/Roboto typography for UI elements (fallback to Inter/Segoe UI), and JetBrains Mono/Roboto Mono for terminal or code outputs. Interactive elements must use soft box-shadows, modern flat styles, and generous rounded corners (typically 8px to 16px, or rounded pills for buttons) to achieve a modern, premium look.
- **Startup Optimization & Fast-Path**: Startup time must remain sub-second. Binary checks must be cached using `systemCache.ts` (`getSystemCheckCache()` / `updateSystemCheckCache()`). Heavy native imports (e.g. `r-memory`, ONNX runtime, transformers) MUST NOT be loaded on the critical startup path; use lightweight disk package resolution (`createRequire`) and warm up ML models asynchronously in the background. Interactive startup progress UI is bypassed for one-shot prompts or when `--quick` / `-q` is provided.
- **Project Completion Conclusion**: System prompts across all tiers and configurations MUST mandate a structured completion conclusion whenever completing a project, feature, or multi-step task. The conclusion must summarize final outcomes, key implementation highlights, verification status, and next steps before listing changed files.

## System Prompt Guidelines (Concept A, B, and C)
All system prompts in the codebase (e.g., in [prompts.ts](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/src/core/prompts.ts)) must be designed and optimized using the following guidelines:
- **Concept A: Telegraphic English (Minified Prose)**
  - Remove conversational filler, pronouns, polite phrasing, and redundant verbs.
  - Use brief, direct imperative statements.
- **Concept B: Markdown Structure**
  - Organize rules, context, workflows, and rules under clear Markdown headers (e.g., `# ROLE`, `# CRITICAL RULES`, `# WORKFLOW`).
  - Use bullet points and lists to establish a clean hierarchy.
- **Concept C: Pseudocode & Logic Gates**
  - Structure conditional flows, decision gates, or self-verification routines using programming-like logic statements (e.g., `if decision_point: CALL ask_question()`).
  - Avoid verbose natural language paragraphs for branching paths.

## Operational Notes

- **Restart `/muse watch` after code changes**: the watch-mode process keeps old modules loaded; code delivered via the bridge only takes effect after the user Ctrl+C's and re-runs `/muse watch`. Never claim a feature is live before this restart plus a live probe.
- **`get_active_browser_tabs` can hang**: if the Chrome extension bridge is not connected, the tool has no effective timeout and blocks the entire sequential batch queue (observed 5+ min). Always check `chrome_extension_status` first; never send other batches until it returns.
- **MUSEBUS chunking**: wire format of the Telegram bridge. The WS transport gained reassembly in v1.5.148, but for WS just send plain JSON (16 MB limit — chunking not needed).
- **Network-exposed mode security checklist** (MCP via tunnel, and any future mode): (1) separate credential per mode (crypto-random, transient, never reused); (2) allowlist default-deny, destructive tools opt-in only; (3) audit-log every call; (4) bind 127.0.0.1, only the tunnel faces the network; (5) treat tunnel URLs as public, security from the credential, not obscurity.
- **MCP tool registry is the source of truth**: define tool schemas and permission classifications in the MCP registry/modules, keep disabled-tool filtering aligned with actual exposure, and derive counts from the exposed list rather than constants. Remote Muse tools live in `remoteAgentTunnelMcpTools.ts`, `remoteAgentTelegramMcpTools.ts`, and `remoteAgentChatMcpTools.ts`; keep `remoteAgentMcpTools.ts` as the aggregator/dispatcher.
- **Wiki maintenance**: after architecture, MCP contract, or workflow changes, update the relevant `docs/wiki/*.md` pages, then run `bun run wiki:sync` and `bun run wiki:validate`. Review the sync manifest and index log; do not claim wiki freshness if the scripts fail.

## Verification Checklist
- Run `bun test` to verify that all unit tests pass before committing.
- Build the project using `bun run build` to verify there are no TypeScript compilation errors.
- **Build After Changes**: Always run `bun run build` immediately after making any changes to the source files to ensure the compiled outputs in `dist/` are up to date and there are no compilation errors.
- After adding new tools, verify they are added to the correct tier toolset in `toolsets.ts` and not to other tiers.
- After modifying `subagentTools.ts` or `superagentTools.ts`, check for circular dependency issues — imports of `toolsets.ts`/`prompts.ts` must be dynamic.

- **Chrome debug launcher** (`scripts/chrome-debug.bat`): Windows launcher that opens Chrome with `--remote-debugging-port=9222` for extension-free CDP automation via `control_chrome_cdp`. Warns (does not kill) if Chrome is already running. **Chrome singleton limitation**: the flag is silently ignored when any Chrome window is already running from the same user-data-dir — the browser must be fully closed first. Debug port is 127.0.0.1-only.
- **UI-DETR-1 Vision Service & Set-of-Mark (SoM) Engine** (`scripts/vision_server.py`): Local AI (RF-DETR Medium ~535MB) for vision-based UI automation via `control_chrome_vision` (port 8095) and Chrome Extension Vision panel (`/api/browser/detect-ui`). **Auto-started by the tool on demand** — spawns `python scripts/vision_server.py 8095` as a background process and polls `/health`. Fast single-pass detection for button, field, link, text, heading, etc. Service binds 127.0.0.1 only. Model weights cached automatically via HuggingFace Hub (`~/.cache/huggingface/hub/models--racineai--UI-DETR-1`). Powers Set-of-Mark perception (`perceive_page`), direct coordinate interaction (`click_id`, `type_id`), automated layout auditing (`audit_layout`), and before/after visual diff validation (`verify_visual_state`). Legacy OmniParser has been completely removed in favor of this single lightweight model.
