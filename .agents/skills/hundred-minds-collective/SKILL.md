---
name: hundred-minds-collective
description: >-
  Triggered when the agent needs to solve complex, multi-faceted problems by simulating the collective intelligence of 100 specialized minds divided into 6 functional teams (Strategy, Domain Experts, Red Team, Empirical Testers, Consensus Council, and Execution Ops) within a single agent session.
---

# Hundred-Minds Collective (100-Expert Hivemind in 1 Agent)

Enables a **single AI agent** to think, analyze, and solve complex system-wide problems with the cognitive throughput, perspective diversity, and peer-review density equivalent to **100 domain experts** organized into specialized functional committees, without spawning cost-prohibitive subagents or wasting tokens.

---

## When to Use This Skill

- Trigger keywords: "100 minds", "think like 100 people", "collective team", "multi-team reasoning", "collective intelligence", "100 experts", "hivemind reasoning".
- When facing complex, ambiguous, or high-risk architectural and technical challenges.
- When requiring 360-degree evaluation across security, performance, UX, maintainability, and edge cases.
- When eliminating blind spots and AI hallucinations through rigorous internal Red Teaming.

---

## 100-Mind Team Specialization Matrix

The 100 virtual minds are structured into 6 distinct functional committees:

| Team | Committee Name | Headcount | Primary Role & Domain Focus |
|---|---|---|---|
| **Team 1** | **Strategic Vision & Architecture** | 15 Experts | Macro architecture design, long-term scalability, design patterns, and system cohesion. |
| **Team 2** | **Domain & Subject Matter Experts** | 30 Experts | Code specialization, business logic, algorithms, databases, API contracts, and deep technical optimizations. |
| **Team 3** | **Red Team & Adversarial Skeptics** | 20 Experts | Devil's advocates, security auditors, edge-case hunters, unhandled exception stress-testers, and assumption busters. |
| **Team 4** | **Empirical & Runtime Data Validators** | 15 Experts | Reality grounders, log analysis, type checks, runtime benchmarking, and empirical evidence verifiers. |
| **Team 5** | **Synthesis & Consensus Council** | 10 Experts | Master integrators, trade-off negotiators, conflict resolution, and final consensus builders. |
| **Team 6** | **Lean Execution & Pragmatism Ops** | 10 Experts | Complexity reduction, `pragmatic-minimalism` guardians, and actionable execution planning. |

---

## 5-Phase Collective Reasoning Workflow

The agent executes 5 dense, sequential cognitive phases within a single reasoning pass:

```text
[Input Problem / Task]
          │
          ▼
    ┌───────────┐      ┌───────────┐      ┌───────────┐
    │  Phase 1  │ ───► │  Phase 2  │ ───► │  Phase 3  │
    │Decompose  │      │Deliberate │      │Red Team   │
    └───────────┘      └───────────┘      └───────────┘
                                                │
                                                ▼
                       ┌───────────┐      ┌───────────┐
                       │  Phase 5  │ ◄─── │  Phase 4  │
                       │ Blueprint │      │ Consensus │
                       └───────────┘      └───────────┘
```

### Phase 1: Problem Decomposition & Team Matrix Mapping
- Deconstruct the root problem into underlying sub-problems.
- Map problem dimensions to the 6 specialized team domains.

### Phase 2: Parallel Multi-Perspective Deliberation
- Team 1 (Strategy) and Team 2 (Tech Experts) formulate initial hypotheses and architectural solutions from their specialized domains.
- Proposals are attributed to specific expert lenses (e.g., `[Team 1-Arch]`, `[Team 2-Perf]`).

### Phase 3: Adversarial Red Teaming & Stress Testing
- Team 3 (Red Team) attacks Phase 2 proposals with critical scrutiny and worst-case scenarios:
  - *"How does this perform under high concurrency or race conditions?"*
  - *"Does this approach introduce unnecessary complexity violating `pragmatic-minimalism`?"*
  - *"What edge cases were missed by Teams 1 & 2?"*
- Team 4 (Empirical Validators) verifies facts against codebase logs, types, and runtime constraints to ensure critiques are grounded in empirical evidence.

### Phase 4: Consensus Synthesis & Trade-Off Resolution
- Team 5 (Consensus Council) filters out fragile ideas, resolves conflicting team perspectives, and synthesizes a hardened, battle-tested solution.

### Phase 5: Lean Execution Blueprint
- Team 6 (Execution Ops) strips away fluff and distills the consensus into a lean, minimal, and immediate action blueprint (target files, exact diffs, or commands).

---

## Standard Output Formats

When active, the agent presents the 100-mind deliberation in a compact, token-efficient structure:

### 1. Hivemind Deliberation Summary
```markdown
### 👥 Collective Mind Deliberation (100 Minds / 6 Teams)

- **[Team 1 & 2 - Proposed Solution]**: [Architectural approach & core technical logic]
- **[Team 3 - Red Team Attack]**: [Critical vulnerabilities, edge cases, & flaw analysis]
- **[Team 4 - Empirical Grounding]**: [Codebase facts, log evidence, or type system verifications]
- **[Team 5 - Consensus Council]**: [Unified consensus & trade-off decisions]
```

### 2. Lean Execution Matrix (Team 6 Ops)
```markdown
| Target File / Task | Responsible Team | Actions / Modifications | Risk Level |
|---|---|---|---|
| `d:/.../file.ts` | Team 2 & Team 6 | [Minimalist, precise changes] | Low |
```

---

## Core Invariant Rules

1. **Anti-Hallucination via Red Teaming**: Proposals from Teams 1 & 2 **must** be challenged by Teams 3 & 4 before approval.
2. **Pragmatic Veto Power**: Team 6 holds veto power over any over-engineered or excessively bloated solution.
3. **Symbolic Aggregation**: Do not output lengthy individual prose for all 100 people. Aggregate insights through the 6 specialized committees for maximum density and speed.
