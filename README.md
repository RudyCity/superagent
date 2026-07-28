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

| Command | Description |
|---|---|
| `/help` | Display interactive command guide and active shortcuts |
| `/login` | Configure AI provider credentials and API keys |
| `/model` | Switch model presets or custom tier configurations |
| `/settings` | View and edit application settings |
| `/compact` | Trigger manual context window compaction |
| `/clear` | Clear current active session history |
| `/history` | Search and inspect past session transcripts |
| `/terminal` | Manage and execute workspace terminal presets |

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

Developed by **Rudy City** ([@RudyCity](https://github.com/RudyCity)).

Distributed under the [MIT License](LICENSE).
