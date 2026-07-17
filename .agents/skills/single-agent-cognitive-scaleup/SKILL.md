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

### 5. Multi-Verse Simulation (Parallel Timelines)

Simulate multiple parallel alternatives of execution and downstream side effects simultaneously:
```text
Branch A (Safe, low footprint) ──> [Success: 95%]
Branch B (Performant, high risk) ──> [Race Condition: 40% risk] ──> [Rollback Plan]
```

### 6. Fractal Decomposition

Deconstruct a macro problem into self-similar micro-problems. Solve the micro-problem first, then map that solution structure to resolve the larger system-wide architecture.

### 7. Evolutionary Solution Breeding

Generate multiple solution candidates (seeds), cross them to form hybrid approaches, mutate them with extreme operational constraints, and evaluate which solution has the highest survival/fitness score.

### 8. Constraint-Satisfaction Propagation (CSP)

Identify all hard constraints and invariants (boundaries that cannot be crossed) first. Eliminate impossible combinations and propagate valid options to automatically narrow down to the optimal solution.

### 9. Entropy Minimization (Complexity Reduction)

Analyze the system's structural entropy. Target and execute the solution that reduces code lines, nesting levels, or runtime overhead while preserving 100% of the required functionality.

## Execution Workflow

1. **Compression**: Reduce target codebase files down to core invariants (Semantic Anchoring).
2. **Decomposition**: Break complex macro tasks into micro-problems (Fractal Decomposition).
3. **Constraint Mapping**: Establish all invariants and hard boundaries (CSP).
4. **Graphing & Simulation**: Write a quick node-edge map and simulate parallel branches (GoT, Multi-Verse, Mental MCTS).
5. **Breeding & Debate**: Breed the candidate solutions, subject them to self-debate against edge cases, and select the survivor (Evolutionary Breeding, Self-Debate).
6. **Selection**: Execute the path that minimizes complexity and structural entropy (Entropy Minimization).

