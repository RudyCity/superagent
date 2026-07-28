# Superagent 🚀

An interactive, terminal-based AI coding assistant featuring a cyberpunk UI, model context tracking, local checkpointing, and a 3-tier multi-agent orchestration architecture.

![Superagent Terminal UI](assets/Video_SuperAgent.gif)

---

## Key Features

- **3-Tier Multi-Agent Architecture**: 
  - **Master Agent**: High-level task planner & worktree orchestrator.
  - **Superagent**: Feature developer isolated in Git worktrees.
  - **Subagent**: Ephemeral atomic file/search runners.
- **t-line (Desktop App Integration)**: Connect Superagent CLI with [t-line](https://github.com/RudyCity/t-line) via client/server mode.
- **Smart Context & Token Management**: Automatic token tracking, strategy-based pruning, summarization, and pinning.
- **Git Checkpoint Recovery**: Instant rollback & branch switching on error or experimentation.
- **Chrome Extension Integration**: Remote control browser tabs, capture console/network logs, and extract Markdown DOM snapshots.
- **Interactive Terminal & Tooling**: Built-in interactive execution with streaming output and full shell capabilities.

---

## Desktop App Integration (`t-line`)

Superagent seamlessly pairs with [t-line](https://github.com/RudyCity/t-line), the official Superagent desktop GUI client.

### Quick Setup

1. **Start Superagent in Server Mode**:
   ```bash
   superagent --server 9222 --client-mode tline
   ```
2. **Connect via t-line**:
   Launch `t-line` desktop application and set the server URL to `http://localhost:9222`.

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
# Interactive CLI mode
superagent

# Start in specific working directory
superagent --dir /path/to/project

# Multi-agent mode (Master Tier orchestration)
superagent --multi

# Server Mode for t-line Desktop Integration
superagent --server 9222 --client-mode tline
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

## System Architecture

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
