# 03. API & External Contracts

This document catalogs all user interfaces, CLI commands, tool interfaces, WebSocket bridge contracts, and external client integrations.

---

## 1. CLI Commands & Arguments

### Terminal Launch Flags

```powershell
# Default interactive mode (loads settings from model-config.json)
superagent

# Launch in 3-Tier Multi-Agent Orchestration Mode
superagent --multi

# Launch in Server Bridge Mode for Desktop Client (t-line)
superagent --server 3000 --client-mode tline

# Launch in Single Agent Mode
superagent --single
```

| Flag | Type | Description | Default |
|---|---|---|---|
| `--multi` | boolean | Enables 3-tier Master $\rightarrow$ Superagent $\rightarrow$ Subagent orchestration | `false` |
| `--single` | boolean | Direct single-agent execution without worktrees | `true` |
| `--server [port]` | number | Starts Superagent as an IPC/WebSocket server | `3000` |
| `--client-mode [mode]` | string | External client adapter (`tline` \| `chrome-extension`) | none |
| `--version` / `-v` | boolean | Displays current version | - |
| `--help` / `-h` | boolean | Displays command-line help | - |

---

## 2. Interactive Slash Commands

Superagent features built-in terminal wizard commands:

| Slash Command | Handler | Description |
|---|---|---|
| `/login` | `src/core/config/providers.ts` | Multi-provider credential wizard (add/switch Anthropic, Google, OpenAI, OpenRouter, Ollama) |
| `/model` | `src/core/config/providers.ts` | Configure tier models, presets, and subagent assignments |
| `/settings` | `src/core/config/jsonConfig.ts` | Adjust concurrency, streaming, max iterations, and token thresholds |
| `/clear` | `src/cli.tsx` | Reset session context window while preserving SQLite history |
| `/compact` | `src/core/context/ContextManager.ts` | Manually trigger LLM-driven context summarization and pruning |
| `/history` | `src/core/storage/historyDb.ts` | Search previous conversation transcripts using SQLite FTS5 |
| `/terminal [preset]` | `src/core/tools/systemTools.ts` | Run or initialize terminal automation presets |

---

## 3. Tier Toolset Contracts

Tools are defined in `src/core/tools/` and mapped to agent tiers in `src/core/tools/toolsets.ts`:

### Master Agent Toolset (`masterToolset`)

| Tool Name | Parameters | Description |
|---|---|---|
| `invokeSuperagentTool` | `{ featureName: string, role: string, instructions: string }` | Spawns a new Superagent in a dedicated Git worktree (`~/.superagent-r/worktrees/<featureName>`). |
| `awaitSuperagentsTool` | `{ timeoutSeconds?: number }` | Awaits completion of running Superagents and collects their execution reports. |
| `mergeSuperagentsTool` | `{ featureName: string, targetBranch?: string }` | Verifies and merges a completed Superagent git branch back into the main branch. |
| `manageSuperagentsTool`| `{ action: 'list' \| 'kill' \| 'status', featureName?: string }` | Inspects status or cancels running Superagent processes. |
| `gitWorktreeTool` | `{ action: 'list' \| 'prune' \| 'clean' }` | Inspects and cleans active git worktrees. |

### Superagent Toolset (`superagentToolsets`)

| Tool Name | Parameters | Description |
|---|---|---|
| `invokeSubagentTool` | `{ subagentType: string, task: string, files?: string[] }` | Spawns an ephemeral subagent (`researcher`, `coder`, `reviewer`, `tester`, `chrome-agent`). |
| `manageSubagentsTool` | `{ action: 'list' \| 'kill', subagentId?: string }` | Monitors or terminates running ephemeral subagents. |
| `runCommandTool` | `{ command: string, cwd?: string }` | Executes a shell command via `execa` in the isolated worktree directory. |
| `readFileTool` | `{ filePath: string, startLine?: number, endLine?: number }` | Reads text or code file contents. |
| `writeToFileTool` | `{ filePath: string, content: string, overwrite?: boolean }` | Creates or writes files in the worktree. |
| `replaceFileContentTool` | `{ filePath: string, targetContent: string, replacement: string }` | Performs surgical single-block replacements. |
| `applyPatchTool` | `{ patch: string }` | Applies unified git diff patches. |

---

## 4. Remote Chrome WebSocket Bridge API (`Port 9223`)

Superagent incorporates a serverless WebSocket server (`src/core/tools/remoteChromeBridge.ts`) listening on `ws://127.0.0.1:9223`. Lightweight Chrome extensions connect to this bridge to execute automated browser tasks.

### Message Envelope Specification

All WebSocket frames follow a JSON-RPC 2.0 styled contract:

```typescript
interface ChromeBridgeRequest {
  id: string;             // Unique message UUID
  action: ChromeAction;   // Action verb
  params: Record<string, any>;
}

interface ChromeBridgeResponse {
  id: string;
  success: boolean;
  data?: any;
  error?: string;
}
```

### Supported Actions

| Action | Parameters | Response Payload | Description |
|---|---|---|---|
| `get_tabs` | `{}` | `{ tabs: Array<{ id: number, url: string, title: string }> }` | Lists all active browser tabs. |
| `navigate` | `{ tabId: number, url: string }` | `{ status: 'loaded', url: string }` | Navigates a tab to target URL. |
| `get_dom` | `{ tabId: number, selector?: string }` | `{ html: string, text: string }` | Extracts serialized DOM or text content. |
| `click` | `{ tabId: number, selector: string }` | `{ clicked: true }` | Dispatches native click event to DOM element. |
| `type` | `{ tabId: number, selector: string, text: string }` | `{ typed: true }` | Fills input field with text value. |
| `screenshot` | `{ tabId: number, format?: 'png' \| 'jpeg' }` | `{ base64Image: string }` | Captures viewport screenshot. |
| `evaluate_js` | `{ tabId: number, script: string }` | `{ result: any }` | Evaluates arbitrary JavaScript in tab context. |

---

## 5. Desktop Bridge Protocol (`t-line`)

When Superagent is launched with `--server 3000 --client-mode tline`, it exposes HTTP endpoints and WebSocket streams for the desktop application:

- **`POST /api/chat`**: Dispatches a new user turn to the active session.
- **`GET /api/stream`**: Server-Sent Events (SSE) or WebSocket streaming LLM token chunks and tool status updates.
- **`GET /api/history`**: Retrieves session transcripts from SQLite.
- **`POST /api/models`**: Updates provider configurations and active presets in `model-config.json`.


## Automated Route Inventory

<!-- API_CATALOG_START -->
### 🌐 Superagent (Interactive Terminal AI Coding Assistant)

| Method | Endpoint Route | Auth Guard | Description | Source File |
|:---|:---|:---|:---|:---|

### 🌐 t-line (Desktop Client for Superagent)

| Method | Endpoint Route | Auth Guard | Description | Source File |
|:---|:---|:---|:---|:---|

<!-- API_CATALOG_END -->

