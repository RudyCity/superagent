# Superagent 🚀

Superagent is an interactive, terminal-based AI coding assistant designed to facilitate the cycle of development, testing, debugging, and application optimization directly from your workspace.

It features a cyberpunk-styled terminal user interface built with terminal UI components, automatic tracking of model context token limits, a robust security permission layer, multi-agent orchestration (parallel subagents), and persistent integration with local terminal shells.

---

## 📖 Background

In modern software development, developers frequently switch context between writing code, running terminal commands, inspecting system logs, searching documentation, and interacting with Large Language Models (LLMs).

Superagent bridges this gap by providing an integrated terminal environment that understands your project's context automatically using a project specification file (`agents.md`), automates execution of independent tasks through secondary agents (*subagents*), and tracks LLM context window limits in real-time. Security is a primary design goal: every file modification, tool invocation, and shell command execution requires explicit user authorization.

---

## 💎 Unique Advantages

Unlike standard headless execution bots or basic shell wrappers, Superagent is designed from the ground up as a fully interactive developer workspace companion:

- **Real-Time Context Window Tracking & Compacting**: Traditional assistants run blind to token consumption. Superagent features a continuous visual dashboard tracking prompt tokens, completion costs, and remaining context windows. If the context grows too large, the `/compact` command generates an optimized context summary to save API costs.
- **Granular Session Checkpoints**: Never lose progress. Superagent lets you snapshot your conversational and code states into checkpoints (via `/checkpoint`). If an experimental approach fails, you can revert back instantly to a previous checkpoint, restoring the entire session timeline.
- **Parallel Multi-Agent Orchestration**: Instead of doing all work sequentially under a single LLM thread, Superagent spawns specialized background agents (`researcher`, `coder`, `reviewer`) that can run independent tasks (like researching code or running tests) concurrently in isolated workspaces.
- **Visible, Non-Headless Interactive Terminals**: Most agents run shell commands in the background without visibility or interactivity. With `/terminal`, Superagent spawns a real, popped-up host emulator terminal window. This is perfect for running interactive servers, watch scripts, and commands that require manual inputs.
- **Global Config & Repository Hygiene**: No messy `.env` or log files cluttering your project codebase. All API keys, environment settings, and session logs are kept safe and clean in your user's global directory (`~/.superagent-r/`).
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
│   ├── cli.tsx                 # Main entrypoint
│   ├── app.tsx                 # React UI wrapper and command handling logic
│   ├── core/
│   │   ├── agent.ts            # Core cognitive loop and instruction runner
│   │   ├── config.ts           # Environment variable and global config management
│   │   ├── checkpoints.ts      # Conversation state checkpoint save/load logic
│   │   ├── slash-commands.ts   # Interactive command definitions
│   │   └── tools/              # Specialized tools equipped by the agent
│   │       ├── shellTools.ts   # Command execution and background task control
│   │       ├── systemTools.ts  # File operations, directory creation, port checks
│   │       ├── subagentTools.ts# Secondary agent instantiation and management
│   │       └── networkTools.ts # Web content fetch and browser integration
│   └── components/             # React Ink components (visual stats, wizards)
├── tests/                      # Unit test suites using Vitest
└── package.json                # Project manifest and scripts
```

---

## 🌟 Key Developer Features

### 1. Cyberpunk Terminal UI & Token Tracking
A rich terminal interface showing live statistics on active prompt sizes, completion token counts, token cost summaries, active models, and remaining context windows.

### 2. Session Management & Checkpoints
Allows developers to save the current state of a coding conversation and restore it at any point using `/checkpoint save <name>` and `/checkpoint restore <id>`. This allows you to safely experiment with different implementations. Use the `--resume` or `-r` flag to continue where you left off.

### 3. Subagent Orchestration
Superagent can launch concurrent secondary agents to perform parallel tasks:
- **Researcher**: Explores the codebase and retrieves context (Read-Only).
- **Coder**: Implements code modifications and refactoring.
- **Reviewer**: Audits changes, runs tests, and validates implementations.
- **manual-tester**: Automated browser testing (Playwright), browser log/error analysis, and visual UI/UX design taste checks.

### 4. Visible Terminal Windows (`/terminal`)
Runs development servers, local builds, or test watchers in popped-up, visible OS terminal windows (Windows cmd, macOS Terminal, Linux x-terminal). It includes an AI-assisted preset initializer (`/terminal init`) to auto-configure workspace command presets.

### 5. Structured Planning
For complex changes, Superagent writes a detailed `implementation_plan.md` to the workspace root for user approval before modifying code.

---

## 🔬 Deep Dive: System Architecture & Core Logic

Superagent features several robust subsystems that ensure stability, execution safety, and a seamless developer workflow:

### 1. Active Host Diagnostics & Auto-Dependency Setup (`androidSetup.ts`)
Superagent proactively audits and prepares your local machine's developer environment:
- **Automatic Utility Provisioning**: If `ripgrep` (`rg` for high-speed workspace indexing) or `curl` (on Windows) is missing on your host machine, Superagent automatically downloads, extracts, and places the binaries locally in `~/.superagent-r/bin/`.
- **Android CLI Orchestrator**: Scans and provisions Google's official Android SDK command-line utilities using custom PowerShell (`install.cmd` for Windows) and Shell (`install.sh` for macOS/Linux) scripts.

### 2. Multi-Agent Delegation & Standardized Reporting (`subagentTools.ts`)
For parallel work, Superagent supports spawning concurrent subagents:
- **Delegation Guardrails**: To prevent runaway loops or infinite resource spending, subagent delegation depth is restricted to a maximum level of `2`.
- **Structured Markdown Reporting**: Every subagent completes its task by printing a standardized markdown block containing the initial goal, actions taken, key findings, and final outcome status.
- **Visual Log Streaming**: Subagent actions, thoughts, tool calls, and execution errors are formatted and logged in a nested visual tree layout.

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
   Superagent isolates config files outside the project repository. Create a `.env` file in `~/.superagent-r/` (e.g., `C:\Users\<Username>\.superagent-r\.env` on Windows, or `~/.superagent-r/.env` on macOS/Linux):
   ```env
   # API Keys (Provide at least one)
   ANTHROPIC_API_KEY=your_anthropic_api_key
   OPENAI_API_KEY=your_openai_api_key

   # Active Provider (openai / anthropic / openrouter / custom)
   PROVIDER=openai

   # Active Model
   MODEL=gpt-4o
   ```

---

## ⚙️ Development Scripts

Run the following NPM scripts during development:

- **Start Development Mode**:
  ```bash
  npm run dev
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
- **`/compact`**: Shows a condensed summary of the active conversation history to help you audit and optimize prompt context usage.
- **`/quit`** or **`/exit`**: Safely exits the application.

### State Checkpoints
- **`/checkpoint`** (or **`/checkpoint <name>`**): Saves a snapshot of your current conversation history, active model state, and planning states.
- **`/checkpoint list`**: Displays a styled timeline list of all saved checkpoints in the current session, showing their unique IDs, timestamps, and message counts.
- **`/checkpoint restore <id>`**: Restores a checkpoint by its ID. It automatically terminates running subagents/tasks and reverts the agent's internal state to the checkpoint.

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
