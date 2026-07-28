# Superagent 🚀

An interactive, terminal-based AI coding assistant designed for pair programming, automated context management, local git checkpointing, and seamless desktop UI integration.

![Superagent Terminal UI](assets/Video_SuperAgent.gif)

---

## Key Features

- **Single Agent Mode (Primary)**: Direct pair programming with shell execution, file tools, and subagents for atomic operations.
- **t-line Desktop Integration**: Seamlessly connect Superagent CLI with the [t-line](https://github.com/RudyCity/t-line) desktop GUI app.
- **Smart Context & Token Management**: Automatic token tracking, strategy-based pruning, summarization, and pinning.
- **Git Checkpoint Recovery**: Instant rollback & branch switching on error or experimentation.
- **Chrome Extension Integration *(Experimental)***: Remote control browser tabs, capture console/network logs, and extract Markdown DOM snapshots.
- **Interactive Terminal & Tooling**: Built-in interactive execution with streaming output and full shell capabilities.
- **3-Tier Multi-Agent Mode *(Experimental)***: Master Agent orchestrating isolated Superagents across Git worktrees (`--multi`).

---

## Desktop App Integration (`t-line`)

Superagent seamlessly pairs with [t-line](https://github.com/RudyCity/t-line), the official Superagent desktop GUI client.

Integration with `t-line` is automatic. When launching `t-line`, it seamlessly connects to Superagent without requiring manual server initialization or configuration commands.

---

## Installation

```bash
# Clone the repository
git clone https://github.com/RudyCity/superagent.git
cd superagent

# Install dependencies & build
bun install
bun run build

# Link globally (optional)
npm link
```

---

## Usage

```bash
# Start Superagent (Single Agent mode - Default)
superagent

# Start in specific working directory
superagent --dir /path/to/project

# Multi-agent mode (Experimental)
superagent --multi
```

---

## Slash Commands Reference

| Command | Description |
|---|---|
| `/help` | Show command list |
| `/login` | Configure AI provider keys & endpoints |
| `/model` | Switch model presets or custom tier configurations |
| `/settings` | View and edit application settings |
| `/compact` | Compress context window manually |
| `/clear` | Clear active conversation history |
| `/history` | Inspect or search past sessions |
| `/terminal` | Access and run embedded terminal presets |

---

## Experimental Multi-Agent Architecture

> **Note**: 3-Tier Multi-Agent mode is currently **experimental**. Activate using `superagent --multi`.

```
Master Agent (Orchestrator)
  ├── Superagent A (Git Worktree 1 - Feature A)
  │     ├── Subagent (Search & Read)
  │     └── Subagent (Code Writer)
  └── Superagent B (Git Worktree 2 - Feature B)
        └── Subagent (Tester / Debugger)
```

---

## License & Credits

Created by **Rudy City** ([@RudyCity](https://github.com/RudyCity)). Distributed under the MIT License.
