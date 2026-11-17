# Bisecting Probes, Dynamic Perturbation & Information Gain

This reference provides mathematical foundations and actionable probe catalogs for **Maximum-Information-Gain Probing** and **Dynamic Perturbation**.

---

## 1. Information-Theoretic Probing ($O(\log N)$ Bisection)

Linear debugging wastes cycles running low-information probes that check narrow, single-leaf hypotheses (e.g., checking if one specific config field is valid). **Non-linear probing** selects probes that maximize Information Gain by bisecting the hypothesis space.

### Entropy of the Hypothesis Space

Given $N$ orthogonal hypotheses $\{H_1, H_2, \dots, H_N\}$ with prior probabilities $P(H_i)$, the uncertainty (Shannon Entropy) is:

$$H(X) = -\sum_{i=1}^N P(H_i) \log_2 P(H_i)$$

When all $N$ hypotheses are equally likely, $H(X) = \log_2 N$.

### Expected Information Gain of Probe $T$

A probe $T$ produces an observable outcome $o \in \mathcal{O}$ (e.g., `PASS` or `FAIL`):

$$\text{IG}(T) = H(X) - \sum_{o \in \mathcal{O}} P(o) H(X \mid o)$$

### The Golden Probing Rule

> **Never run a probe that tests only 1 narrow hypothesis if an orthogonal probe can divide the remaining hypothesis mass into two roughly equal halves ($P(\text{Outcome}_A) \approx P(\text{Outcome}_B) \approx 0.5$).**

- A single-leaf probe yields $\approx 0.1$ to $0.2$ bits of information.
- A bisecting seam probe yields $\approx 1.0$ bit of information, halving the search space per execution.

---

## 2. Practical Probe Catalog for Async & Distributed Systems

### A. Network, Socket & Listener Probes

When diagnosing connection refusals, timeouts, or bridge communication errors:

| Probe Intent | Command / Technique | High-Gain Diagnostic Verdict |
|---|---|---|
| **Port Binding Verification** | `Get-NetTCPConnection -LocalPort <PORT> -ErrorAction SilentlyContinue` | Distinguishes whether the server failed to boot vs server is alive but rejecting route. |
| **Listener PID Ownership** | `Get-CimInstance Win32_Process -Filter "ProcessId = <PID>"` | Distinguishes between current runtime owner vs orphaned zombie process occupying the port. |
| **Loopback Connectivity** | `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<PORT>/health` | Distinguishes HTTP application layer crash vs TCP/socket binding failure. |
| **WebSocket Closure Analysis** | Log `event.code` and `event.reason` | Code 1006 = Abnormal closure (network/crash); Code 1000 = Normal clean teardown; Code 1008 = Policy/Auth violation. |

### B. Async Concurrency & Event Loop Probes

When diagnosing deadlocks, hanging tasks, unhandled rejections, or race conditions:

```typescript
// PROBE: Event Loop Starvation & Microtask Delay Sensor
const start = performance.now();
setTimeout(() => {
  const lag = performance.now() - start;
  if (lag > 20) {
    console.error(`[DIAGNOSTIC_PROBE] Event loop delay detected: ${lag.toFixed(2)}ms (threshold: 20ms)`);
  }
}, 0);
```

```typescript
// PROBE: Unsettled Promise Trap
function probeWithTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`[DIAGNOSTIC_PROBE] Operation '${operationName}' hung after ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}
```

```typescript
// PROBE: Global Unhandled Error Trapper
process.on("unhandledRejection", (reason, promise) => {
  console.error("[DIAGNOSTIC_PROBE] Unhandled Rejection at:", promise, "reason:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[DIAGNOSTIC_PROBE] Uncaught Exception thrown:", err);
});
```

### C. Host & Filesystem Invariance Probes (Windows & Cross-Platform)

When diagnosing platform-specific anomalies:

| Diagnostic Target | Probe Technique | What It Falsifies |
|---|---|---|
| **Path Normalization** | Inspect whether paths contain unescaped `\` or mixed `/` and `\` | Falsifies JSON stringify parsing bugs (`JSON.parse` failure on `\"C:\...\"`). |
| **PowerShell Chaining** | Check scripts for `&&` usage | In Windows PowerShell, `&&` can cause syntax errors or parse halts; must use `;`. |
| **File Lock Contention** | Attempt non-destructive rename: `Move-Item -Path $target -Destination "$target.probe" -ErrorAction Stop` | Disproves/proves file is held open by a background daemon or antivirus scanner. |

---

## 3. Dynamic Perturbation & Fault Injection

When a system produces intermittent, non-deterministic errors (race conditions, timing windows), static code inspection often fails. **Dynamic Perturbation** intentionally disturbs the system along specific dimensions to make hidden bugs consistently reproducible.

### Technique 1: Time Dilation (Race Condition Amplifier)

If two async tasks $A$ and $B$ are suspected of racing:
- Inject a controlled delay into $A$:
  ```typescript
  // Perturbation: Dilate operation A by 50ms
  await new Promise(resolve => setTimeout(resolve, 50));
  ```
- **Interpretation:**
  - If the bug reproduction rate jumps from 10% to 100%, $B$ must complete before $A$ (order dependency proven).
  - If the bug disappears completely, $A$ must complete before $B$.
  - Concurrency root cause is isolated without guessing.

### Technique 2: Contract Invariant Assertion (Loud Failure Injection)

If data is suspected of arriving in an invalid state at an intermediate function:
- Inject an aggressive invariant check at the function entrance:
  ```typescript
  // Perturbation: Loud Invariant Assertion
  if (!payload || typeof payload.id !== "string" || payload.id.trim() === "") {
    throw new Error(`[INVARIANT_VIOLATION] Invalid payload.id at Seam '${__filename}': ${JSON.stringify(payload)}`);
  }
  ```
- **Interpretation:**
  - If this throws immediately upon running the reproduction command, the Collision Node is upstream of this seam.
  - If downstream fails without this throwing, the Collision Node is downstream of this seam.

### Technique 3: Negative Mocking (Hypothesis Validation)

To verify if an external dependency error causes the observed cascade:
- Force the dependency to fail with the exact proposed failure:
  ```typescript
  // Perturbation: Force downstream mock failure
  throw new Error("ECONNREFUSED 127.0.0.1:7888");
  ```
- Check if the entire cascading symptom tree reproduces identically. If yes, the hypothesis is sufficient.

---

## 4. Mitigating the Observer Effect (Heisenbug Defense)

Adding diagnostic instrumentation can alter timing and make race conditions disappear (the **Heisenbug** effect). Follow these safety rules:

1. **Non-Blocking In-Memory Ring Buffer**: Never write synchronous `fs.writeFileSync` or heavy `console.log` inside high-frequency loops or tight async queues. Use an in-memory array (`const ringBuffer = [];`) and dump it only upon error.
2. **Deterministic Clocks**: In unit tests, freeze or mock system timers using fake timers (`vi.useFakeTimers()` or explicit tick steppers) instead of real-time sleeps.
3. **Atomic Clean-Up**: Always remove temporary diagnostic perturbation probes immediately after hypothesis falsification/confirmation. Never commit diagnostic probes to source code.
