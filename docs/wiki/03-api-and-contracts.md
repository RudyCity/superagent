# 03. API & External Contracts

This document catalogs all user interfaces, CLI commands, tool interfaces, WebSocket bridge contracts, and external client integrations.

---

## Python MCP Client (external integration)

An installable Python 3.11+ client and local stdio bridge lives at [`integrations/python-mcp-client/`](../../integrations/python-mcp-client/README.md). It consumes an existing SuperAgent Streamable HTTP `/mcp` endpoint and exposes dynamically authorized tools, resources, and prompts through stdio for compatible host applications. OAuth PKCE and static Bearer credentials are supported; the bridge does not own or restart Core/MCP services. The endpoint URL, authorization scope and optional Bearer token are supplied by the client environment, separate from SuperAgent model configuration.

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
| `/yolo [on\|off\|status]` | `src/core/commands/coreCommands.ts` | Toggle scoped YOLO mode (auto-approve actions within project & 1 parent level above) |

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

### Progressive Tool Schema Discovery

Single Mode and Multi Mode Master/worker agents use progressive schema exposure. The authorized tool catalog remains complete inside the Agent, but the model initially receives only the canonical `list_tools` and `describe_tool` schemas.

- `list_tools` searches the current Agent's authorized catalog and returns concise names/descriptions. Listing a tool does not expose its argument schema.
- `describe_tool` returns full schemas only for names in that authorized catalog. Successfully described schemas are added to that Agent's model-visible set on the next model request.
- Discovered schemas remain available through the recognized continuation of the current task. An independent top-level task, mode switch, changed catalog fingerprint, or Agent disposal clears discovery state.
- The Master, Single, and Superagent tiers use this behavior. Specialized Subagents retain their existing full, role-specific toolsets.
- Discovery is not authorization. The model-visible schema list is separate from the full execution catalog, and `ToolExecutor`/permission checks remain the authority for tool execution.
- Native tool calling and prompt/XML-based tool calling use the same model-visible schema projection. Runtime capability notices are derived from the authorized catalog so undiscovered shell/write/network tools are not incorrectly reported as disabled.
- `get_tools` and `describe_tools` are compatibility aliases resolved by the runtime. Model calls must use the canonical schema names actually advertised: `list_tools` and `describe_tool`.

The first-request schema benchmark against the current declared toolsets was approximately 7,298 to 262 estimated cl100k tokens for the 48-entry Master toolset, and 14,631 to 262 for the 67-entry Superagent toolset. These are serialized-schema estimates, not provider-billed usage; runtime eligibility filters can lower the active tool counts. See `docs/plans/2026-10-14-dynamic-tool-discovery-single-multi-plan.md` for implementation scope and verification details.

---

## 4. MCP Independent Multi-Project Routing

The MCP gateway can select registered local projects and standalone SSH projects by stable project ID. Workspace Chains are optional and remain reserved for workflows that coordinate multiple nodes.

- Use project registry tools to list, inspect, register, update, and remove project metadata.
- Pass projectId to supported workspace-scoped operations to route a single tool call; a per-call target does not change the session default.
- Access grants are bound to the authenticated MCP identity and separated into read, write, execute, Git, worktree, planning, and chain capabilities. Project registry mutations and grant creation require locally enabled Full YOLO; registration does not imply access.
- Standalone SSH uses a separate connection per registered project and supports workspace inspection, exec, batched file reads/writes, listing/search, and Git. Unsupported operations fail closed instead of falling back to local files.
- The SSH project root guards supported file operations but does not sandbox shell commands. Execute capability runs with the SSH account's OS privileges. MCP SSH does not prompt interactively for passwords.

See [Independent MCP Projects](../mcp/independent-projects.md) for tool examples, access setup, routing rules, and security limitations.

---

## 5. Remote Chrome WebSocket Bridge API (Port 9223)

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


## 6. MCP HTTP Tools & Muse Direct Chat Contract

Superagent exposes MCP over Streamable HTTP. This endpoint is distinct from the Muse WebSocket tunnel: an MCP client calls a registered Superagent tool, while Superagent uses its active authenticated Muse WebSocket watcher to relay direct chat.

### Remote-agent tool catalog

| Tool | Classification | Contract |
|---|---|---|
| `superagent_muse_chat_status` | Safe, read-only | Optional `port`; returns watcher state, transport type, connection state, `canChat`, and a readiness reason when unavailable. It does not send a message. |
| `superagent_muse_chat` | Dangerous, opt-in | Required `text` (max 12,000 characters), optional `port`, optional `timeoutMs` (1,000-120,000; default 30,000). Returns only after a correlated Muse reply. |
| `superagent_telegram_send_to_muse` | Dangerous, opt-in | Required `text`. Reports Telegram acceptance only, not that Muse processed or answered the message. |
| `superagent_muse_tunnel_start` | Dangerous, opt-in | Optional `port`; starts the verified Muse WebSocket watcher and tunnel without exposing the WebSocket token. |
| `superagent_muse_tunnel_restart` | Dangerous, opt-in | Optional `port`; restarts only the verified Muse tunnel, never the MCP HTTP server. |

The MCP tool registry and its permission classifications are the source of truth. Disabled tools are filtered from discovery independently of dangerous-tool opt-in. Tool counts must be derived from the list of tools actually exposed to the selected client, not maintained as numeric constants.

### Correlated chat envelope

Direct chat uses the existing chat envelope with two correlation fields:

```typescript
interface ChatEnvelope {
  v: 1;
  kind: "chat";
  id?: string;        // Unique ID for this outgoing or response message
  reply_to?: string;  // Request ID being answered
  text: string;
}
```

The request receives a unique ID. Muse must respond with a new unique `id` and `reply_to` equal to the request ID. The watcher resolves only the matching pending request. Timeout, send failure, or WebSocket disconnect returns an error; it must not be reported as a successful conversation. Chat requests are not task execution requests; use the existing task envelope workflow when asking Muse to perform project work.

See [Muse MCP workflow examples](../mcp/muse-chat-workflows.md) for readiness checks, tunnel management, Telegram delivery, and direct chat examples.

---

## Automated Route Inventory

<!-- API_CATALOG_START -->
### 🌐 Superagent (Interactive Terminal AI Coding Assistant)

| Method | Endpoint Route | Auth Guard | Description | Source File |
|:---|:---|:---|:---|:---|

### 🌐 t-line (Desktop Client for Superagent)

| Method | Endpoint Route | Auth Guard | Description | Source File |
|:---|:---|:---|:---|:---|

<!-- API_CATALOG_END -->

