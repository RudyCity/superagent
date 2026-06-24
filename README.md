# Superagent 🚀

Superagent is an interactive, terminal-based AI coding assistant designed to facilitate the cycle of development, testing, debugging, and application optimization directly from your workspace.

It features a cyberpunk-styled terminal user interface built with terminal UI components, automatic tracking of model context token limits, a robust security permission layer, a **3-tier multi-agent orchestration system** (Master Agent → Superagent → Subagent), and persistent integration with local terminal shells.

![Superagent Cyberpunk Terminal UI](assets/Video_SuperAgent.gif)

---

## 📖 Background

In modern software development, developers frequently switch context between writing code, running terminal commands, inspecting system logs, searching documentation, and interacting with Large Language Models (LLMs).

Superagent bridges this gap by providing an integrated terminal environment that understands your project's context automatically using a project specification file (`agents.md`), automates execution of independent tasks through secondary agents (*subagents*), and tracks LLM context window limits in real-time. Security is a primary design goal: every file modification, tool invocation, and shell command execution requires explicit user authorization.

---

## 💎 Unique Advantages

Unlike standard headless execution bots or basic shell wrappers, Superagent is designed from the ground up as a fully interactive developer workspace companion:

- **Real-Time Context Window Tracking & Intelligent Compacting**: Traditional assistants run blind to token consumption. Superagent features a continuous visual dashboard tracking prompt tokens, completion costs, and remaining context windows, powered by a modular **Context Manager** with model-specific tokenizers (OpenAI/Anthropic). When the context grows too large, automatic compaction kicks in using pluggable strategies — truncation, LLM-powered summarization, or semantic-aware scoring. Use `/compact now` to force compaction on demand, `/pin` to protect important messages from being compacted, and `/compaction-history` to audit all compaction events.
- **Global Pinned Knowledge Store**: Pinned messages are automatically stored in a persistent, cross-session knowledge base. Use `/knowledge` to browse and search pinned knowledge across ALL sessions and projects. AI agents can access this via `search_pinned_knowledge` and `load_pinned_session` tools, enabling them to learn from previous sessions' decisions and context.
- **Granular Session Checkpoints**: Never lose progress. Superagent lets you snapshot your conversational and code states into checkpoints (via `/checkpoint`). If an experimental approach fails, you can revert back instantly to a previous checkpoint, restoring the entire session timeline.
- **3-Tier Multi-Agent Orchestration**: Instead of doing all work sequentially under a single LLM thread, Superagent supports a full 3-tier agent hierarchy. A **Master Agent** orchestrates one or more **Superagents**, each isolated in their own git worktree for independent feature development. Superagents can further delegate atomic operations to ephemeral **Subagents**. It adopts explicit multi-stage planning, structured delegation with constraints and acceptance criteria, and automated self-verification. Launch with `superagent --multi`.
- **Pre-Merge Auto-Debugging Loop**: Ensures code quality at merge boundaries. Before any Superagent task is merged, a verification script runs builds and tests. If a failure occurs, the Master Agent triggers an auto-debugging loop (up to 3 retries), prompting the Superagent to analyze the logs, implement a fix, and verify it dynamically.
- **Visible, Non-Headless Interactive Terminals**: Most agents run shell commands in the background without visibility or interactivity. With `/terminal`, Superagent spawns a real, popped-up host emulator terminal window. This is perfect for running interactive servers, watch scripts, and commands that require manual inputs.
- **Global Config & Repository Hygiene**: No messy `.env` or log files cluttering your project codebase. All API keys, environment settings, and session logs are kept safe and clean in your user's global directory (`~/.superagent-r/`).
- **Smart Workspace Discovery & Automatic Directory Trust**: Automatically fingerprints and hashes the workspace files and structure on startup, caching results under `~/.superagent-r/workspace-caches/` to bypass redundant scans. It dynamically monitors and updates the cache when workspace changes occur in the agent loop. Additionally, git worktree directories created for Superagents (`~/.superagent-r/worktrees/<name>`) are automatically configured as trusted (`safe.directory`) in git to prevent "dubious ownership" warnings and errors.
- **FastContext AI-Powered Repo Explorer**: Powered by [Microsoft's FastContext](https://github.com/microsoft/fastcontext), Superagent delegates broad codebase exploration to a dedicated, read-only sub-agent that uses parallel Read/Glob/Grep tool calls with multi-step reasoning to return compact file-line citations — keeping the main agent's context window clean and focused.
- **Automatic Checkpointing**: In addition to manual checkpoints, Superagent automatically snapshots your session on every user message and before any destructive tool operation (file writes, deletions, etc.), with a built-in cooldown to avoid excessive snapshots. You always have a safe rollback point without lifting a finger.
- **Mandatory Interactive Decision Points**: All agent tiers (Master, Superagent, Subagent) are required to use the `ask_question` tool at every decision point — choosing implementations, resolving ambiguity, or selecting approaches — ensuring the AI never guesses or assumes on the user's behalf.
- **AI-Guided Preset Initialization**: Configure your workspace commands effortlessly. Superagent scans your codebase structure (such as dependencies, packages, and scripts) to automatically recommend, select, and construct terminal command presets with the `/terminal init` wizard.

---

## 🛠️ Tech Stack & Architecture

Superagent is built on modern Node.js technologies for high performance and modular architecture:

- **Language**: TypeScript (ES Modules)
- **Runtime**: Node.js (v18+)
- **User Interface**: [Ink](https://github.com/vadimdemedes/ink) (React for the terminal) for a highly interactive, responsive visual layout.
- **LLM Integration**: [Vercel AI SDK](https://sdk.vercel.ai/) (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`) for structured and streaming interactions.
- **Process Execution**: [Execa](https://github.com/sindresorhus/execa) for reliable control of background and external processes.
- **Testing**: [Vitest](https://vitest.dev/) for fast and reliable unit testing.

### Directory Structure

```
superagent/
├── src/
│   ├── cli.tsx                    # Main entrypoint; routes --multi flag to masterAgent
│   ├── app.tsx                    # React UI wrapper and command handling logic
│   ├── core/
│   │   ├── agent.ts               # Core cognitive loop and instruction runner
│   │   ├── masterAgent.ts         # Master Agent orchestrator (3-tier entry point)
│   │   ├── config.ts              # Environment variable and global config management
│   │   ├── checkpoints.ts         # Conversation state checkpoint save/load logic
│   │   ├── fastcontextSetup.ts    # Auto-detect and install FastContext on startup
│   │   ├── slash-commands.ts      # Interactive command definitions
│   │   └── tools/
│   │       ├── types.ts           # Shared types: AgentTier, SubagentInstance, ToolSet
│   │       ├── toolsets.ts        # ToolSet definitions per tier (master/super/sub)
│   │       ├── prompts.ts         # System prompts per tier with dynamic context
│   │       ├── state.ts           # Shared subagent registry and event emitters
│   │       ├── shellTools.ts      # Command execution and background task control
│   │       ├── systemTools.ts     # File operations, directory creation, port checks
│   │       ├── subagentTools.ts   # Subagent instantiation (superagent tier)
│   │       ├── superagentTools.ts # Superagent orchestration tools (master tier)
│   │       ├── fastcontextTool.ts # FastContext AI-powered repo explorer tool
│   │       ├── fastcontext_runner.py # Python wrapper for FastContext CLI
│   │       └── networkTools.ts    # Web content fetch and browser integration
│   └── components/                # React Ink components (visual stats, wizards)
├── vendor/
│   └── fastcontext/               # Vendored Microsoft FastContext source
├── bin/                           # Portable Python and setup scripts
├── tests/                         # Unit test suites using Vitest
└── package.json                   # Project manifest and scripts
```

---

## 🌟 Key Developer Features

### 1. Cyberpunk Terminal UI, Token Tracking & Model Speed
A rich terminal interface showing live statistics on active prompt sizes, completion token counts, token cost summaries, active models, remaining context windows, and real-time model generation speed (tokens per second).

### 2. Session Management & Checkpoints
Allows developers to save the current state of a coding conversation and restore it at any point using `/checkpoint save <name>` and `/checkpoint restore <id>`. This allows you to safely experiment with different implementations. Checkpoints can be browsed, restored, or deleted via an interactive wizard (launched by `/checkpoint`, `/checkpoint list`, or `Ctrl+P` in multi-agent mode). Use the `--resume` or `-r` flag to continue where you left off. Multi-agent sessions are fully serialized, ensuring smooth restore and resume of running tasks and interactive prompts. **Auto-checkpointing** creates snapshots automatically on every user message and before destructive tool operations, with a cooldown to prevent excessive saves — ensuring you always have a safe rollback point.

### 3. 3-Tier Multi-Agent Orchestration (`--multi`)
Launch with `superagent --multi` to activate the full 3-tier hierarchy:

```
superagent --multi
      │
  Master Agent  (orchestrator tier)
  Tools: invoke_superagent, await_superagents, merge_superagents, manage_superagents, define_superagent, send_message_to_superagent, manage_subagents, git_worktree
  Spawns Superagents with git worktree isolation
      │
  Superagent  (per-feature coordinator/lead)
  Tools: shell + file tools, invoke_subagent, manage_subagents, git_worktree
  Isolated in its own git worktree
  Can spawn Subagents for atomic ops
      │
  Subagent  (atomic operation tier)
  Tools: file tools only (read/write/search)
  Ephemeral, single-purpose execution
```

**Tier Responsibilities:**
- **Master Agent**: High-level planning, task decomposition, and result merging. Manages which Superagents are running, lets you dynamically define custom Superagent roles/prompts, and allows sending interactive messages/instructions to active Superagents.
- **Superagent**: Feature coordination and development in an isolated git worktree. Responsible for leading implementation and delegating atomic operations (research, coding, testing) to specialized Subagents.
- **Subagent**: Atomic file/search operations delegated by a Superagent. Ephemeral — lives only for the duration of a single task.

**Advanced Orchestration Features:**
- **Pre-Merge Auto-Debugging Loop**: Before merging changes from any Superagent branch, a verification phase runs builds and test suites in the worktree. If errors are encountered, an automatic feedback loop triggers (up to 3 retries) that sends the failure output to the Superagent, instructing it to automatically debug, fix, and commit updates before completing the task.
- **ASCII Dependency Graph**: The dashboard's active agents registry panel draws a real-time, hierarchical ASCII tree (using `├──` and `└──` connectors) mapping active relationships between the Master Agent, spawned Superagents, and running subagents/tasks.
- **Illegal Operation Reporting & Auto-Escalation**: When a child agent attempts a blocked operation (e.g., unauthorized file modification, scope creep, or policy violation), a structured `ViolationRecord` event is emitted with severity levels (`warning` or `critical`). These violations automatically propagate up the agent hierarchy (Subagent → Superagent → Master Agent), enabling parent agents to track, log, and take corrective action — including halting or redirecting the offending agent.
- **Mandatory Interactive Decision Points**: All tiers enforce the use of the `ask_question` tool at every decision point. Agents must present multiple-choice options to the user rather than guessing, assuming, or making unilateral decisions about implementation approaches, file selections, or design trade-offs.

**Standard subagent roles (single-agent mode):**
- **Researcher**: Explores the codebase and retrieves context (Read-Only).
- **Coder**: Implements code modifications and refactoring.
- **Reviewer**: Audits changes, runs tests, and validates implementations.
- **manual-tester**: Automated browser testing (Playwright), browser log/error analysis, and visual UI/UX design taste checks.

### 4. Visible Terminal Windows (`/terminal`)
Runs development servers, local builds, or test watchers in popped-up, visible OS terminal windows (Windows cmd, macOS Terminal, Linux x-terminal). It includes an AI-assisted preset initializer (`/terminal init`) to auto-configure workspace command presets.

### 5. Structured Planning & Approvals
For complex changes, the Master Agent enforces structured planning and execution boundaries:
- **Explicit Multi-Stage Planning**: The implementation plan is structured into three mandatory stages: **Stage 1: Discovery & Dependency Mapping** (dependency tracing), **Stage 2: Interface & Contract Definition** (API/types specification), and **Stage 3: Spawning Roadmap** (Superagent spawning checklist and branch topology).
- **Structured Delegation**: When invoking a Superagent, the Master Agent specifies explicit task `constraints` (files or logic NOT to modify) and `acceptanceCriteria` (a checklist of specific test cases to satisfy).
- **Approval Checkpoint**: The plan is written to the workspace root as `implementation_plan.md` and requires explicit user review and approval before any execution begins, guaranteeing complete oversight.

### 6. Safe Merge Strategy (v2)
The merge system uses a **safe-by-default** strategy that prevents file corruption:
- **Line-Based Conflict Resolution**: When conflicts occur, the system first attempts safe line-based resolution (e.g., one side is empty, both sides identical, or one side is a subset). Only trivially safe conflicts are auto-resolved.
- **Universal Post-Merge Validation**: After a clean merge (or successful line-based resolution), the system runs validation checks:
  - Conflict marker detection (leftover `<<<<<<<` in files)
  - Duplicate adjacent lines detection
  - Duplicate attributes detection
  - Line merging detection (multiple statements crammed onto one line)
  - Diff sanity check (abnormally large diffs)
  - Project-level validation (build/test/lint scripts)
- **Auto-Revert on Failure**: If validation fails, the merge is automatically reverted before committing. No corrupted files are ever committed.
- **Manual Resolution Required**: Complex conflicts that cannot be safely resolved are aborted and reported to the user for manual resolution.

### 7. Advanced Superagent Modes
- **Patch Mode** (`mode: 'patch'`): Lightweight mode that skips worktree creation and operates directly in the parent's working directory. Ideal for small, targeted fixes (1-2 lines). Much faster than spawning a full Superagent. Includes safety warnings if the parent worktree has uncommitted changes.
- **Base Branch** (`baseBranch: 'feat/...'`): When a Superagent needs to build on top of another feature branch instead of the current HEAD, specify `baseBranch` to create the worktree from that branch. Useful for dependent features or building on top of in-progress work.

Example:
```
invoke_superagent({
  role: 'fix-html-corrupt',
  task: 'Fix duplicate closing tags in Toolbar component',
  branch: 'fix/toolbar-html',
  baseBranch: 'feat/separate-compressor-menu',  // Build on top of this branch
  mode: 'patch'  // Quick fix, no worktree needed
})
```

### 8. Centralized Logging
All agent operations, including single-agent and 3-tier multi-agent processes, are dynamically logged to a central log file in the user's home directory (`~/.superagent-r/superagent.log`). The log maintains tier-aware indentation to cleanly trace parallel execution branches.

### 9. FastContext AI-Powered Repository Explorer
Integrated across all agent tiers, Superagent wraps [Microsoft's FastContext](https://github.com/microsoft/fastcontext) as a dedicated read-only codebase exploration tool. Instead of spending the main agent's context window on broad file reads and grep chains, the agent delegates natural-language exploration queries to FastContext, which:

- **Explores autonomously** with Read, Glob, and Grep tools using multi-step reasoning and parallel tool calls.
- **Returns compact evidence** as `<final_answer>` blocks containing precise file-path and line-range citations.
- **Streams progress** to the centralized master log with structured JSONL events (thinking, tool calls, dedup, retries, results, errors, and completion summaries).
- **Resolves credentials** from the researcher tier model configuration (configurable via `/model`), falling back to subagent or active tier settings.
- **Runs in a portable Python environment** (`bin/python/`) with vendored FastContext source (`vendor/fastcontext/`), requiring zero system-level Python dependencies.

Usage example from within an agent session:
```
fastcontext({
  query: "Find the files that implement authentication and explain where to make a change",
  maxTurns: 6,
  citation: true
})
```

### 10. Automatic Checkpointing
Beyond manual `/checkpoint` commands, Superagent creates checkpoints automatically:
- **On every user message**: A snapshot is taken before processing each new user input, preserving the state prior to the agent's response.
- **Before destructive operations**: File writes, deletions, and other state-modifying tool calls trigger a checkpoint before execution.
- **Cooldown-based**: A configurable minimum interval between auto-checkpoints prevents excessive snapshots during rapid interactions.
- **Non-blocking**: Auto-checkpoints run asynchronously in the background and never interrupt the conversation flow. A visible notification appears in the terminal UI when one is created.

### 11. Illegal Operation Reporting & Auto-Escalation
In multi-agent mode, the permission layer emits structured `ViolationRecord` events whenever a child agent attempts a blocked operation. These violations include:
- **Severity levels**: `"warning"` for soft blocks (e.g., scope creep attempts) and `"critical"` for hard policy violations (e.g., unauthorized file modifications).
- **Automatic propagation**: Violation events bubble up from Subagents → Superagents → Master Agent, allowing the parent agent to track, log, and take corrective action.
- **Structured metadata**: Each violation records the timestamp, tool name, reason code, description, and optional context (file path, command, worktree).

---

## 🔬 Deep Dive: System Architecture & Core Logic

Superagent features several robust subsystems that ensure stability, execution safety, and a seamless developer workflow:

### 1. Active Host Diagnostics & Auto-Dependency Setup (`androidSetup.ts`)
Superagent proactively audits and prepares your local machine's developer environment:
- **Automatic Utility Provisioning**: If `ripgrep` (`rg` for high-speed workspace indexing) or `curl` (on Windows) is missing on your host machine, Superagent automatically downloads, extracts, and places the binaries locally in `~/.superagent-r/bin/`.
- **Android CLI Orchestrator**: Scans and provisions Google's official Android SDK command-line utilities using custom PowerShell (`install.cmd` for Windows) and Shell (`install.sh` for macOS/Linux) scripts.

### 2. 3-Tier Multi-Agent Architecture (`masterAgent.ts`, `superagentTools.ts`, `subagentTools.ts`)
For parallel feature development, Superagent implements a 3-tier hierarchy:
- **Tier Isolation**: Each Superagent runs in an isolated git worktree (`~/.superagent-r/worktrees/<name>`), preventing file conflicts between concurrent agents.
- **Instant Dependency Linking**: To speed up execution, spawning a Superagent automatically links the root `node_modules` into the worktree using platform-specific symlinks (or directory junctions on Windows) instead of re-installing dependencies.
- **Delegation Guardrails**: Delegation depth is enforced per-tier — Master can spawn Superagents, Superagents can spawn Subagents, Subagents cannot spawn further agents.
- **Permission Scoping**: Each tier gets a strictly scoped toolset. Master agents get orchestration, definition, and messaging tools; Superagents get shell + file tools; Subagents get file tools only.
- **Dynamic Custom Roles**: Master Agent can define customized Superagent types/roles dynamically using `define_superagent` with custom system prompts, enabling domain-specific behaviors.
- **Interactive Messaging & Routing**: Master Agent can send follow-up instructions and questions to active Superagents via `send_message_to_superagent`, permitting real-time collaboration. Multi-agent sessions are fully serialized, allowing dynamic resumption and routing of paused instances.
- **Robust Worktree Cleanup**: Terminating or killing Superagents (via `manage_superagents` with `kill` or `kill_all` actions) robustly cleans up and removes their corresponding Git worktrees, avoiding disk clutter.
- **Structured Markdown Reporting**: Every Superagent completes its task by printing a standardized markdown report (goal, actions taken, key findings, outcome status) that the Master Agent can parse and merge.
- **Concurrent Task Isolation**: Uses `agentLocalStorage` to track and isolate concurrent task logging paths, preventing environment variable clashes during parallel execution.
- **Visual Log Streaming & Centralized Logging**: Agent actions, thoughts, tool calls, and execution errors are formatted and logged in a nested visual tree layout with tier-aware indentation. All logs are dynamically captured and written to the global directory at `~/.superagent-r/superagent.log`.

### 3. Execution Safety Guardrails (`permissions.ts`)
A dedicated validation layer inspects all terminal execution commands before they are executed. It immediately blocks destructive command invocations, including:
- Directory wipes on root/home directories (`rm -rf /`, `rmdir /s /q C:\`, etc.)
- Disk formatting/initialization commands (`Format-Volume`, `Initialize-Disk`, `mkfs`)
- System power commands (`shutdown`, `reboot`, `Stop-Computer`)
- Force process termination on critical system tasks
- Unverified remote script pipes (`curl/wget | sh`, `Invoke-Expression/iex`)

### 4. Background Job Scheduling & Timers (`schedule`)
Superagent implements a background scheduler supporting:
- **Active Waiting**: Synchronous waiting (`wait: true`) showing a real-time countdown indicator directly on the stdout terminal.
- **Asynchronous Timers**: One-shot background reminders and recurring interval cron checks (e.g., `5m` or `1h`).
- **Full Abort Signal Propagation**: Timers immediately clean up processes and interval hooks upon getting a cancel or abort event from the agent core.

### 5. FastContext Auto-Provisioning (`fastcontextSetup.ts`)
On startup, Superagent checks whether the portable Python environment and vendored FastContext source are ready:
- **Auto-Detection**: `isFastContextReady()` checks for the presence of the project-local Python binary (`bin/python/`).
- **First-Time Setup**: If missing, a platform-specific setup script (`bin/setup-fastcontext.ps1` or `bin/setup-fastcontext.sh`) runs automatically, provisioning Python 3.12 and installing FastContext dependencies.
- **Graceful Degradation**: If setup fails, a clear warning is printed and the `fastcontext` tool reports its unavailability — all other agent functionality continues normally.

### 6. Auto-Checkpoint Engine
Built into the core agent loop (`agent.ts`), the auto-checkpoint system:
- **Triggers on user messages**: A snapshot is taken before the agent processes each new user input.
- **Triggers before destructive tools**: File writes, deletions, and other mutating tool calls create a checkpoint before execution begins.
- **Cooldown mechanism**: A minimum time interval (`AUTO_CHECKPOINT_COOLDOWN_MS`) prevents excessive checkpoint creation during rapid interactions.
- **Non-blocking**: Runs asynchronously and swallows errors — never interrupts the conversation flow. A visible notification event (`checkpoint_auto`) appears in the terminal UI.

### 7. Atomic Config Persistence
Model configuration (`model-config.json`) uses atomic write operations to prevent file corruption. If the process is interrupted (e.g., Ctrl+C), the config file remains intact — writes are first written to a temporary file and then atomically renamed, ensuring zero risk of partial/corrupt state.

---

## 🚀 Getting Started & Configuration

### Prerequisites
- **Node.js** v18+
- **npm** (or your preferred package manager)

### Installation

1. Clone and navigate into the repository:
   ```bash
   git clone <repository-url>
   cd superagent
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Make Superagent Executable Globally:
   To install the `superagent` command globally on your system so you can invoke it from any directory, build the project and run `npm link`:
   ```bash
   npm run build
   npm link
   ```
   This compiles the TypeScript files to JavaScript and registers a global symlink pointing to your local repository build. Now, you can start the assistant from any directory simply by typing:
   ```bash
   superagent
   ```
   *(To uninstall the global symlink, run `npm unlink` inside this directory).*

4. Configure Global API Credentials:
   Superagent stores all configuration — provider credentials, model settings, rate limits, and system settings — in a centralized JSON config file at `~/.superagent-r/model-config.json`. The easiest way to configure everything is through the interactive slash commands:
   ```
   superagent
   # Then inside the terminal UI:
   /login     # Add API keys and configure providers
   /model     # Set active AI models per tier
   /settings  # Configure rate limits, concurrency, streaming, etc.
   ```
   Alternatively, you can create a `.env` file in `~/.superagent-r/` for optional runtime overrides:
    ```env
    # Global model override (format: "provider:model" or just "model")
    # MODEL=openai:gpt-4o

    # Enable multi-agent mode via flag (or set SUPERAGENT_MULTI=true)
    # SUPERAGENT_MULTI=false
    ```

### 🔑 Multi-API Key & Model Management
Superagent natively supports configuring multiple API providers concurrently. All provider profiles, API keys, and model settings are stored in `~/.superagent-r/model-config.json` and managed through slash commands:
- `/login` — Add or update provider profiles with API keys.
- `/model` — Set active models per agent tier (Master, Superagent, Subagent).
- `/settings` — Configure rate limits, concurrency, streaming, context window, and max iterations.

Custom providers (e.g., self-hosted Claude API proxies, Ollama, vLLM) are supported via `/login custom <base_url> <key>`. Anthropic-compatible endpoints are automatically detected and run with the Anthropic driver.

To dynamically switch your active API provider or model at runtime, use the `/login` or `/model` slash commands. Changes take effect immediately without restarting the assistant.

---

## ⚙️ Development Scripts

Run the following NPM scripts during development:

- **Start Development Mode**:
  ```bash
  npm run dev
  ```
- **Start Multi-Agent Mode (3-tier orchestration)**:
  ```bash
  npm run dev -- --multi
  # or globally:
  superagent --multi
  ```
- **Resume Last Session**:
  ```bash
  npm run dev -- --resume
  # or
  npm run dev -- -r
  ```
- **Compile TypeScript**:
  ```bash
  npm run build
  ```
- **Run Production Build**:
  ```bash
  npm start
  ```
- **Run Unit Tests**:
  ```bash
  npm test
  ```

---

## 💬 Interactive Slash Commands

Superagent supports a wide range of slash commands within the terminal chat to manage session state, configure the assistant, and run commands.

### Navigation & Session Control
- **`/new`**: Starts a fresh conversation session. Wipes the chat history, resets agent states, and deletes temporary checkpoints.
- **`/resume`**: Opens an interactive visual wizard listing previous session histories, allowing you to select and resume any past conversation.
- **`/clear`**: Wipes the visual logs and terminal chat screen while maintaining the current conversation history.
- **`/compact`**: Shows the current ContextManager status including compaction count, total tokens saved, current state, and last compaction strategy used.
- **`/compact now`**: Forces manual compaction on demand. Displays tokens before/after, tokens saved, and the strategy used (truncation, summarization, or semantic).
- **`/pin`**: Pin important messages to prevent them from being removed during compaction. Pinned messages store full content, agent tags, and sync to the global knowledge store. Subcommands: `/pin list` (view pinned messages with metadata), `/pin last` (pin the last user message), `/pin unpin <id>` (remove a pin), `/pin view <index>` (view full pinned content), `/pin tag <index> <label>` (tag a pinned message), `/pin list-messages` (show all messages with indexes).
- **`/knowledge`** (alias: **`/k`**): Browse and search the global pinned knowledge store — important messages pinned across ALL sessions and projects. Subcommands: `/knowledge` (list all entries), `/knowledge <query>` (search), `/knowledge projects` (list projects with pins).
- **`/search-history <query>`** (alias: **`/sh`**): Search conversation history. Add `--all` flag to search across ALL sessions and projects (e.g., `/search-history auth login --all`).
- **`/compaction-history`** (alias: **`/ch`**): View the full audit trail of compaction events with timestamps, strategies used, tokens saved, and messages preserved.
- **`/quit`** or **`/exit`**: Safely exits the application.

### State Checkpoints
- **`/checkpoint`** (or **`/checkpoint <name>`**): Saves a snapshot of your current conversation history, active model state, and planning states.
- **`/checkpoint list`** (or **`/checkpoint`** with no args): Opens an interactive wizard listing all saved checkpoints with relative timestamps, message counts, and Git commit tags. From the wizard, you can restore or delete any checkpoint.
- **`/checkpoint restore <id>`**: Restores a checkpoint by its ID. If no ID is provided, opens a pre-filtered restore wizard. Automatically terminates running subagents/tasks and reverts the agent's internal state to the checkpoint.
- **`/checkpoint delete <id>`**: Deletes a specific checkpoint by its ID. If no ID is provided, opens a pre-filtered delete wizard for interactive selection.
- **Auto-Checkpoint Notifications**: When an auto-checkpoint is created (e.g., before destructive operations), a visible system notification appears in the terminal UI.
- **Ctrl+P (Multi-Agent)**: In multi-agent dashboard mode, press `Ctrl+P` to open the interactive checkpoint browser wizard.

### Automation & Tasks
- **`/goal <description>`**: Activates **Goal Mode**. The assistant enters a persistent, autonomous loop (up to 200 iterations) to accomplish the goal (e.g., `/goal write a full suite of unit tests for auth.ts`).
- **`/init`**: Runs a system audit. Checks OS info, Node.js version, Git repository status, active model configuration, and auto-generates the `agents.md` specification file.
- **`/agents`**: Lists all active subagents and details about the preconfigured types (`researcher`, `coder`, `reviewer`).
- **`/processes`** (or **`/procs`**): Displays active background processes managed by the agent, along with a visual progress bar and a checklist parsed from the current `task.md`.

### Terminal & Presets
- **`/terminal <command>`**: Spawns a visible, popped-up terminal window executing the specified command.
- **`/terminal preset <name>`** (or **`/terminal <preset_name>`**): Executes a command preset defined in your `terminal-presets.json` or `.superagent-r/terminal-presets.json`.
- **`/terminal init`**: Launches an interactive, AI-guided wizard that scans your workspace files (like `package.json`, `Cargo.toml`, etc.), suggests relevant run commands, and writes them to `.superagent-r/terminal-presets.json`.

### Skills & Plugins
- **`/skills`**: Displays a visual wizard containing all currently installed automation templates and guidelines.
- **`/install <owner/repo>`**: Installs new automated developer *skills* directly from remote repositories via `npx skills add`.

### Provider & Model Settings
- **`/login`**: Opens a visual wizard to add API credentials, switch active providers, or list configured providers. You can also log in directly via `/login <key>` or `/login custom <base_url> <key>`.
- **`/model <name>`**: Switches the active Large Language Model (e.g., `/model openai/gpt-4o` or `/model google/gemini-2.5-flash`). Running without arguments prints the active model name.

---

## ✍️ Authors & Contributors

Developed and maintained by:
- **Rudy H.** ([GitHub Profile](https://github.com/RudyCity)) - *Creator & Lead Developer*

For guidelines on how to contribute to features and bug fixes, please see [CONTRIBUTING.md](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/CONTRIBUTING.md).

---

## 📄 License

This project is licensed under the **MIT License** - see the [LICENSE](file:///d:/backup%20from%20pc%20asus/Documents%20Development/superagent/LICENSE) file for details.
