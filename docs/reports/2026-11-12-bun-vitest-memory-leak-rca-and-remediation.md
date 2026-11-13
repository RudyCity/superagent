# Bun / Vitest Memory Leak Root-Cause Analysis and Remediation Plan

**Date:** 2026-11-12  
**Status:** Diagnosed & Reproduced (Fix Not Yet Applied)  
**Scope:** `bun.exe` (v1.4.2) running Vitest `forks` worker (`tests/remoteAgent.test.ts` + `src/core/remoteAgent/museClient.ts`)

---

## 1. Executive Summary

During a full `bun run test` (`bun --bun x vitest run`) execution, a Vitest `forks.js` worker running under Bun 1.4.2 leaked virtual memory at ~3+ GB per 10 seconds, reaching **79,111.8 MB (~79.1 GB) Private Memory** and **22.5 GB peak Working Set** before being terminated. This nearly exhausted host memory (**0.41 GB free physical RAM** out of 31.19 GB and **0.22 GB free virtual memory** out of 86.63 GB).

Live inspection of the remaining `bun.exe` processes confirmed that **production Core, MCP owner/backend, and T-Line server processes were NOT leaking**. Standalone reproduction confirmed the runaway leak is deterministically triggered inside `tests/remoteAgent.test.ts` due to an interaction between a race condition + zero-backoff polling loop in `src/core/remoteAgent/museClient.ts` and missing `finally` cleanup in `tests/remoteAgent.test.ts`.

---

## 2. Observed Incident & Process Telemetry

### 2.1 Runaway Test Worker (Incident)

| Timestamp (WIB) | PID | Command / Role | Working Set | Private Memory | CPU Time | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 15:34:49 | `10276` | `bun run test` | 0.8 MB | 35.4 MB | 0.03s | Parent test runner |
| 15:34:49 | `17216` | `bun --bun x vitest run` | 15.5 MB | 1,477.7 MB | 57.5s | Vitest coordinator |
| 15:39:47 – 15:45:57 | `27716` | `vitest/dist/workers/forks.js` | 21,200.6 MB | 53,307.2 MB | — | First observed spike |
| 15:46:04 | `27716` | `vitest/dist/workers/forks.js` | 21,862.4 MB | 56,176.0 MB | — | +2.87 GB in ~7s |
| 15:46:15 | `27716` | `vitest/dist/workers/forks.js` | 22,509.3 MB | 59,886.2 MB | 558.2s | Peak working set |
| 15:47:09 | `27716` | `vitest/dist/workers/forks.js` | 20,830.9 MB | 75,096.5 MB | 626.6s | Heavy paging |
| 15:49:13 | `27716` | `vitest/dist/workers/forks.js` | 36.4 MB | 79,111.8 MB | 888.1s | Paged out to disk; OS at 0.41 GB free RAM / 0.22 GB free virtual |

At `15:49:04–15:49:18` (recorded in `~/.superagent-r/logs/commands/cmd_1794473344590_f5gkd.log`), `taskkill /PID 17216 /T /F` terminated `17216` and `27716` (along with orphaned `superagent-tray.exe --lifecycle-smoke` PID `26148`), immediately restoring host capacity to **19.33 GB free physical RAM** and **41.44 GB free virtual memory**.

### 2.2 Remaining Runtime `bun.exe` Processes (Post-Cleanup Check)

All 10 remaining `bun.exe` processes observed between `15:49:41` and `15:55:10` remained stable with no runaway allocation:

| PID | Role | Private Memory | Status |
| --- | --- | --- | --- |
| `10148` | `mcp backend-worker` (prior generation) | 670.6 MB | Stable (retained for generation TTL) |
| `18108` | `mcp backend-worker` (current generation) | 637.1 MB | Active MCP backend |
| `21264` | `dist/cli.js --server 49843 --client-mode tline` | 503.5 MB | Stable |
| `10056` | `mcp tunnel-owner --mcp-port 9227` | 466.9 MB | Stable |
| `27956` / `3276` / `23364` | `dist/cli.js --mcp` (stdio MCP servers) | 449.0 / 445.7 / 400.6 MB | Stable |
| `21824` / `18828` | Diagnostic `bun -e` one-liners (`serviceManager` / `probeManagedMcpTunnelOwner`) | 437.0 / 420.8 MB | Idle / non-exiting, flat memory |
| `25216` | `dist/cli.js core start --port 7888 --client-mode tline` | 194.2 MB | Stable |

---

## 3. Reproduction & Isolation

1. Comparing `tests/**/*.test.ts` (929 files) against `~/.superagent-r/logs/commands/cmd_1794472489114_37evu.log` showed **1 missing test file**: `tests/remoteAgent.test.ts`.
2. Running `bun --bun x vitest run tests/remoteAgent.test.ts --reporter=verbose` reproduced the exact runaway leak immediately:
   - The test `remoteAgent - MuseClient > should prevent concurrent polling on the same client` failed at `tests/remoteAgent.test.ts:872` (`expected false to be true`).
   - Within ~20 seconds, the worker process (PID `8748`) climbed to **10,383.6 MB (~10.4 GB) Private Memory** and **10,074.6 MB Working Set**, and was killed before exhausting system memory.
3. Running each downstream suite in `tests/remoteAgent.test.ts` **in isolation** passed cleanly with normal memory and fast exit:
   - `should retry on HTTP 429`: passed (506 ms)
   - `should deduplicate batch IDs`: passed (3,512 ms)
   - `remoteAgent - Slash Command (/muse)`: 6 passed (8.95 s)
   - `remoteAgent - CLI Handler` & `Summary Formatter`: 5 passed (2.52 s)
   - `should prevent concurrent polling` alone: failed in 24 ms and exited in 4.41 s (no leak because no subsequent `globalThis.fetch` mock ran in the same worker).

---

## 4. Root-Cause Analysis (3-Part Failure Chain)

### Cause 1 — `isPolling` Set After Async Lease Acquisition (`src/core/remoteAgent/museClient.ts`)

In `MuseClient.pollEnvelopes()` (`src/core/remoteAgent/museClient.ts:372-384`):

```ts
if (this.isPolling) {
  throw new Error("A poller is already running for this bot token.");
}
...
const pollingLease = await acquireTelegramPollingLease(token);
this.isPolling = true;
```

`acquireTelegramPollingLease(token)` (`src/core/remoteAgent/telegramPollingLease.ts:50-55`) awaits `readProcessStartIdentity(process.pid)`, which spawns `powershell.exe` on Windows (`src/core/tools/cliBridgeProcessIdentity.ts:35-46`). Because `this.isPolling = true` is only assigned *after* that `await` completes:
1. `client.isPollerActive()` returns `false` synchronously right after `client.pollEnvelopes(...)` is called.
2. Two concurrent `pollEnvelopes()` calls can also both pass `if (this.isPolling)` before either sets `this.isPolling = true`.

### Cause 2 — Missing `finally` Abort in Test (`tests/remoteAgent.test.ts`)

In `tests/remoteAgent.test.ts:870-883` (`should prevent concurrent polling on the same client`):

```ts
try {
  const pollPromise = client.pollEnvelopes(() => {}, abortCtrl.signal);
  expect(client.isPollerActive()).toBe(true);

  await expect(client.pollEnvelopes(() => {}, abortCtrl.signal)).rejects.toThrow(
    "already running"
  );

  abortCtrl.abort();
  await pollPromise.catch(() => {});
} finally {
  globalThis.fetch = originalFetch;
}
```

Because `expect(client.isPollerActive()).toBe(true)` throws at line 872, `abortCtrl.abort()` and `await pollPromise.catch(() => {})` are skipped. The `pollEnvelopes` `while (!signal?.aborted)` loop stays alive in the background of the Vitest worker for all subsequent tests in the file.

### Cause 3 — Unthrottled Spin Loop + Per-Iteration Allocations (`src/core/remoteAgent/museClient.ts`)

In `MuseClient.pollEnvelopes()` (`src/core/remoteAgent/museClient.ts:405-440`):

```ts
const fetchSignal = signal
  ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
  : AbortSignal.timeout(30000);

const res = await fetch(url, { signal: fetchSignal });
...
const data = (await res.json()) as any;
if (!data || !data.ok || !Array.isArray(data.result)) {
  this.lastPollError = "Telegram getUpdates returned an invalid response.";
  continue;
}
```

When the next test (`should retry on HTTP 429 using parameters.retry_after`, `tests/remoteAgent.test.ts:915`) replaces `globalThis.fetch` with:

```ts
globalThis.fetch = vi.fn().mockImplementation((url: string) => {
  ...
  return Promise.resolve(new Response(JSON.stringify({ ok: true })));
});
```

the leaked background `pollEnvelopes` loop receives `{ ok: true }` (missing `result: []`) and hits `continue;` with **zero delay/backoff**. This produces an unthrottled microtask infinite loop (~100% CPU) where every iteration:
1. Creates `AbortSignal.timeout(30000)` and registers an `AbortSignal.any([signal, ...])` composite listener attached to the un-aborted `abortCtrl.signal` (retaining references until `signal` aborts).
2. Constructs a new `Response` object and invokes the `vi.fn()` mock, which appends every call's arguments and return value into `mock.calls` / `mock.results` indefinitely.

This drives memory consumption at **~500 MB/s** (**10.4 GB in ~20s**, **79.1 GB in ~10 minutes**).

---

## 5. Remediation Plan

### 5.1 Production Code Fixes (`src/core/remoteAgent/museClient.ts`)

1. **Mark polling active immediately (before async lease acquisition):**
   - Set `this.isPolling = true` synchronously right after passing `if (this.isPolling)` (inside a `try { ... } finally { this.isPolling = false; }` covering `acquireTelegramPollingLease(token)` as well, so a lease failure cleanly resets `this.isPolling = false`).
   - Also check `if (signal?.aborted) return;` before starting the loop and release `pollingLease` if `signal?.aborted` became true while awaiting `acquireTelegramPollingLease`.
2. **Add bounded backoff on invalid `getUpdates` JSON responses (lines 436–440):**
   - Treat `!data || !data.ok || !Array.isArray(data.result)` as a poll error with exponential backoff (matching lines 428–433: increment `consecutiveErrors`, compute `backoffMs = Math.min(1000 * Math.pow(2, consecutiveErrors), 15000)`, await abort-aware sleep) before `continue;`. Never spin without yielding.
3. **Avoid leaking `AbortSignal.timeout` / `AbortSignal.any` listeners across aborted/long-lived signals:**
   - Ensure per-request timeout timers/listeners are cleaned up after `fetch` resolves/rejects (or use a per-request `AbortController` with `setTimeout(...).unref?.()` + `clearTimeout` in `finally` and remove the parent `signal` listener when the request completes).

### 5.2 Test Hygiene Fix (`tests/remoteAgent.test.ts`)

1. **Always abort & await `pollPromise` in `finally` (lines 845–884):**
   - Move `abortCtrl.abort();` and `await pollPromise.catch(() => {});` inside the `finally` block (before restoring `globalThis.fetch`) so a failed assertion never leaves a background poller running into subsequent tests.
2. **Audit similar `pollEnvelopes` tests** in `tests/remoteAgent.test.ts` and `tests/museTokenRefresh.test.ts` to guarantee every `AbortController` / background poller is aborted and awaited in `finally` or `afterEach`.

---

## 6. Verification Checklist (After Applying Fix)

1. Run `bun --bun x vitest run tests/remoteAgent.test.ts --reporter=verbose` and confirm:
   - All 51 tests pass (including `should prevent concurrent polling on the same client`).
   - Worker exits cleanly in <15s with normal memory (<1 GB Private Memory).
2. Add/verify a regression test ensuring `MuseClient.pollEnvelopes()` backs off rather than tight-looping when `getUpdates` returns HTTP 200 `{ ok: true }` without a `result` array.
3. Run `bun run build` and `bun run test:unit` / `bun run test` while monitoring `bun.exe` Private Memory.
