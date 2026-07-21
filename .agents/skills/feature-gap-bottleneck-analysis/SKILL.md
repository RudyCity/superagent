---
name: feature-gap-bottleneck-analysis
description: >-
  Triggered when the agent needs to audit, discover, and resolve missing features, architectural or functional gaps,
  performance/process bottlenecks, and structural complexity liabilities across a codebase, delivering lean and pragmatic improvement blueprints.
---

# Feature, Gap & Bottleneck Analysis (`feature-gap-bottleneck-analysis`)

Combines **Single-Agent Cognitive Scale-Up** (high-density batch scanning, symbolic indexing, fractal clustering) with **Pragmatic Minimalism** (lean solutions, liability reduction, zero unnecessary abstractions) to audit codebases for missing capabilities, structural gaps, performance bottlenecks, and system friction—followed by concrete, high-ROI improvement blueprints.

---

## When to Use This Skill

- Triggered by keywords or user intent:
  - **English**: "missing feature", "feature gap", "gap analysis", "find bottlenecks", "system bottleneck", "performance gap", "architectural gap", "audit codebase gaps", "system audit", "improvement suggestions".
  - **Indonesian**: "missing fitur", "fitur hilang", "fitur terlewat", "analisis gap", "analisis bottleneck", "temukan bottleneck", "saran perbaikan", "penambahan fitur", "peningkatan sistem".
- When conducting system health checks, pre-refactor audits, or technical debt assessments.
- When reviewing a module/workspace for missing edge-case handling, incomplete user flows, or latent performance limiters.

---

## Core Principles

1. **High-Density Vector Indexing (`G[001..N]`)**: Map all discovered issues into compact symbolic representations rather than verbose prose.
2. **Fractal Clustering ($\alpha, \beta, \gamma, \delta$)**: Group micro-gaps into macro structural categories to solve systemic root causes rather than patching symptoms.
3. **Pragmatic ROI Filtering**: Evaluate all potential additions/enhancements using the **Impact vs. Complexity** matrix. Reject speculative or over-engineered suggestions.
4. **Code is Liability**: Prefer solution vectors that delete redundant code, recycle existing helpers, or leverage standard/native APIs over introducing new dependencies or heavy layers.

---

## Execution Workflow

```
[Target Codebase / Feature Scope]
              │
              ▼
  Phase 1: Vector Indexing G[001..N] (High-Density Scanning)
              │
              ▼
  Phase 2: Fractal Category Clustering (α, β, γ, δ)
              │
              ▼
  Phase 3: Pragmatic ROI Filter (Impact vs Complexity Matrix)
              │
              ▼
  Phase 4: Actionable Resolution Vectors (Lean Patch Blueprints)
```

---

### Phase 1: High-Density Diagnostic Scanning (`G[001..N]`)

Scan the target scope (code files, routing, state management, API routes, configurations) and convert each finding into a vectorized symbolic index:

```text
G[001..N] = { ID, FileLocation, IssueType, InvariantBreach, Symptom }
```

*Example Indexing*:
- `G001: [routes/user.ts:L42] ↔ [Missing Validation] ⇒ [Invalid Payload crash] → TYPE: Gap`
- `G002: [services/sync.ts:L115] ↔ [Sequential Await Loop] ⇒ [High Latency] → TYPE: Bottleneck`
- `G003: [components/Chat.tsx] ↔ [No Retry on Websocket Disconnect] ⇒ [Stale UI State] → TYPE: MissingFeature`

---

### Phase 2: Fractal Category Clustering

Group all `G[001..N]` micro-findings into **4 Macro Root Cause Clusters**:

| Cluster | Category | Focus Area | Example Symptoms |
|---|---|---|---|
| **Cluster $\alpha$** | **Missing Features & Incomplete Flows** | Missing API capabilities, unhandled user intents, incomplete lifecycle events, missing UI states (empty/loading/error). | No pagination on list endpoint, missing session resume feature. |
| **Cluster $\beta$** | **Architectural & Security Gaps** | Type safety holes, unhandled edge cases, race conditions, missing input bounds, broken authorization checks. | Missing payload schema validation, uncaught promise rejection in background job. |
| **Cluster $\gamma$** | **Performance & Resource Bottlenecks** | Blocking sync execution, redundant DB/network calls, memory leaks, unindexed queries, expensive re-renders. | Sequential `await` in `Array.map`, unthrottled search handler. |
| **Cluster $\delta$** | **Complexity & Maintainability Liabilities** | Over-engineered layers, duplicate utility functions, dead code, single-caller abstractions, tight coupling. | Custom HTTP wrapper replacing standard `fetch`, 1500-line bloated router file. |

---

### Phase 3: Pragmatic ROI Filter Matrix

Filter every proposed improvement through the **Pragmatic ROI Grid** before presenting recommendations:

```
                  High Impact
                      │
     [QUICK WIN]      │    [CORE REFACTOR]
     High Value,      │    High Value,
     Low Complexity   │    Medium/High Effort
──────────────────────┼──────────────────────
     [DISCARD]        │    [DEFER / AVOID]
     Low Value,       │    Low Value,
     Low Complexity   │    High Complexity (Over-engineering)
                      │
                  Low Impact
  Low Complexity ────────────── High Complexity
```

- **Include**: Quick Wins & Core Refactors.
- **Reject / Exclude**: Low-impact over-engineering, speculative abstractions, or installing heavy third-party libraries when built-in runtime APIs suffice.

---

### Phase 4: Output & Actionable Resolution Vectors

Present the analysis using a **Zero-Fluff Findings Matrix** followed by **Pragmatic Improvement Blueprints**.

#### 1. Discovered Gaps & Bottlenecks Matrix

```markdown
| Index | Category | Target File / Location | Issue Description | Impact / Priority |
|---|---|---|---|---|
| G001 | Cluster α (Missing Feature) | `backend/src/user.ts:L42` | Missing pagination & field filtering on list API | High (Quick Win) |
| G002 | Cluster β (Arch Gap) | `backend/src/bridge.ts:L88` | Unhandled WebSocket ECONNRESET crashes process | Critical (Core Refactor) |
| G003 | Cluster γ (Bottleneck) | `frontend/src/Feed.tsx:L12` | Un-memoized item list triggers full UI re-renders | Med (Quick Win) |
| G004 | Cluster δ (Liability) | `backend/src/utils.ts:L100` | Custom 200-line string parser replacing `URLSearchParams` | Med (Cleanup) |
```

#### 2. Pragmatic Improvement Blueprints

For each high-priority cluster/index, provide lean, actionable improvement blueprints:

```markdown
### Blueprint 1: [G001] Add Lean Pagination & Filtering
- **Target**: `[user.ts](file:///d:/path/to/user.ts#L42-L60)`
- **Problem**: Large payloads cause high latency and memory spikes.
- **Pragmatic Solution**: Leverage native SQL `LIMIT/OFFSET` or query param parsing with zero extra packages.
- **Delta Vector**:
  ```diff
  - const users = await db.query('SELECT * FROM users');
  + const limit = Math.min(Number(req.query.limit) || 20, 100);
  + const offset = Number(req.query.offset) || 0;
  + const users = await db.query('SELECT * FROM users LIMIT ? OFFSET ?', [limit, offset]);
  ```
- **Verification**: Test API with `?limit=10&offset=0`.
```

---

## Quick Diagnostic Checklist

When running this skill, answer these 5 diagnostic questions:
1. **Feature Check**: What logical user flow or system interaction ends abruptly without resolution?
2. **Robustness Check**: Where does the application crash when given unexpected or missing inputs?
3. **Bottleneck Check**: Where is execution synchronously blocked waiting on sequential I/O or heavy loops?
4. **Complexity Check**: What custom hand-rolled code can be replaced by built-in runtime/platform APIs?
5. **Liability Check**: Which files exceed length/complexity bounds (>500 lines or high nesting) and need modular splitting?
