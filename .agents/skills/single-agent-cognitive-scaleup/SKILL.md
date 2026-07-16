---
name: single-agent-cognitive-scaleup
description: >-
  This skill is triggered when the agent needs to perform deep reasoning, complex refactoring,
  system-wide bug investigation, or multi-hypothesis evaluation within a single agent session
  without spawning excessive subagents or wasting tokens.
---

# Single-Agent Cognitive Scale-Up (Non-Human Cognition)

Enables a single agent to scale reasoning density equivalent to 100 parallel thinkers using non-human, symbolic representation techniques within a single reasoning pass.

## When to Use This Skill

- Triggered by keyword "cognition scale-up", "think like 100 people", "deep reasoning", or when dealing with highly complex logic.
- Whenever multi-agent spawning is cost-prohibitive, rate-limited, or token usage must be strictly optimized.
- During multi-hypothesis root cause tracing before writing code.

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
[State 0: Bug] ── Action A ──> [State 1: Fixed, but blocks parallel port]
[State 0: Bug] ── Action B ──> [State 2: Clean kill + Fixed, fully verified]
```

### 3. Semantic Anchoring (Lossy Compression)

Compress long source files, error logs, or requirements documents into a maximum of 3 core invariants (rules that must never be broken). Ignore syntax fluff and noise.

### 4. Continuous Self-Debate

Before finalizing a plan, challenge the first assumption with two extreme edge cases (e.g. concurrent race conditions, offline environments). Integrate the counter-arguments into the final implementation.

## Execution Workflow

1. **Compression**: Reduce target codebase files down to core invariants.
2. **Graphing**: Write a quick node-edge relationship map of the problem area.
3. **Simulation**: Trace two or three paths using State-Search notation.
4. **Selection**: Execute the path that survives self-debate.
