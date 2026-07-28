<div align="center">

# 🚀 Superagent

**An interactive, terminal-based AI coding assistant for pair programming, context engineering, and autonomous workflow automation.**

[![Version](https://img.shields.io/github/v/release/RudyCity/superagent?style=flat-square&color=8A2BE2)](https://github.com/RudyCity/superagent/releases)
[![License](https://img.shields.io/github/license/RudyCity/superagent?style=flat-square&color=blue)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh)
[![t-line](https://img.shields.io/badge/Desktop_App-t--line-00D1B2?style=flat-square)](https://github.com/RudyCity/t-line)

<br />

![Superagent Terminal UI](assets/Video_SuperAgent.gif)

</div>

---

## ⚡ Overview

**Superagent** is a high-performance, terminal-native AI coding assistant built for developers. It executes shell commands, inspects and edits codebases, runs test suites, manages multi-file edits, and automates context pruning—all directly from your local terminal.

Superagent also pairs natively with **[t-line](https://github.com/RudyCity/t-line)**, its official desktop client.

---

## ✨ Key Features

- **🎯 Single Agent Mode (Primary)**: Seamless pair programming with live terminal execution, intelligent tool usage, and subagent delegation.
- **🖥️ Native Desktop Integration**: Automatic connection with [t-line](https://github.com/RudyCity/t-line) desktop GUI app without manual configuration.
- **🧠 Smart Context Management**: Automatic token tracking, LLM summarization, strategy-based pruning, and message pinning.
- **🛡️ Local Git Checkpoints**: Automatic branch checkpoints and safety rollbacks during active sessions.
- **🛠️ Integrated Tooling**: Built-in file search, regex ripgrep, background command runners, and terminal presets.
- **🌐 Chrome Extension *(Experimental)***: Browser automation, console/network log inspection, and DOM text extraction.
- **🤖 3-Tier Multi-Agent Mode *(Experimental)***: Master Agent orchestrating isolated Superagents across parallel Git worktrees (`--multi`).

---

## 🚀 Quick Start

### Installation

Requires [Bun](https://bun.sh) (v1.0 or later) or Node.js.

```bash
# Clone the repository
git clone https://github.com/RudyCity/superagent.git
cd superagent

# Install dependencies & build
bun install
bun run build

# Register globally (optional)
bun install-g .
```

### Usage

```bash
# Start Superagent in the current workspace
superagent

# Open Superagent in a specific project directory
superagent --dir /path/to/project

# Launch in Multi-Agent Orchestration mode (Experimental)
superagent --multi
```

---

## 💻 Desktop App Integration (`t-line`)

Superagent connects **automatically** with **[t-line](https://github.com/RudyCity/t-line)**, the desktop version of Superagent. 

No manual server configuration or extra CLI arguments are required—simply launch `t-line` alongside Superagent for a unified desktop experience.

---

## ⌨️ Command Reference

### Core & Session Commands

| Command | Description |
|---|---|
| `/help` | Display interactive command guide and active shortcuts |
| `/new` | Start a new session (clear history & screen) |
| `/clear` | Clear conversation history |
| `/resume` | Resume a conversation session from history via wizard |
| `/session` | Manage session history: list, export `<id>`, clear --empty |
| `/history` | Manage SQLite history database: stats, export, backup, migrate, tag |
| `/search-history` `/sh` | Search conversation history. Usage: `/sh <query> [--all] [--debug]` |
| `/knowledge` `/k` | Browse & search global pinned knowledge (cross-session) |
| `/pin` | Pin important messages (full content + agent tag) |
| `/checkpoint` | Manage checkpoints to save/restore conversation state |
| `/compact` | Show compaction status / force context compaction |
| `/compaction-history` `/ch` | View compaction audit trail |
| `/goal` | Activate Goal Mode for long-running overnight tasks |
| `/init` | Initialize project (Git setup, agents.md generation, system audit) |
| `/exit` `/quit` | Exit the application |
| `/image` | Attach image from clipboard (`paste`) or file path (`attach <path>`) |

### Configuration & Providers

| Command | Description |
|---|---|
| `/login` | Configure AI provider credentials (e.g. `/login openrouter sk-or-...`) |
| `/model` | Switch model presets or custom tier configurations |
| `/settings` | View current rate limit, concurrency & app settings |
| `/setting-concurrency <0\|1>` | Set LLM concurrency limit |
| `/setting-rpm <number>` | Set rate limit RPM |
| `/setting-capacity <number>` | Set rate limit capacity |
| `/setting-streaming <on\|off>` | Enable or disable streaming |
| `/setting-context-limit <number>` | Set context window limit (0 = auto) |
| `/setting-max-iterations <number>` | Set max agent iterations (0 = unlimited) |
| `/setting-checklist-limit <number>` | Set task checklist visible limit |
| `/setting-history-limit <number>` | Set checklist history visible limit |
| `/setting-procs-limit <number>` | Set processes panel visible limit |
| `/setting-focus` `/focus` | Set reasoning focus depth: off\|low\|medium\|high\|xhigh\|max\|custom |
| `/setting-focus-budget <number>` | Set reasoning focus custom budget tokens |
| `/setting-auto-vision <on\|off>` | Enable/disable automatic vision token saving |
| `/setting-vision-threshold <number>` | Set characters threshold for auto vision token saving |
| `/setting-classifier <on\|off>` | Enable/disable multi-category request classifier |
| `/setting-classifier-threshold <high\|medium\|low>` | Set classifier heuristic confidence threshold |
| `/setting-rmemory` | Configure RMemory: on, off, provider, model, dimensions |

### Agent, Tools & Automation

| Command | Description |
|---|---|
| `/agents` | List active subagents and defined subagent types |
| `/processes` `/procs` | List running background processes |
| `/processes stop [id\|all]` | Stop background processes |
| `/terminal` | Manage & execute terminal presets. Subcommands: `<command>`, `preset <name>`, `bg <cmd>`, `all`, `init`, `stop`, `list` |
| `/skills` | List all installed agent skills and templates |
| `/install` | Install a skill from skills.sh (e.g. `/install vercel-labs/skills/find-skills`) |
| `/memory` | Manage and inspect RMemory long-term memory: status, sync, search, add, delete, list-scenes, read-scene, read-persona |
| `/mcp` | Manage MCP (Model Context Protocol) servers: list, add, remove, reload |
| `/macro` | Manage and run browser macro presets: list, run, delete |
| `/internal-hooks` `/ih` | Manage custom internal hook tools: init, dev, list, active |

### Workspace Management

| Command | Description |
|---|---|
| `/workspace` `/w` | Manage local & remote (SSH) project workspaces |
| `/worktrees` `/worktree` | Manage Git worktrees: list, prune, remove |

`/workspace` subcommands:
- `status` — Show current workspace info & SSH remote status
- `add <path\|ssh://...>` — Register a workspace (local path or SSH remote)
- `use <path\|index>` — Switch to a registered workspace

SSH remote format: `ssh://user@host:port/path?key=/path/key.pem`

**SSH workspace example:**

```bash
# Add SSH remote workspace
/workspace add ssh://root@192.168.1.100:22/home/projects/myapp?key=~/.ssh/id_rsa

# Switch to it
/workspace use ssh://root@192.168.1.100:22/home/projects/myapp

# Check remote status
/workspace status
```

**`/worktrees` subcommands:**
- `list` — Show all Git worktrees
- `prune` — Clean stale worktree metadata
- `remove <path>` — Remove a worktree

### Keyboard Shortcuts

| Shortcut | Description |
|---|---|
| `Ctrl+C` | Abort current process / Exit if input is empty |
| `Ctrl+P` | Show checkpoints interactive wizard dialog |
| `Ctrl+H` | Toggle search history panel |
| `Ctrl+T` | Toggle checklist focus mode (when plan is approved) |
| `Ctrl+O` | Cycle through and toggle expand/collapse of tool/system entries |
| `Esc` | Reset input focus, cancel active wizard, or reset scroll |
| `↑/↓` | Scroll message viewer or navigate CLI history |
| `Tab` | Autocomplete slash commands or cycle suggestions |
| `Click` | Focus or scroll panels via terminal mouse interaction |
| `!<command>` | Quick shortcut to run a shell command (e.g. `!npm run dev`) |

---

## 🏗️ Architecture

```text
                               ┌────────────────────────────────┐
                               │       Superagent CLI           │
                               └──────────────┬─────────────────┘
                                              │
                     ┌────────────────────────┴────────────────────────┐
                     ▼                                                 ▼
        ┌────────────────────────┐                        ┌────────────────────────┐
        │  Single Agent Mode     │                        │  t-line Desktop Client │
        │  (Direct Execution)    │                        │  (Automatic Bridge)    │
        └───────────┬────────────┘                        └────────────────────────┘
                    │
         ┌──────────┴──────────┐
         ▼                     ▼
┌──────────────────┐  ┌──────────────────┐
│ Shell & FileOps  │  │ Atomic Subagents │
└──────────────────┘  └──────────────────┘
```

<details>
<summary><b>View Experimental 3-Tier Multi-Agent System</b></summary>

<br />

When enabled via `--multi`, Superagent runs a 3-tier hierarchy:

```text
Master Agent (Orchestrator)
  ├── Superagent A (Git Worktree 1 - Feature A)
  │     ├── Subagent (Search & Read)
  │     └── Subagent (Code Writer)
  └── Superagent B (Git Worktree 2 - Feature B)
        └── Subagent (Tester / Debugger)
```
</details>

---

## 📄 License & Author

Developed by **Rudy City** ([@RudyCity](https://github.com/RudyCity)) • 📧 Contact: [hrudy715@gmail.com](mailto:hrudy715@gmail.com)

Distributed under the [MIT License](LICENSE).
