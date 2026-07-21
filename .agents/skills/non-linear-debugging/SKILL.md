---
name: non-linear-debugging
description: >-
  Triggered when the agent needs to debug complex errors, analyze obscure runtime failures, find subtle bugs, or trace system anomalies using non-linear, multidimensional hypothesis graphs, backward-forward triangulation, behavioral state inversion, and dynamic perturbation instead of slow sequential linear step-by-step debugging.
---

# Non-Linear Debugging & Bug Discovery Engine

Enables the AI agent to systematically diagnose, analyze, and resolve complex software errors, obscure bugs, race conditions, memory/state leaks, and system anomalies using **non-linear, graph-based cognitive methodologies** instead of sequential, line-by-line debugging.

---

## When to Use This Skill

- Trigger keywords: "non-linear debug", "debug error", "analyze error", "find bug", "cari bug", "investigasi error", "non linear bug finding", "root cause triangulation", "complex failure analysis".
- When a bug involves asynchronous event loops, multi-service communication (e.g. t-line ↔ SuperAgent bridge), race conditions, state synchronization mismatches, or multi-component failure cascades.
- When traditional step-by-step linear tracing fails or is too slow due to missing or noisy error logs.
- When facing ambiguous symptoms where multiple independent factors might be interacting.

---

## Core Non-Linear Debugging Paradigms

```text
               ┌───────────────────────────────────────┐
               │    Forward Tracing (Source ──►)      │
               └───────────────────┬───────────────────┘
                                   │
                                   ▼
┌──────────────────┐    ┌─────────────────────┐    ┌──────────────────┐
│ Hypothesis H₁    │───►│   COLLISION NODE    │◄───│ Hypothesis H₃    │
│ (State / Timing) │    │   (Root Cause Δ)    │    │ (Config / IPC)   │
└──────────────────┘    └─────────────────────┘    └──────────────────┘
                                   ▲
                                   │
               ┌───────────────────┴───────────────────┐
               │    Backward Tracing (◄── Sink/Crash) │
               └───────────────────────────────────────┘
```

### 1. Bidirectional Cause-Effect Triangulation (Backward-Forward Tracing)
- **Backward Tracing ($\leftarrow \text{Crash Sink}$)**: Trace upstream from where the exception is thrown, state is mutated, or process crashes.
- **Forward Tracing ($\text{Input Source} \rightarrow$)**: Trace downstream from initial request, user trigger, or state payload entry.
- **Collision Node Identification ($\otimes$)**: Identify the exact intersection node where valid forward state violates backward invariants.

### 2. Multi-Hypothesis Superposition ($H_{1..N}$)
Simultaneously evaluate multiple orthogonal root-cause hypotheses in parallel rather than sequentially testing one by one:
- **$H_{\text{Lifecycle}}$**: Process startup, race conditions, port binding, auto-restart loops.
- **$H_{\text{State/Contract}}$**: Unhandled promise rejections, type mismatch, null dereference, stale cache.
- **$H_{\text{Transport/IPC}}$**: Socket disconnect, HTTP proxy timeout, payload serialization, stream buffering.
- **$H_{\text{Environment/Config}}$**: Missing env vars, malformed JSON config, path resolution errors.

### 3. Differential State Inversion (Negative Space Analysis)
- Analyze execution paths that **succeed** vs paths that **fail**.
- Isolate the **Minimal Differential Delta ($\Delta$)**: What exact invariant changes between the working scenario and the breaking scenario?

### 4. Maximum-Information-Gain Probing (Non-Linear Bisection)
Design diagnostic probes (log extraction, targeted grep, type checks, state inspection) that eliminate multiple hypotheses in a single pass:
- **Rule**: Never run a diagnostic step that tests only 1 narrow hypothesis if a broader probe can rule out half of $H_{1..N}$ at once.

### 5. Entropy & Multi-Symptom Cascade Compression
Compress complex error chains (e.g., `ECONNREFUSED` $\to$ `WebSocket closed` $\to$ `React Unhandled Rejection` $\to$ `UI freeze`) into a **Single Root-Cause Singularity**. Do not treat downstream symptoms as separate bugs.

---

## 5-Pass Non-Linear Debugging Protocol

### Pass 1: Vectorized Symptom Intake & Graph Assembly
Construct a symbolic dependency graph of the failure rather than reading code top-to-bottom:
```text
[Source: UI Click / WS Message] ──► [Bridge: superAgentBridge.ts] ──► [HTTP Port 7888] ──► [Crash / Error Sink]
```
Identify all active error signatures, logs, exit codes, and broken expectations.

### Pass 2: Hypotheses Superposition Matrix
Formulate 3–5 parallel hypotheses ($H_1, H_2, H_3, H_4$) spanning different subsystem dimensions. Assign an initial confidence score and high-gain verification test for each.

```markdown
| Hypothesis | Subsystem | Failure Mechanism | High-Gain Verification Probe |
|---|---|---|---|
| **H₁: Lifecycle Race** | Backend Bridge | Process spawned before port 7888 is ready | Check startup timing & ping response logs |
| **H₂: Session Key Mismatch** | REST / WS | `x-workspace-path` missing in headers | Grep `resolveSession` call parameters |
| **H₃: Transport Timeout** | HTTP Proxy | Proxy timeout reached during long LLM pass | Verify `timeoutMs` settings in bridge request |
```

### Pass 3: High-Information-Gain Bisecting Probes
Execute targeted diagnostic commands or code inspections to test $H_{1..N}$ concurrently.
- Inspect exact log traces, stack traces, and status endpoints.
- Narrow down the hypothesis space in $O(\log N)$ steps.

### Pass 4: Root-Cause Collision Node Pinpointing
Identify the exact file, line range, or async timing window where the invariant breaks.
Validate with empirical evidence (exact error line, type violation, or execution trace).

### Pass 5: Minimalist Fix & Invariant Guarding
Apply the fix following `pragmatic-minimalism`:
1. Fix the root cause at the collision node.
2. Add a defensive guard or fallback mechanism to prevent regression.
3. Validate by compiling, building, or testing.

---

## Execution Checklist & Core Invariants

- [ ] **No Blind Guesses**: Diagnosis must be justified by empirical log lines, stack traces, or verified code inspection.
- [ ] **Symptom Masking Forbidden**: Never wrap errors in empty `try/catch` or return dummy fallbacks to hide failures.
- [ ] **Multi-Symptom Collapse**: Treat failure cascades as 1 bug with 1 root cause.
- [ ] **Empirical Verification**: Run build/test commands to confirm the fix before declaring completion.
