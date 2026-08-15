# 04. Features & Core Workflows

This document provides detailed sequence diagrams and workflow logic for the primary capabilities of Superagent.

---

## 1. 3-Tier Multi-Agent Orchestration Flow

When a complex feature request is received in multi-agent mode, the Master Agent decomposes the goal, provisions isolated Superagents in git worktrees, collects atomic subagent reports, and merges the verified code.

```mermaid
sequenceDiagram
    autonumber
    actor User as Developer / User
    participant CLI as Terminal / React Ink UI
    participant Master as Master Agent (Tier 1)
    participant Context as Context Manager
    participant DB as SQLite history.db
    participant Super as Superagent (Tier 2 Worktree)
    participant Sub as Ephemeral Subagent (Tier 3)

    User->>CLI: "Implement user authentication with JWT"
    CLI->>DB: Save User Turn to SQLite
    CLI->>Master: Process Turn with Active Provider
    Master->>Context: Verify Token Budget
    Context-->>Master: Token Count OK (12,400 / 200,000)

    Master->>Master: Formulate Plan (Feature: auth-jwt)
    Master->>Super: invokeSuperagentTool(featureName: "auth-jwt")
    Note over Super: Creates worktree at ~/.superagent-r/worktrees/auth-jwt<br/>Checks out branch feature/auth-jwt

    Super->>Sub: invokeSubagentTool(type: "researcher", task: "Locate auth entrypoints")
    Sub-->>Super: Report: Found src/routes/auth.ts and src/core/auth/
    
    Super->>Sub: invokeSubagentTool(type: "coder", task: "Write JWT signing middleware")
    Sub-->>Super: Written src/core/auth/jwt.ts & updated routes
    
    Super->>Sub: invokeSubagentTool(type: "software-tester", task: "Run vitest on auth suite")
    Sub-->>Super: Tests Passed: 8 passed, 0 failed

    Super-->>Master: Execution Report: auth-jwt Ready & Verified
    Master->>Master: mergeSuperagentsTool(featureName: "auth-jwt")
    Note over Master: Merges feature/auth-jwt into main repo branch<br/>Cleans worktree
    Master->>DB: Save Assistant Summary & Artifacts
    Master-->>CLI: Render Cyberpunk Completion Card
    CLI-->>User: "JWT authentication implemented and verified."
```

---

## 2. Context Window Compaction & Semantic Pruning

Superagent continuously monitors prompt and completion tokens. When token usage exceeds 80% of the active model's context window limit, the system executes an automated compaction pipeline.

```mermaid
sequenceDiagram
    autonumber
    participant Engine as Execution Engine
    participant CM as ContextManager
    participant TT as TokenTracker (tiktoken)
    participant LLM as Provider Model
    participant DB as SQLite history.db

    Engine->>CM: preparePrompt(messages)
    CM->>TT: countTokens(messages)
    TT-->>CM: 168,000 tokens (>80% of 200k limit)

    Note over CM: Trigger Compaction Pipeline
    CM->>DB: Fetch is_pinned messages
    Note over CM: Pinned architectural specs and core constraints are preserved
    
    CM->>LLM: Request Semantic Summarization of unpinned dialogue
    LLM-->>CM: Condensed 500-token Structured Architecture Summary
    
    CM->>CM: Replace unpinned turns with Summary Marker
    CM->>DB: Flag original messages with is_compacted = 1
    CM->>DB: Store updated token counts
    
    CM->>TT: recomputeTokens(compactedMessages)
    TT-->>CM: New Token Count: 18,200 tokens
    CM-->>Engine: Compacted Context Window Ready
```

---

## 3. Remote Browser Control via Serverless WebSocket Bridge

Superagent can inspect web applications, take screenshots, and interact with the DOM using any existing Chrome profile without launching automated browser processes like Puppeteer.

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant Agent as Superagent / Chrome Subagent
    participant Bridge as WebSocket Bridge (Port 9223)
    participant Ext as Chrome Remote Extension (MV3)
    participant Chrome as Chrome Browser Tab

    Dev->>Agent: "Inspect login page at localhost:5173"
    Agent->>Bridge: Send Action: get_tabs
    Bridge->>Ext: Dispatch { action: "get_tabs" }
    Ext->>Chrome: chrome.tabs.query()
    Chrome-->>Ext: [{ id: 101, url: "http://localhost:5173/login" }]
    Ext-->>Bridge: Tabs List
    Bridge-->>Agent: Tab 101 Found

    Agent->>Bridge: Send Action: screenshot { tabId: 101 }
    Bridge->>Ext: Dispatch { action: "screenshot", tabId: 101 }
    Ext->>Chrome: chrome.tabs.captureVisibleTab()
    Chrome-->>Ext: Base64 PNG Image
    Ext-->>Bridge: Payload with screenshot
    Bridge-->>Agent: Render Visual Inspection Artifact
```

---

## 4. Session Persistence & Cross-Session Search

1. **SQLite Single Source of Truth**:
   - Every user input, assistant streaming block, and tool execution is atomically committed to `~/.superagent-r/history.db`.
   - The `.json` files in `~/.superagent-r/history/<mode>/<sessionId>/sess_*.json` act as structural key references and do not store transcript contents.
2. **FTS5 Full-Text Search**:
   - Running `/history <query>` executes a BM25-ranked full-text search across all past sessions.
   - Code snippets, error messages, and tool invocations from previous days or weeks can be loaded back into the active context window.
