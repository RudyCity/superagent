# Agent Client Protocol (ACP) Integration Guide

This guide describes the **Agent Client Protocol (ACP v1.0.0)** implementation connecting **T-Line Desktop** and external code editors (Zed, VS Code, JetBrains) with **Superagent Core**.

---

## 1. Overview & Architecture

**Agent Client Protocol (ACP)** is an open, standard protocol based on **JSON-RPC 2.0** that standardizes communication between an editor/desktop client (the **Host**) and an autonomous AI coding assistant (the **Agent**).

Just as the **Language Server Protocol (LSP)** decouples language compilers/linters from editors, ACP decouples AI coding agents from specific UI implementations.

```
┌────────────────────────────────────────────────────────┐
│               T-LINE DESKTOP / CODE EDITOR             │
│                      [ACP Host / Client]               │
│  - SuperAgentAcpClient & WebSocket Bridge Adapter      │
│  - Thought Stream (Chain-of-Thought UI)                │
│  - Tool Cards & Interactive Permission Modals          │
└───────────────────────────┬────────────────────────────┘
                            │
               Bidirectional JSON-RPC 2.0
               Line-Delimited over stdio or HTTP/SSE
                            │
┌───────────────────────────▼────────────────────────────┐
│                    SUPERAGENT CORE                     │
│                     [ACP Server / Agent]               │
│  - AcpServer Transport Dispatcher                      │
│  - AcpRuntime (ContextManager & Agent Loop)            │
│  - ToolExecutor & MCP Tools Engine                     │
└────────────────────────────────────────────────────────┘
```

---

## 2. Wire Format & Transports

Messages are serialized as newline-delimited (`\n`) JSON-RPC 2.0 strings.

### Supported Transports:
1. **Stdio Subprocess (Primary Desktop Integration)**:
   - Launched by T-Line via: `superagent --acp -w <workspacePath>`
   - Input: `process.stdin`
   - Output: `process.stdout`
2. **HTTP & Server-Sent Events (Remote / Network Access)**:
   - Commands: `POST /api/acp` (Inbound RPC requests)
   - Notifications Stream: `GET /api/acp/stream` (SSE text/event-stream)

---

## 3. Protocol Methods & Payloads

### A. Connection Handshake (`initialize`)
**Client $\rightarrow$ Agent Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "1.0.0",
    "clientInfo": { "name": "tline-desktop", "version": "1.3.752" },
    "capabilities": {
      "streaming": true,
      "diffInspection": true,
      "interactivePermissions": true
    },
    "workspace": { "workspacePath": "D:/projects/my-app" }
  }
}
```

**Agent $\rightarrow$ Client Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "1.0.0",
    "agentInfo": { "name": "superagent-core", "version": "1.14.107" },
    "capabilities": {
      "promptStreaming": true,
      "toolExecution": true,
      "multiTierAgents": true,
      "permissionEscalation": true
    },
    "supportedMethods": [
      "initialize",
      "session/new",
      "session/prompt",
      "session/cancel",
      "session/request_permission"
    ]
  }
}
```

---

### B. Session Lifecycle (`session/new`, `session/prompt`, `session/cancel`)

#### 1. Creating a Session (`session/new`)
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "workspacePath": "D:/projects/my-app",
    "clientMode": "tline"
  }
}
```

#### 2. Sending a Prompt (`session/prompt`)
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_1732174800_abc123",
    "prompt": "Implement user authentication with JWT"
  }
}
```

---

### C. Streaming Notifications (`session/update`)

The agent streams updates to the client via one-way notifications:

#### 1. Thought Stream (Chain-of-Thought Reasoning)
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_1732174800_abc123",
    "seq": 10,
    "timestamp": 1732174805123,
    "update": {
      "kind": "thought_chunk",
      "delta": "Analyzing auth middleware and JWT library dependencies..."
    }
  }
}
```

#### 2. Text Stream (Final Answer Deltas)
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_1732174800_abc123",
    "seq": 11,
    "timestamp": 1732174805456,
    "update": {
      "kind": "text_chunk",
      "delta": "Here is the authentication flow..."
    }
  }
}
```

#### 3. Tool Execution Tracking
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_1732174800_abc123",
    "seq": 12,
    "timestamp": 1732174806000,
    "update": {
      "kind": "tool_call_start",
      "callId": "call_write_auth",
      "tool": "write_file",
      "actor": "agent",
      "description": "Write auth middleware to src/middleware/auth.ts"
    }
  }
}
```

---

### D. Human-in-the-Loop Permissions (`session/request_permission`)

When Superagent encounters a high-risk tool (file write or shell command), it sends a reverse request to the client:

**Agent $\rightarrow$ Client Request:**
```json
{
  "jsonrpc": "2.0",
  "id": "rpc_perm_101",
  "method": "session/request_permission",
  "params": {
    "permissionId": "perm_write_auth_01",
    "sessionId": "sess_1732174800_abc123",
    "workspacePath": "D:/projects/my-app",
    "action": "file_write",
    "target": "src/middleware/auth.ts",
    "description": "Create new authentication middleware file",
    "riskLevel": "medium",
    "expiresInMs": 60000
  }
}
```

**Client $\rightarrow$ Agent Response:**
```json
{
  "jsonrpc": "2.0",
  "id": "rpc_perm_101",
  "result": {
    "decision": "approved",
    "decidedAt": 1732174809000
  }
}
```

---

## 4. T-Line Desktop Integration Architecture

In T-Line:
1. **`SuperAgentAcpClient`** (`backend/src/superAgentAcpClient.ts`):
   Spawns `superagent --acp -w <path>` with `stdio: ['pipe', 'pipe', 'pipe']`.
2. **`SuperAgentAcpBridgeAdapter`** (`backend/src/superAgentAcpBridgeAdapter.ts`):
   Binds WebSocket clients from T-Line frontend UI to the ACP client, translating between WebSocket packets and JSON-RPC messages.
3. **`superAgentRuntime.ts`**:
   `selectSuperAgentLaunch(dir, 'acp')` automatically builds the launch command using `--acp`.
