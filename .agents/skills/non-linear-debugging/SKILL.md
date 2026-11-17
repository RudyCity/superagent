---
name: non-linear-debugging
description: >-
  Triggered when the agent needs to debug complex errors, analyze obscure runtime failures, find subtle bugs, or trace system anomalies using non-linear, multidimensional hypothesis graphs, backward-forward triangulation, behavioral state inversion, and dynamic perturbation instead of slow sequential linear step-by-step debugging.
when_to_use: when encountering complex bugs, obscure runtime errors, race conditions, async failures, multi-service anomalies, or when traditional linear debugging stalls
version: 2.0.0
---

# Non-Linear Debugging & Bug Discovery Engine

Enables the AI agent to systematically diagnose, analyze, and resolve complex software errors, obscure bugs, race conditions, memory/state leaks, and system anomalies using **non-linear, graph-based cognitive methodologies** instead of sequential, line-by-line debugging.

---

## When to Use This Skill

- **Trigger Keywords**: `non-linear debug`, `debug error`, `analyze error`, `find bug`, `cari bug`, `investigasi error`, `non linear bug finding`, `root cause triangulation`, `complex failure analysis`, `diagnose bug`.
- **System Boundaries**: When a bug crosses process or architectural boundaries (e.g., CLI ↔ Core Daemon ↔ T-Line Desktop ↔ Chrome Extension ↔ Mobile Bridge).
- **Concurrency & Async**: Asynchronous event loops, microtask starvation, unhandled promise rejections, race conditions, or state synchronization mismatches.
- **Cascading Symptoms**: When facing ambiguous multi-symptom error cascades where downstream effects obscure the initial trigger.
- **Linear Stall**: When traditional step-by-step linear tracing fails, produces false leads, or is blocked by missing or noisy logs.

---

## The Six Iron Laws of Non-Linear Debugging

```
1. TERMINAL REPRODUCTION FIRST  ──► Never touch code before capturing live error evidence.
2. ZERO SYMPTOM MASKING         ──► Never wrap failures in empty catch blocks or dummy nulls.
3. MULTI-HYPOTHESIS SUPERPOSITION ──► Never test 1 isolated theory; hold 3-5 orthogonal hypotheses.
4. $O(\log N)$ BISECTING PROBES  ──► Test seams that halve the search space; no single-leaf probes.
5. COLLISION NODE PINPOINTING   ──► Trace Forward ∩ Backward to find where the invariant broke.
6. INVARIANT GUARD & EVIDENCE   ──► Fix the collision node, guard the invariant, prove with tests.
```

---

## Core Non-Linear Debugging Paradigms

```text
                  ┌──────────────────────────────────────────────┐
                  │    Forward Vector F: (Input Source ──►)      │
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
   ┌──────────────────────┐    ┌───────────────────┐    ┌──────────────────────┐
   │ Hypothesis H₁        │───►│  COLLISION NODE   │◄───│ Hypothesis H₃        │
   │ (Lifecycle & Timing) │    │  (Invariant Δ: ⊗) │    │ (Protocol & IPC)     │
   └──────────────────────┘    └───────────────────┘    └──────────────────────┘
                                         ▲
                                         │
                  ┌──────────────────────┴───────────────────────┐
                  │    Backward Vector B: (◄── Crash Sink)       │
                  └──────────────────────────────────────────────┘
```

### 1. Bidirectional Cause-Effect Triangulation
- **Backward Vector ($\leftarrow \text{Sink}$)**: Trace upstream from where the exception is thrown, state is corrupted, or process exits. Formulate the required backward precondition $\Phi$.
- **Forward Vector ($\text{Source} \rightarrow$)**: Trace downstream from initial request, user event, or state entry. Track state transformations $S_0 \to S_1 \dots$
- **Collision Node Pinpoint ($\otimes$)**: Identify the exact topological junction where the forward state vector first violates the backward precondition:
  $$\Phi(S_k) = \text{FALSE} \quad \text{while} \quad \Phi(S_{k-1}) = \text{TRUE}$$
- *Deep Dive Reference*: See [triangulation-and-inversion.md](references/triangulation-and-inversion.md).

### 2. Multi-Hypothesis Superposition ($H_{1..N}$)
Simultaneously evaluate orthogonal failure hypotheses spanning multiple architectural dimensions rather than chasing a single suspicion:
- **$H_{\text{Lifecycle}}$**: Process startup race, port binding delay, teardown hook firing early, zombie process port collision.
- **$H_{\text{Contract}}$**: Schema drift, unvalidated deserialization, null/undefined propagation, stringified JSON array escaping.
- **$H_{\text{Transport}}$**: WebSocket closure (e.g. 1006 vs 1008), HTTP header loss across redirects, buffer chunk truncation.
- **$H_{\text{Environment}}$**: Windows PowerShell statement chaining (`;` vs `&&`), path separator escaping (`\` vs `/`), file locking.

### 3. Differential State Inversion (Negative Space Analysis)
Never analyze the broken scenario in isolation. Compare the failing execution ($S^-$) against a known working baseline ($S^+$):
$$\Delta = \text{State}(S^+) \setminus \text{State}(S^-)$$
- Focus 100% of diagnostic attention on the **Invariant Delta ($\Delta$)**.
- Apply the **Swap Test**: Force $S^+$ parameters into the failing case to verify causality; force $S^-$ parameters into the working case to prove sufficiency.
- *Deep Dive Reference*: See [triangulation-and-inversion.md](references/triangulation-and-inversion.md).

### 4. Maximum-Information-Gain Probing ($O(\log N)$ Bisection)
Design diagnostic probes (targeted logs, terminal status queries, schema assertions) that eliminate multiple hypotheses in a single execution:
- **Entropy Rule**: Never run a narrow probe that tests only 1 hypothesis if an architectural seam probe can split the hypothesis probability mass roughly in half ($\approx 50/50$).
- *Deep Dive Reference*: See [bisecting-probes-and-perturbation.md](references/bisecting-probes-and-perturbation.md).

### 5. Dynamic Perturbation & Fault Injection
When dealing with intermittent race conditions or non-deterministic timing:
- **Time Dilation**: Inject a micro-delay (e.g., `50ms`) into suspected asynchronous tasks. If reproduction rate jumps from 10% to 100%, race condition is proven.
- **Contract Invariant Assertion**: Inject a loud `throw new Error(...)` at suspect seams to bisect execution flow immediately.
- *Deep Dive Reference*: See [bisecting-probes-and-perturbation.md](references/bisecting-probes-and-perturbation.md).

### 6. Cascade Collapse to the Root-Cause Singularity
Compress multi-tiered symptom storms ($E_1 \to E_2 \to E_3 \to \dots \to E_n$) into a single originating root cause ($E_0$).
- Never apply separate patches to downstream symptoms.
- Fix $E_0$ at the Collision Node, and verify that downstream symptoms $E_1 \dots E_n$ vanish automatically.
- *Deep Dive Reference*: See [failure-modes-and-cascades.md](references/failure-modes-and-cascades.md).

---

## 5-Pass Non-Linear Debugging Protocol

### Pass 1: Topological Mapping & Live Reproduction
1. **Preflight**: Run `git status` to verify working tree safety and check for concurrent agents.
2. **Terminal Reproduction First**: Run the exact command, test, or curl that triggers the failure. Capture raw output, exit codes, and stack traces.
3. **Graph Assembly**: Construct a topological path from the trigger to the crash:
   ```text
   [User CLI / WS Client] ──► [Route Handler] ──► [IPC / Bridge] ──► [Crash Sink]
   ```
4. **De-noise Cascade**: Read logs from the earliest timestamp forward to identify the initial fault $E_0$.

### Pass 2: Hypotheses Superposition Matrix
Formulate 3–4 orthogonal hypotheses across different failure dimensions. Define clear falsification criteria and bisecting probes for each:

```markdown
| Hypothesis | Dimension | Failure Mechanism | Falsification Criterion | High-Gain Bisecting Probe |
|---|---|---|---|---|
| **H₁: Lifecycle Race** | Concurrency | Child process spawned before port is bound | Port is already listening when child boots | Check port binding with `Get-NetTCPConnection` / `netstat` |
| **H₂: JSON Path Escape** | Serialization | Windows backslash unescaped in JSON string | Array parses cleanly with native `JSON.parse` | Inspect raw parameter payload string at seam |
| **H₃: Header Loss** | Transport/IPC | Redirect drops authorization/session header | Headers present in redirect response | Inspect HTTP/WS handshake frame logs |
| **H₄: Shell Chaining** | OS/Platform | `&&` used instead of `;` in Windows PowerShell | Command runs without syntax error | Validate execution string separator syntax |
```

### Pass 3: Bisecting Probes & Negative Space Inversion
1. Execute the highest-information-gain probe to cut the hypothesis space in half.
2. Execute **Negative Space Analysis**: Contrast failing scenario ($S^-$) with working scenario ($S^+$) to isolate the Invariant Delta ($\Delta$).
3. Eliminate falsified hypotheses until exactly one hypothesis is supported by concrete empirical evidence.

### Pass 4: Collision Node Pinpointing
1. Use batch file reading to inspect the code leading into and out of the suspect seam in a single turn.
2. Locate the exact file, function, and line range where the forward state violates the backward invariant.
3. Formulate the exact failure statement:
   > *"At `src/server/bridge.ts:142`, `parsePayload` expects a stringified JSON array, but receives an unescaped Windows backslash path `C:\...`, causing `JSON.parse` syntax error and aborting the WebSocket connection."*

### Pass 5: Minimal Surgical Fix, Invariant Guard & Verification
1. **Surgical Fix**: Apply the minimal necessary modification directly at the Collision Node.
2. **Invariant Guard**: Add a defensive schema validation, type check, or boundary guard to make future violations impossible.
3. **Zero Symptom Masking**: Verify that no empty `catch` blocks or dummy fallback values were introduced.
4. **Evidence-Gated Verification**: Run the reproduction test/build command from Pass 1. Confirm:
   - The original failure is eliminated.
   - All downstream cascading symptoms are gone.
   - No regressions were introduced in existing test suites.

---

## Execution Checklist & Anti-Patterns

### Pre-Fix Invariants
- [ ] Reproduce the bug via terminal command before editing any source code.
- [ ] Evaluate multiple orthogonal hypotheses simultaneously; do not jump to the first guess.
- [ ] Identify the exact Collision Node where the state invariant first breaks.

### Post-Fix Verification Invariants
- [ ] Verify the fix directly addresses the root-cause singularity, not downstream symptoms.
- [ ] Confirm no errors were masked using empty `try/catch` or artificial dummy defaults.
- [ ] Verify with live terminal command output (tests, build, CLI run).

### Banned Anti-Patterns
- **The Band-Aid Null Check**: Injecting `if (!obj) return;` at the crash site instead of fixing why `obj` was undefined.
- **Shotgun Debugging**: Modifying 3 different files at once without knowing which one had the bug.
- **Log Flooding Without Hypothesis**: Sprinkling 20 `console.log` statements without a bisecting strategy.
- **Premature Convergence**: Stopping at the first plausible explanation without running a falsification probe.
- **The Heisenbug Trap**: Introducing synchronous heavy logging that masks a race condition.
