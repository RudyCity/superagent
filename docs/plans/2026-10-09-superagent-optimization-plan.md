# Superagent System Optimization Implementation Plan

> **For implementer:** Execute this plan to optimize Superagent across agent loops, token conservation, tool concurrency, startup latency, and browser automation.

**Goal:** Transform Superagent into a lean, highly efficient AI coding assistant that eliminates busy-polling loops, optimizes token usage, accelerates turn-level throughput with tool batching, and maximizes browser automation performance.

**Architecture:** 
- 3-Tier Multi-Agent Orchestration: Master Agent (orchestrator) → Superagent (worktree feature agent) → Subagent (ephemeral atomic worker).
- Turn & Loop Engine: Synchronous runtime awaits + reactive background wakeups instead of LLM busy-polling.
- Context Manager: Semantic boundary detection, model-specific token tracking, summarization, pinning, and non-destructive compaction.
- Chrome Automation: Dual-track architecture with native extension-free CDP (port 9222) and local OmniParser vision AI (port 9333).

---

## 1. Baseline & Optimization Principles

### The Core Anti-Patterns
1. **Busy Polling in LLM Loops**: Asking "is subagent done yet?" across multiple LLM turns wastes input/output tokens, causes latency spikes, and clutters chat history.
2. **Context Flooding**: Emitting raw HTML dumps, hundreds of unpruned element selectors, or reading 1000-line files in full without pagination.
3. **Sequential Tool Invocations**: Calling one read/write/replace tool per turn when 5 independent operations could be batched in a single turn.
4. **Startup Overhead**: Loading heavy machine learning weights, native modules, or checking system binaries on every single CLI invocation.

### Guiding Principles
- **Yield Over Poll**: If work is running in the background, pause the turn and let the runtime wake up the agent reactively.
- **Telegraphic & Compact Representation**: Never pass raw verbose objects when a compact token-efficient structure suffices.
- **Batching First**: Group independent actions into single-turn parallel calls.
- **Fast-Path Critical Path**: Keep startup time strictly sub-second via caching and dynamic imports.

---

## 2. Phase 1: Turn & Loop Optimization (Eliminating Busy Polling)

### Task 1.1: Enforce Synchronous Runtime Awaits
- **Implementation**:
  - In `src/core/tools/subagentTools.ts`, ensure `invoke_subagent` supports `wait: true` and `mode: "inline"`.
  - When `wait: true` is set, `invoke_subagent` halts tool execution at the Node.js Promise level (`await agentInstance.sendMessage(prompt)`).
  - The LLM does NOT make repeated turns while waiting; it yields until the subagent writes its final JSON report (`<id>_report.json`) or finishes.
- **Master Agent Level**:
  - The Master Agent uses `await_superagents` to poll active git worktrees at the Node.js process level (every 2 seconds) rather than prompting the LLM repeatedly.
- **Prompt Guidance**:
  - Update system prompts in `src/core/prompts.ts` and `src/core/config/base.ts`:
    - "NEVER poll status in a loop across turns."
    - "Use wait: true for blocking subagents or yield the turn in background mode."

### Task 1.2: Reactive Background Yield & Wakeup
- **Implementation**:
  - In background mode (`mode: "background"` or `wait: false`), the agent issues the spawn call and immediately yields its turn.
  - The runtime event listener listens for subagent completion and automatically injects a wake-up event into the conversation queue.
  - No intermediate "checking status" turns are generated.

---

## 3. Phase 2: Token Conservation & Context Hygiene

### Task 2.1: Compact Element Snapshots in Chrome CDP
- **Implementation**:
  - Default `control_chrome_cdp` snapshot action to `compact: true`.
  - Filter out decorative nodes, non-interactive wrappers, and long styling attributes.
  - Enforce `max_elements: 100` by default to prevent web pages with deep DOM trees from consuming thousands of tokens.
  - Provide `diff: true` snapshot option to return only elements that have changed since the previous snapshot.

### Task 2.2: Large File Inspection Pagination
- **Implementation**:
  - Files larger than 200 lines must be inspected using `offset` and `limit` in `read` or targeted pattern searches with `ripgrep_search`.
  - Ban dumping entire massive files into the prompt when diagnosing specific functions or line ranges.

### Task 2.3: Context Compaction Pipeline
- **Implementation**:
  - Enforce `TokenTracker` threshold triggers (e.g. 70% of context window limit).
  - Execute `SummarizationStrategy` to condense past conversational turns while preserving critical tool results.
  - Use `PinningStrategy` to lock architectural decisions, user requirements, and active plans from being pruned.
  - Apply `PruningStrategy` as an emergency fallback with summary preservation, guaranteeing zero silent context loss.

---

## 4. Phase 3: Tool Batching & Concurrency Optimization

### Task 3.1: Multi-Action Single-Turn Tool Calls
- **Implementation**:
  - Encourage models to emit multiple tool calls in a single response turn:
    - Multiple file reads via `read` with `filePaths: [...]`.
    - Multiple file writes via `write_to_file` with `files: [...]`.
    - Multiple replacements via `replace_file_content` with `edits: [...]`.
  - Batch subagent invocations: spawn researcher, coder, and reviewer subagents in the same turn when tasks are independent.

### Task 3.2: Subagent Isolation via File Scoping
- **Implementation**:
  - Always provide `fileScope: ["path/to/feature/**"]` when delegating tasks to subagents.
  - Prevent race conditions and write conflicts across parallel subagents by guaranteeing that no two subagents have overlapping write scopes.

---

## 5. Phase 4: Chrome Automation Architecture

### Task 5.1: Zero-Overhead Native CDP (Port 9222)
- **Implementation**:
  - Use `control_chrome_cdp` connecting to `127.0.0.1:9222` as the primary, default automation engine.
  - Keep persistent WebSocket connections open per tab, recycling existing sockets with CDP message ID multiplexing.
  - Auto-unthrottle background tabs via `/json/activate/<targetId>` so Chrome does not freeze timers or JavaScript evaluations.

### Task 5.2: On-Demand OmniParser Vision AI (Port 9333)
- **Implementation**:
  - Reserve `control_chrome_vision` for canvas-heavy applications, games, shadow-DOM elements, or obfuscated UI where CSS selectors and DOM snapshots are ineffective.
  - Auto-start the local Python OmniParser service (YOLOv8 + Florence-2) as a detached background daemon only when vision actions are invoked.
  - Check service readiness via `control_chrome_vision(command: 'status')` before sending screenshots.

---

## 6. Phase 5: Startup & Runtime Performance

### Task 6.1: Sub-Second Startup via Binary Caching
- **Implementation**:
  - Cache binary availability (bun, node, git, python, ripgrep) in `~/.superagent-r/system-cache.json` with a 24-hour TTL.
  - Avoid re-executing `which` or `where.exe` during startup unless the cache is missing or invalidated.

### Task 6.2: Lazy Module Loading
- **Implementation**:
  - Defer heavy native dependencies (e.g., ONNX runtime, vector memory embeddings, Florence-2 helpers) using dynamic `import()`.
  - Keep the CLI entry point (`src/cli.tsx`) lightweight so initial command rendering and banner display occur in under 300ms.

### Task 6.3: High-Performance SQLite History Storage
- **Implementation**:
  - Store all session messages and full-text search entries in `~/.superagent-r/history.db` using SQLite WAL mode.
  - Index conversation turns and tool executions for instant cross-session searches via `search_history`.

---

## 7. Verification & Benchmarking Checklist

- [ ] Subagent Turn Efficiency: Spawning subagents with `wait: true` results in exactly 1 tool turn on the parent agent rather than multiple polling turns.
- [ ] Token Footprint: DOM snapshots with `compact: true` consume under 800 tokens for average web pages (compared to >5000 tokens for raw snapshots).
- [ ] Startup Benchmark: Running `superagent --version` or launching CLI in quick mode finishes in under 500ms.
- [ ] Test Suite Integrity: All unit tests in `tests/` pass with zero failures (`bun test`).
- [ ] Build Cleanliness: `bun run build` completes with zero TypeScript diagnostics.
