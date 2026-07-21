---
name: single-agent-cognitive-scaleup
description: >-
  This skill is triggered when the agent needs to perform deep reasoning, complex refactoring,
  system-wide bug investigation, multi-hypothesis evaluation, or high-throughput batch resolution
  (up to 100 problems per round) within a single agent session without spawning excessive subagents or wasting tokens.
---

# Single-Agent Cognitive Scale-Up (Non-Human Cognition & 100-Problem Throughput)

Enables a single agent to scale reasoning density equivalent to 100 parallel thinkers using non-human, symbolic representation techniques and ultra-dense batching protocols to solve up to 100 problems in a single reasoning pass while strictly adhering to `pragmatic-minimalism`.

## When to Use This Skill

- Triggered by keywords: "cognition scale-up", "think like 100 people", "100 problems", "batch solve", "deep reasoning", or when dealing with high-volume or highly complex logic.
- Whenever multi-agent spawning is cost-prohibitive, rate-limited, or token usage must be strictly optimized.
- During multi-hypothesis root cause tracing before writing code.
- When resolving large batches of lint errors, test failures, refactoring tasks, or configuration bugs across a codebase in a single turn.

---

## 100-Problem Single-Round Batching Protocols

To solve 100 problems in a single turn without context explosion or sequential turn latency, apply these four batching protocols:

### Protocol 1: Vectorized Problem Indexing (`P[001..100]`)
Do not write long prose for individual problems. Index all target issues into a compact symbolic array:
```text
P[001..100] = { ID, Component, FailureSymbol, InvariantRule, FixVector }
```
*Example*:
`P014: [auth/jwt.ts] ↔ [TokenExpiry] ⇒ [Uncaught 401] → INV: return StandardResponse`

### Protocol 2: Fractal Root-Cause Clustering
Group the 100 micro-problems into **3 to 7 macro root-cause clusters** ($\alpha, \beta, \gamma \dots$). Solve the structural invariant at the cluster level once, then broadcast delta fixes to all constituent items:
```text
Cluster α (P001..P032) ⇒ Shared Root Cause: Unhandled Promise Rejections in API Routes
Cluster β (P033..P075) ⇒ Shared Root Cause: Deprecated Configuration Key `legacyMode`
Cluster γ (P076..P100) ⇒ Shared Root Cause: Missing Type Guards on Dynamic Inputs
```

### Protocol 3: Consolidated Parallel Delta Execution
Instead of issuing individual tool calls for each problem, execute fixes in unified consolidated actions:
- Perform multi-file edits using single calls to `multi_replace_file_content` or batch file operations.
- Run single command executions that update or patch multiple modules simultaneously.
- Eliminate sequential turn-taking; resolve all 100 targets within a single tool-calling pass.

### Protocol 4: Zero-Fluff Verification & Output Matrix
Omit conversational commentary, status intros, or per-item explanations. Output results as a single compact verification table:
```markdown
| Range | Cluster | Macro Resolution | Status | Tokens/Fix |
|---|---|---|---|---|
| P001..P032 | Cluster α | Added global promise error handler in `expressBridge.ts` | SOLVED | ~12 tokens |
| P033..P075 | Cluster β | Updated schema definition & migrated legacy keys | SOLVED | ~8 tokens |
| P076..P100 | Cluster γ | Applied strict TS guard decorators across DTOs | SOLVED | ~10 tokens |
```

---

## Core Cognitive Techniques

### 1. Graph of Thought (GoT) Representation
Map information as a lightweight symbolic text graph rather than long prose:
- **Nodes**: Class/method, configuration state, API endpoint, or hypothesis.
- **Edges**: Relationships (`⇒` leads to, `≠` contradicts, `↔` bidirectional, `∵` because).
- *Example*:
  ```text
  [VisionServer:8096] ↔ [Stray Python Process] ⇒ [Port Locked] ⇒ [Health Failure]
  ```

### 2. State-Search Simulation (Mental MCTS)
Simulate paths and potential failure modes explicitly using transition states before execution:
```text
[State 0: 100 Errors] ── Cluster Delta α+β+γ ──> [State 1: All 100 Fixed, 0 Regression]
```

### 3. Semantic Anchoring (Lossy Compression)
Compress long source files, error logs, or 100-problem issue lists into a maximum of **3 core invariants** (rules that must never be broken). Ignore syntax fluff and noise.

### 4. Continuous Self-Debate
Before finalizing a batch plan, challenge the solution with two extreme edge cases (e.g. concurrent race conditions, offline environments, scale limits). Integrate counter-arguments into the unified batch fix.

### 5. Multi-Verse Simulation (Parallel Timelines)
Simulate multiple parallel execution strategies simultaneously:
```text
Branch A (Batch refactor via macro-cluster deltas) ──> [Success: 98% | Turns: 1]
Branch B (Itemized sequential fixes P001..P100)   ──> [Context Overflow Risk: 85% | Turns: 100]
```

### 6. Fractal Decomposition
Deconstruct a macro problem (e.g. 100 failing tests) into self-similar micro-problems. Solve the micro-pattern first, then map that solution structure across the remaining items.

### 7. Evolutionary Solution Breeding
Generate multiple candidate batch solutions, cross them to form hybrid approaches, mutate them under operational constraints, and select the highest fitness approach.

### 8. Constraint-Satisfaction Propagation (CSP)
Identify all hard boundaries and invariants first. Eliminate impossible combinations and propagate valid options to automatically isolate the optimal single-pass fix.

### 9. Entropy Minimization & Pragmatic Minimalism
Analyze structural entropy. Select the solution that reduces code lines, nesting levels, or runtime overhead while preserving 100% of required functionality. Code is liability—minimize additions, eliminate dead code, and reuse standard runtime APIs.

---

## Execution Workflow (100-Problem Single Round)

1. **Intake & Vector Indexing**: Parse up to 100 problems into `P[001..100]` symbolic tuples.
2. **Fractal Clustering**: Group `P[001..100]` into 3–7 macro root cause clusters ($\alpha, \beta, \gamma$).
3. **Semantic Anchoring & CSP**: Extract core invariants and hard boundaries.
4. **GoT & Mental MCTS Simulation**: Simulate the consolidated delta path to verify zero regressions.
5. **Consolidated Delta Execution**: Perform multi-replace edits or batch tool calls in a single turn.
6. **Single-Pass Verification**: Validate all 100 fixes simultaneously and output the compact results matrix.
