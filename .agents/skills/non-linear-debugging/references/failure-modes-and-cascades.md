# Failure Modes, Cascading Errors & Root-Cause Singularities

This reference provides architectural taxonomies of complex software failure cascades and guides agents in de-noising cascading error storms into a single **Root-Cause Singularity**.

---

## 1. The Anatomy of an Error Cascade

In modern asynchronous, multi-tiered architectures (e.g. Master Agent ↔ SuperAgent CLI ↔ Core Daemon ↔ T-Line Desktop ↔ Chrome Extension / Mobile Bridge), a single root defect rarely produces a single isolated error message. Instead, it triggers an **entropy cascade**:

```
[ Root Cause Singularity E₀ ]  (e.g., Core Port 7888 bound by dead zombie PID)
              │
              ▼
    [ Secondary Error E₁ ]     (e.g., HTTP POST /chat fails with ECONNREFUSED)
              │
              ▼
    [ Tertiary Error E₂ ]      (e.g., WebSocket Bridge enters infinite reconnect loop)
              │
              ▼
   [ Quaternary Error E₃ ]     (e.g., React Frontend throws Unhandled Promise Rejection)
              │
              ▼
    [ Terminal Symptom E₄ ]    (e.g., UI screen freezes / turns blank)
```

### The Iron Law of Cascade Collapse

> **Never treat downstream symptoms ($E_1 \dots E_n$) as independent bugs. Never write five defensive patches to silence five symptoms of one underlying singularity ($E_0$).**

- Patching $E_4$ (e.g., adding an empty catch in React) leaves the WebSocket loop broken ($E_2$).
- Patching $E_2$ leaves the HTTP connection broken ($E_1$).
- Fixing $E_0$ (terminating the dead zombie listener and ensuring clean startup sequencing) automatically eliminates $E_1, E_2, E_3$, and $E_4$ in a single stroke.

---

## 2. Common Architectural Failure Mode Archetypes

### Archetype A: The Concurrency / Event-Loop Starvation Trap
- **Mechanism**: A synchronous heavy loop, unhandled async rejection, or circular dependency starves the Node/Bun microtask queue or blocks the main thread.
- **Observable Symptoms**: UI unresponsiveness, heartbeats timing out, health check failures, "Client not responding" alerts.
- **Root-Cause Singularity**: An unawaited promise, a missing `await` inside a loop, an unbounded recursion, or a CPU-intensive synchronous task executing on the main event thread instead of a worker thread.

### Archetype B: IPC Protocol Framing & Serialization Drift
- **Mechanism**: Data passed across process boundaries (REST, WebSocket, stdin/stdout, or Chrome CDP) is serialized to JSON or binary buffer, but schema assumptions drift between producer and consumer.
- **Observable Symptoms**: `Unexpected token in JSON at position ...`, `Cannot read properties of undefined (reading 'split')`, `NaN` or `[object Object]` in CLI output.
- **Root-Cause Singularity**: 
  - Unescaped Windows backslashes in stringified JSON arrays (e.g., `"[\"C:\\path\"]"`).
  - Unhandled `BigInt`, `Date`, or `Map`/`Set` serialization.
  - Buffer chunking where a JSON packet arrives split across two TCP/WebSocket `data` frames.

### Archetype C: Windows Platform & Shell Invariance Failures
- **Mechanism**: Scripts or tools designed assuming POSIX / bash semantics execute under Windows PowerShell or CMD.
- **Observable Symptoms**: 
  - `The token '&&' is not a valid statement separator in this version.`
  - `The filename, directory name, or volume label syntax is incorrect.`
  - `EBUSY: resource busy or locked, unlink ...`
- **Root-Cause Singularity**:
  - Command chaining with `&&` instead of `;` in PowerShell.
  - Unescaped Windows path separators (`\` treated as escape characters in JSON strings or regex).
  - File locking by active processes (Windows prevents deleting or overwriting open files or loaded `.node`/`.exe` binaries).

### Archetype D: Ghost / Zombie Process & Port Hijacking
- **Mechanism**: A previous execution aborted abnormally (Ctrl+C, crash, unhandled SIGKILL), leaving background worker processes or child daemons holding onto ports (e.g. 7888, 9222, 17341).
- **Observable Symptoms**: `EADDRINUSE: address already in use :::7888`, or requests randomly routing to an outdated version of the code that refuses new endpoints.
- **Root-Cause Singularity**: Stale orphan process not cleanly terminated by parent lifecycle hooks.
- **Resolution**: Identify the exact PID owning the port (`Get-NetTCPConnection` / `netstat -ano`) and inspect its process birth identity. Terminate specifically the orphaned test PID; never blanket-kill unrelated system processes.

### Archetype E: Cache Incoherence & State Shadowing
- **Mechanism**: An in-memory cache, build artifact cache (e.g., `.next/`, `node_modules/.vite/`, `dist/`), or database snapshot becomes desynchronized from current source code.
- **Observable Symptoms**: "Code changed but runtime behavior remains identical", phantom errors on deleted lines, type errors on types that have already been updated.
- **Root-Cause Singularity**: Missing cache invalidation trigger or running a stale compiled bundle instead of newly built output.

---

## 3. Cascade De-noising Protocol

When confronted with a multi-page terminal error log:

1. **Topological Inversion**: Read logs from the **earliest timestamp** forward, not from the bottom of the stack trace. The bottom of the terminal output is almost always the terminal crash ($E_n$), whereas the initial fault ($E_0$) occurred higher up.
2. **Filter Out Repetition**: Eliminate repeated retry/heartbeat failures (e.g., 50 lines of `Retrying connection in 1000ms...`).
3. **Isolate the Invariant Breach**: Find the first occurrence of:
   - An exit code $\neq 0$.
   - A TCP / HTTP connection rejection.
   - A syntax or schema validation exception.
   - An unhandled rejection.
4. **Anchor to the Singularity**: Treat this initial fault as $E_0$. Verify whether resolving $E_0$ collapses the remaining symptoms.
