# Superagent 🚀

Superagent is an interactive, terminal-based AI coding assistant designed to facilitate the cycle of development, testing, debugging, and application optimization directly from your workspace.

It features a cyberpunk-styled terminal user interface built with terminal UI components, automatic tracking of model context token limits, a robust security permission layer, multi-agent orchestration (parallel subagents), and persistent integration with local terminal shells.

---

## 📖 Background

In modern software development, developers frequently switch context between writing code, running terminal commands, inspecting system logs, searching documentation, and interacting with Large Language Models (LLMs).

Superagent bridges this gap by providing an integrated terminal environment that understands your project's context automatically using a project specification file (`agents.md`), automates execution of independent tasks through secondary agents (*subagents*), and tracks LLM context window limits in real-time. Security is a primary design goal: every file modification, tool invocation, and shell command execution requires explicit user authorization.

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

### 4. Visible Terminal Windows (`/terminal`)
Runs development servers, local builds, or test watchers in popped-up, visible OS terminal windows (Windows cmd, macOS Terminal, Linux x-terminal). It includes an AI-assisted preset initializer (`/terminal init`) to auto-configure workspace command presets.

### 5. Structured Planning
For complex changes, Superagent writes a detailed `implementation_plan.md` to the workspace root for user approval before modifying code.

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

3. Configure Global API Credentials:
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
