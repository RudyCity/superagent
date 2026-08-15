# 01. Architecture Overview

Superagent is designed around a multi-tier agent architecture, strict filesystem isolation, model-agnostic provider abstractions, and an interactive cyberpunk terminal user interface.

---

## 1. 3-Tier Multi-Agent Hierarchy

When running in multi-agent mode (`superagent --multi`), the system distributes responsibilities across three distinct tiers:

```
Master Agent  (Orchestrator & Strategy Engine)
  └── Superagent  (Per-Feature Developer, Isolated in Git Worktree)
        └── Subagent  (Atomic & Ephemeral Worker: Researcher, Coder, Reviewer, Tester, Chrome-Agent)
```

### Tier Responsibilities and Toolset Mapping

| Tier | Primary Role | Isolation Scope | Toolset (`src/core/tools/toolsets.ts`) |
|---|---|---|---|
| **Master Agent** | Orchestration, high-level planning, worktree lifecycle, progress monitoring, and branch merging. Cannot modify code files directly. | Main Repository Root | `invokeSuperagentTool`, `awaitSuperagentsTool`, `mergeSuperagentsTool`, `manageSuperagentsTool`, `manageSubagentsTool`, `gitWorktreeTool` |
| **Superagent** | Feature-level implementation, multi-step code refactoring, test execution, subagent dispatching, and branch committing. | Isolated Git Worktree (`~/.superagent-r/worktrees/<name>`) | Shell Tools + File Tools + `invokeSubagentTool`, `manageSubagentsTool`, `gitWorktreeTool` |
| **Subagent** | Ephemeral, specialized atomic tasks (researching codebase, writing targeted patches, code review, test verification, browser automation). | Current Parent Worktree (Ephemeral) | Targeted tools based on subagent type (e.g. `researcher`, `coder`, `reviewer`, `software-tester`, `chrome-agent`) |

---

## 2. C4 Architecture Diagrams

### C4 Level 1: System Context Diagram

```mermaid
graph TD
    classDef actor fill:#1e293b,stroke:#38bdf8,stroke-width:2px,color:#fff;
    classDef system fill:#0f172a,stroke:#818cf8,stroke-width:2px,color:#fff;
    classDef external fill:#1f2937,stroke:#fbbf24,stroke-width:2px,color:#fff;
    classDef db fill:#111827,stroke:#34d399,stroke-width:2px,color:#fff;

    Developer["👨‍💻 Developer / User"]:::actor
    Desktop["🖥️ Desktop Client (t-line)"]:::actor
    Browser["🌐 Web Browser (Chrome Profile)"]:::actor

    subgraph SuperagentEngine["Superagent Core Engine"]
        CLI["📟 Terminal CLI & Ink React UI"]:::system
        Master["👑 Master Agent Orchestrator"]:::system
        ContextEngine["🧠 Context Manager & Token Tracker"]:::system
    end

    subgraph StorageLayer["Persistence & Workspaces"]
        SQLiteDB[("🗄️ SQLite Database (~/.superagent-r/history.db)")]:::db
        JSONConfig["⚙️ Model & Provider Config (~/.superagent-r/model-config.json)"]:::db
        GitWorktrees["🌿 Git Worktrees (~/.superagent-r/worktrees/)"]:::db
    end

    subgraph Providers["External AI Models & Bridges"]
        AIProviders["☁️ AI Providers (Anthropic / OpenAI / Gemini / Ollama / DeepSeek)"]:::external
        RemoteBridge["🔌 WebSocket Chrome Bridge (Port 9223)"]:::external
    end

    Developer -->|Interactive CLI Commands| CLI
    Desktop -->|HTTP / WebSocket Client Mode| CLI
    CLI --> Master
    Master --> ContextEngine
    Master --> SQLiteDB
    Master --> JSONConfig
    Master --> GitWorktrees
    Master --> AIProviders
    Master --> RemoteBridge
    RemoteBridge --> Browser
```

### C4 Level 2: Container & Subsystem Architecture

```mermaid
graph TB
    classDef core fill:#1e293b,stroke:#38bdf8,stroke-width:2px,color:#fff;
    classDef tool fill:#0f172a,stroke:#818cf8,stroke-width:2px,color:#fff;
    classDef store fill:#111827,stroke:#34d399,stroke-width:2px,color:#fff;

    subgraph CoreEngine["src/core/"]
        MasterAgent["masterAgent.ts<br/>(Loop & Dispatcher)"]:::core
        ContextMgr["context/ContextManager.ts<br/>(Compaction & Token State)"]:::core
        TokenTracker["context/TokenTracker.ts<br/>(tiktoken Model Counters)"]:::core
        Prompts["tools/prompts.ts<br/>(Dynamic System Prompts)"]:::core
    end

    subgraph ToolEcosystem["src/core/tools/"]
        SuperTools["superagentTools.ts<br/>(invoke/await/merge)"]:::tool
        SubTools["subagentTools.ts<br/>(ephemeral spawners)"]:::tool
        FileTools["fileTools.ts & systemTools.ts<br/>(execa, read, write, patch)"]:::tool
        ChromeBridge["remoteChromeBridge.ts<br/>(WS Port 9223 Server)"]:::tool
        Toolsets["toolsets.ts<br/>(Tier Permissions Map)"]:::tool
    end

    subgraph StorageSubsystem["src/core/storage/ & config/"]
        HistoryDB["historyDb.ts<br/>(SQLite FTS5 Transcripts)"]:::store
        JsonConfig["config/jsonConfig.ts & providers.ts<br/>(Zero env config)"]:::store
    end

    MasterAgent --> ContextMgr
    ContextMgr --> TokenTracker
    MasterAgent --> Toolsets
    Toolsets --> SuperTools
    Toolsets --> SubTools
    Toolsets --> FileTools
    Toolsets --> ChromeBridge
    MasterAgent --> Prompts
    MasterAgent --> HistoryDB
    MasterAgent --> JsonConfig
```

---

## 3. Core Execution Lifecycle

1. **Initialization & Configuration Loading**:
   - `src/cli.tsx` bootstraps the application and reads configuration directly from `~/.superagent-r/model-config.json` via `getEffectiveMasterModel()` and `getConfiguredProviders()`.
   - SQLite connection to `~/.superagent-r/history.db` initializes tables (`sessions`, `messages`, `messages_fts`, `artifacts`).
2. **Context Engine Initialization**:
   - `ContextManager` binds with the chosen model tokenizer (`tiktoken` for OpenAI/Gemini/Anthropic equivalents).
   - Dynamic prompt generation builds the tier-specific instructions from `src/core/tools/prompts.ts`.
3. **Execution Loop (`masterAgent.ts`)**:
   - The user query is recorded to SQLite history.
   - Master Agent constructs the request, streams LLM output, and evaluates tool calls.
   - When feature work is required, Master Agent invokes `invokeSuperagentTool` to spin up a git worktree and branch.
   - Superagents work within their dedicated worktrees, utilizing subagents for atomic tasks.
   - Master Agent merges completed branches back to the main branch via `mergeSuperagentsTool`.
4. **Context Compaction & Token Maintenance**:
   - Before each iteration, `ContextManager` checks token consumption against the model limit.
   - If threshold is exceeded, pluggable compaction strategies (`SummarizationStrategy`, `PinningStrategy`, `PruningStrategy`) condense the transcript without data loss.

---

## 4. Worktree Isolation System

To guarantee that concurrent feature development does not cause git branch pollution or file race conditions:
- Each Superagent receives an isolated directory: `~/.superagent-r/worktrees/<feature-name>/`.
- A dedicated git branch (e.g. `feature/<feature-name>`) is created automatically.
- All file reads, writes, and test commands executed by the Superagent and its subagents occur inside this isolated worktree.
- Upon successful feature completion and verification, the Master Agent issues a merge operation back into the target branch.

---

## 5. Client Bridge Modes

Superagent supports multiple external integration modes:
1. **Desktop Client Bridge (`t-line`)**:
   - Superagent runs in server mode: `superagent --server 3000 --client-mode tline`.
   - Desktop frontend connects via HTTP/WebSocket protocol, rendering UI with terminal-grade performance.
2. **Remote Chrome Extension Bridge (`chrome-extension-remote`)**:
   - Serverless WebSocket server auto-binds on `ws://127.0.0.1:9223`.
   - Lightweight Chrome extension connects from any browser profile, enabling automated tab management, DOM inspection, screenshot capture, and navigation without launching bulky Puppeteer/Playwright instances.
