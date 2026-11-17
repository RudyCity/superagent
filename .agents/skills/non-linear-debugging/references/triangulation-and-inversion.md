# Bidirectional Triangulation & Differential State Inversion

This reference provides mathematical foundations, topological mental models, and concrete protocols for **Bidirectional Triangulation** and **Differential State Inversion (Negative Space Analysis)**.

---

## 1. Bidirectional Cause-Effect Triangulation

Linear debugging traces code sequentially forward from input or backward from a crash. In distributed, asynchronous, or multi-component systems (e.g. CLI ↔ Core ↔ IPC ↔ Bridge ↔ Frontend), linear search incurs $O(N)$ inspection overhead across deep call stacks and async boundaries.

**Bidirectional Triangulation** searches simultaneously from both boundaries to find the **Collision Node ($\otimes$)** in $O(\log N)$ or fewer inspection steps.

```
[Forward Vector: Input / Intent / Event Source]
                 │
                 ▼
          [Transform S₁]
                 │
                 ▼
          [Boundary S₂] ────► [COLLISION NODE ⊗] ◄──── [Precondition B₂]
                                     ▲                        ▲
                                     │                        │
                               [Invariant Fail]        [Call Frame B₁]
                                                              ▲
                                                              │
                                                [Backward Vector: Error Sink / Crash]
```

### Mathematical Formulation of the Collision Node ($\otimes$)

Let an execution path be represented as an ordered topological sequence of states:
$$S_0 \xrightarrow{f_1} S_1 \xrightarrow{f_2} S_2 \dots \xrightarrow{f_n} S_n$$

- **Forward State Vector ($\vec{F}$)**: The sequence of valid transformations from input $S_0$ through functions $f_1, f_2 \dots$
- **Backward Invariant Constraint ($\vec{B}$)**: The set of preconditions $\Phi_k$ required by consumer functions $g_k$ to avoid throwing an error or corrupting state:
  $$\Phi_n \impliedby \Phi_{n-1} \impliedby \dots \impliedby \Phi_k$$

**Definition of Collision Node ($\otimes$):**
The Collision Node $k^*$ is the exact transition where the forward state vector violates the backward precondition for the first time:
$$\Phi_{k^*}(S_{k^*}) = \text{FALSE} \quad \text{while} \quad \Phi_{k^*-1}(S_{k^*-1}) = \text{TRUE}$$

### Triangulation Protocol

1. **Sink Anchoring ($\vec{B}_0$)**:
   - Locate the exact line where the exception or invalid symptom occurs.
   - Formulate the immediate invariant $\Phi_0$: "What condition would have prevented this line from failing?" (e.g., `port !== undefined`, `stream.isAlive === true`, `payload is valid JSON`).
2. **Source Anchoring ($\vec{F}_0$)**:
   - Locate the initial trigger: user keystroke, CLI flag, API route handler, or WebSocket message.
   - Formulate initial state $S_0$: "What was the exact input payload and environment state?"
3. **Midpoint Inspection ($\vec{F}_{\text{mid}}$ vs $\Phi_{\text{mid}}$)**:
   - Inspect the architectural seam halfway between Source and Sink (e.g., the IPC message serialization, the event bus dispatch, or the service bridge boundary).
   - Evaluate whether $S_{\text{mid}}$ satisfies $\Phi_{\text{mid}}$.
   - If **TRUE**: The defect is between Midpoint and Sink (search the right half).
   - If **FALSE**: The defect is between Source and Midpoint (search the left half).
4. **Collision Node Pinpoint**:
   - Repeat bisection until the exact file, function, and expression where invariant $\Phi$ is broken is isolated.

---

## 2. Differential State Inversion (Negative Space Analysis)

When a bug is elusive, analyzing only the broken state ($S^-$) is like looking for a needle in a haystack. **Differential State Inversion** compares the failing execution against a known successful execution ($S^+$).

```
Known Working Execution (S⁺) ───────► Success Verdict
                                          ▲
                                   Delta  │  Invariant
                                  [ Δ = S⁺ \ S⁻ ]
                                          ▼
Known Failing Execution (S⁻) ───────► Failure Verdict / Crash
```

### The Invariant Delta ($\Delta$)

$$\Delta = \text{State}(S^+) \setminus \text{State}(S^-)$$

The root cause is guaranteed to reside within $\Delta$. Instead of inspecting 10,000 lines of system logic, the investigation isolates the minimal differential delta:
1. **Payload Delta**: What fields differ between the working request and the breaking request?
2. **Environment Delta**: What differs between dev and staging? Local vs CI? Windows vs Linux? Admin vs non-admin?
3. **Timing Delta**: Is the failing call executed 20ms earlier? Is it concurrent instead of sequential?
4. **Dependency / State Delta**: What state was cached in the working scenario that is absent in the clean cold start?

### State Inversion Matrix Template

Use this table during Pass 3 of the debugging protocol to contrast scenarios:

| Dimension | Working Baseline ($S^+$) | Failing Case ($S^-$) | Invariant Delta ($\Delta$) | Inversion Test | Result |
|---|---|---|---|---|---|
| **Input Format** | Bare string `filePath: "src/a.ts"` | Stringified JSON array `filePaths: "[\"src/a.ts\"]"` | Unparsed outer quotes & escaped backslashes | Pass parsed array directly | Root cause confirmed |
| **Execution Timing** | Synchronous sequential call | Promise.all parallel dispatch | Concurrent access to shared port | Inject artificial sequence barrier | Eliminates race condition |
| **Environment** | Linux bash (chains with `&&`) | Windows PowerShell | PowerShell requires `;` separator | Replace `&&` with `;` | Command succeeds |
| **Auth Context** | Session header present | Session header omitted on redirect | Header lost during 302 hop | Forward headers on redirect | Fix verified |

### Applying State Inversion (The Swap Test)

Once an invariant delta is suspected:
1. **Force $S^+$ state into $S^-$**: Inject the working attribute into the failing execution path. If the failure disappears, causality is proven.
2. **Force $S^-$ state into $S^+$**: Inject the failing attribute into the working path. If the working path breaks with the identical error signature, sufficiency is proven.
3. This double-inversion guarantees zero false positives.
