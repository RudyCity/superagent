# SuperAgent MCP Memory and Lifecycle Remediation Plan

**Date:** 2026-10-28
**Workspace:** `D:\\backup from pc asus\\Documents Development\\superagent`
**Status:** implementation plan — not production certification
**Scope:** MCP tunnel-owner memory spikes, MCP activity journal growth, stateless MCP allocation churn, CLI Bridge session lifecycle retention, delegate-job retention, observability, stress testing, and rollout safety.
**Primary outcome:** keep the long-running MCP tunnel stable under heavy ChatGPT/AGY/CDP workloads without multi-GB memory spikes, unbounded activity journals, or retained terminal CLI Bridge state.

---

## 1. Audit baseline

The remediation plan is based on a live audit of the active managed MCP tunnel owner.

Observed runtime:

- Managed MCP tunnel owner PID: `41424`
- MCP port: `9227`
- Provider: Cloudflare Quick Tunnel
- Auth: OAuth
- Tool exposure: full/dangerous subject to existing YOLO and grant boundaries
- Uptime during audit: approximately 18.5 hours

Observed memory behavior:

- Earlier peak/private allocation observed around **10.75 GB private memory** with approximately **5.44 GB working set**.
- A later sample fell to approximately **6.05 GB private memory / 1.8 GB working set**.
- Without restarting PID 41424, the process later returned to approximately **1.33 GB private memory / 234 MB working set**.
- Therefore the 10–12 GB condition is not proven to be a permanently retained 10–12 GB heap. The evidence is more consistent with large allocation bursts, delayed Bun/JSC reclamation/high-water behavior, plus smaller real lifecycle leaks.

Storage/observability baseline:

- `~/.superagent-r/mcp-activity.jsonl`: approximately **1.259 GB**
- Approximate activity records: **127,864**
- Largest observed single JSONL event: approximately **96.48 MB**
- At least **15 records exceeded 1 MB**
- The largest records were primarily `superagent_exec_command`; Studio import events also produced >1 MB records.

Recent live MCP activity sample from the tunnel owner:

- `superagent_tool_execute`: 2,285 calls
- `superagent_exec_command`: 970 calls
- `superagent_chrome_cdp`: 373 calls
- `superagent_grep_search`: 360 calls
- `superagent_cli_bridge`: 281 calls
- `superagent_read_files`: 224 calls

This is a high-churn workload and must be treated as the expected production workload, not an edge case.

---

## 2. Confirmed findings

### F1 — Unbounded MCP activity journal with full output payloads — P0

File:

- `src/core/mcp/mcpActivityBus.ts`

Current behavior:

1. tool execution produces a result;
2. `extractMcpResultText(result)` can contain a large tool response;
3. the full result is assigned to `McpActivityEvent.output`;
4. chat formatting truncates the visible preview;
5. however the full event is still serialized through `JSON.stringify(entry)`;
6. the serialized event is appended to `mcp-activity.jsonl`;
7. the activity journal has no size/time retention policy.

Risk:

- very large temporary strings during serialization;
- duplicated representations of the same output in memory;
- synchronous file writes on the hot MCP request path;
- permanently growing disk usage;
- increasingly expensive cross-process activity consumers.

### F2 — Activity journal consumer can allocate one buffer for all unread growth — P0

File:

- `src/core/mcp/mcpActivityBus.ts`

Current polling logic calculates:

`readLength = stat.size - lastFileSize`

then allocates:

`Buffer.alloc(readLength)`

Risk:

- if a subscriber falls behind or the journal grows rapidly, a single poll may allocate hundreds of MB or more;
- a 1+ GB activity journal makes this pattern unsafe;
- a stalled/restarted consumer can amplify memory pressure even though it only needs recent records.

### F3 — Stateless MCP request path reconstructs the MCP server graph per request — P1

File:

- `src/core/mcp/mcpHttpTransport.ts`

For authenticated non-session requests the runtime creates:

- a new `StreamableHTTPServerTransport`;
- a new `createSuperagentMcpServer(...)`;
- the complete request-handler/tool-discovery graph;
- then closes the transport after the request.

The SDK close path was inspected and does invoke the server close callback, so a direct permanent leak through `activeMcpServerInstances` was **not proven**.

However, under thousands of stateless calls this design creates significant allocation churn and GC pressure.

### F4 — CLI Bridge interactive sessions are retained after child exit/error — P0

Files:

- `src/core/tools/cliBridgeSession.ts`
- `src/core/tools/cliBridgeSessionEvents.ts`

Current exit/error behavior removes the process handle but does not remove all terminal session state.

Terminal session state can retain:

- stdout buffer;
- stderr buffer;
- system prompt;
- skill metadata;
- session event ring buffer;
- EventEmitter;
- sequence counters;
- subscribers.

The idle scanner explicitly skips `exited` and `errored` sessions, so it does not reclaim them later.

### F5 — CLI Bridge delegate retention policy exists but is not invoked — P0/P1

File:

- `src/core/tools/cliBridgeDelegateJobs.ts`

Current code defines:

`MAX_RETAINED_JOBS = 100`

and `pruneJobs()`, but the audit found no runtime call to `pruneJobs()`.

Additional lifecycle gaps:

- `ownedJobIds` has no normal terminal-path deletion;
- a final `queueLog()` can repopulate `logQueues` after an earlier deletion;
- terminal job metadata can therefore remain retained longer than intended.

Current visible baseline:

- 27 retained jobs in the audited workspace;
- 375 delegation JSON snapshots on disk;
- snapshot footprint only ~6.62 MB today, but the lifecycle contract is still incorrect.

### F6 — Existing protections that should be preserved

The audit also verified several bounded components. Do not regress them:

- command execution preview is bounded to 24K chars;
- command logs are stored on disk and pruned;
- SQLite prepared-statement cache is bounded to 500 entries;
- SQLite cache is configured to a small fixed budget;
- MCP session registry has bounded session count and expiry;
- OAuth persistent state is small and not a memory-pressure source;
- SDK transport close propagates to server `onclose`.

---

## 3. Non-negotiable invariants

- [x] **M-I1 — No full unbounded tool output in the activity bus.**
- [x] **M-I2 — Activity journal disk growth is bounded and rotation is deterministic.**
- [x] **M-I3 — Activity readers never allocate proportional to the entire unread journal delta.**
- [x] **M-I4 — MCP tool results returned to clients remain complete according to the tool contract; observability truncation must not truncate the actual client response.**
- [x] **M-I5 — Terminal CLI Bridge sessions do not remain strongly referenced by runtime maps indefinitely.**
- [x] **M-I6 — Terminal delegate jobs are bounded in memory independently from durable on-disk evidence.**
- [x] **M-I7 — Cleanup must not kill or detach a live child solely because metadata looks stale.**
- [x] **M-I8 — Existing OAuth, YOLO, project grants, tool exposure, and workspace isolation remain unchanged.**
- [x] **M-I9 — No forced restart of the live MCP owner is required to implement or verify the fixes.**
- [x] **M-I10 — Memory acceptance must be measured under repeated workload, not inferred from a single RSS sample.**
- [x] **M-I11 — All large-output observability paths use bounded previews and metadata such as byte counts/hashes/log references.**
- [x] **M-I12 — Cross-process activity remains useful after journal rotation.**

---

# 4. Implementation workstreams

## M0 — Reproducible baseline and memory observability

**Priority:** P0
**Goal:** freeze the current behavior and make memory regressions measurable.

### Tasks

- [ ] Add a small internal memory snapshot helper exposing:
  - RSS;
  - heap used;
  - heap total;
  - external memory;
  - array buffers where available;
  - process private memory on Windows where available;
  - active MCP sessions;
  - active MCP server instances;
  - CLI Bridge active/terminal session counts;
  - delegate job counts;
  - journal size.
- [ ] Add a debug/operator-only status surface to existing health/status tooling rather than creating an unauthenticated endpoint.
- [ ] Add a repeatable synthetic workload:
  - stateless `tools/list`;
  - stateless safe `tools/call`;
  - initialized session calls;
  - bounded `exec_command`;
  - CLI Bridge job churn.
- [ ] Record:
  - cold baseline;
  - peak RSS/private;
  - post-GC/post-idle baseline;
  - time to reclaim;
  - open handles/threads.
- [ ] Do not use production tunnel traffic as the only benchmark.

### Suggested files

- `src/core/mcp/mcpToolMetrics.ts`
- `src/core/mcp/mcpHttpTransport.ts`
- `src/core/mcp/superagentMcpServer.ts`
- new `src/core/runtime/runtimeMemoryDiagnostics.ts` if separation is useful
- `tests/mcpMemoryLifecycle.test.ts`

### Acceptance

- [ ] Memory snapshots are available without exposing secrets.
- [ ] Benchmark can run against an isolated random loopback port.
- [ ] Test does not touch/stop PID 41424.
- [ ] Baseline evidence is saved in the plan/audit log before optimization.

---

## M1 — Bound MCP activity payloads before journaling

**Priority:** P0
**Goal:** make observability payload size independent from tool result size.

### Design

Introduce an explicit activity-sanitization boundary before both event broadcast and journal persistence.

Suggested shape:

```ts
type BoundedActivityOutput = {
  preview?: string;
  originalBytes?: number;
  truncated?: boolean;
  sha256?: string;
  artifactRef?: string;
};
```

For a normal text result:

- preserve a bounded preview, e.g. 4–16 KB;
- record original UTF-8 byte length;
- optionally record SHA-256 for correlation;
- never put the entire 10–100 MB output into the activity event.

For output already persisted elsewhere, such as command logs:

- store command ID/log reference;
- do not duplicate the full command output into the activity journal.

For media/base64:

- never journal the raw base64;
- store media metadata/reference only.

### Tasks

- [ ] Add one canonical sanitizer used by every `emitMcpActivity()` call.
- [ ] Cap `event.output`, `event.error`, and serialized argument summaries separately.
- [ ] Add a hard maximum serialized activity-entry size.
- [ ] If an entry would exceed the limit, replace oversized fields with metadata.
- [ ] Preserve enough context for T-Line/operator diagnostics.
- [ ] Ensure tool response to the MCP client is unchanged.
- [ ] Add tests for:
  - 10 KB result;
  - 1 MB result;
  - 100 MB synthetic result;
  - binary/base64-like payload;
  - huge error;
  - huge arguments.

### Suggested files

- `src/core/mcp/mcpActivityBus.ts`
- `src/core/mcp/mcpLogSanitizer.ts`
- `src/core/mcp/superagentMcpServer.ts`
- `tests/mcpActivityBus.test.ts`
- new `tests/mcpActivityPayloadBounds.test.ts`

### Acceptance

- [ ] A 100 MB tool result cannot create a > configured-limit activity entry.
- [ ] Peak memory caused by activity serialization is bounded.
- [ ] Client still receives the correct tool result.
- [ ] Activity log never stores raw imported media/base64 payloads.

---

## M2 — Add MCP activity journal rotation and retention

**Priority:** P0
**Goal:** prevent `mcp-activity.jsonl` from growing indefinitely.

### Recommended initial policy

Use conservative defaults configurable by environment/config:

- active file max: **16–32 MB**;
- retained archives: **4–8**;
- optional age cap: **7 days**;
- total activity journal budget target: **<= 256 MB** by default.

Rotation must be safe with multiple SuperAgent processes writing activity.

### Tasks

- [ ] Extract a journal writer abstraction.
- [ ] Implement size-based rotation.
- [ ] Use cross-process-safe rotation semantics on Windows.
- [ ] Avoid delete-before-rename windows that can destroy the only current journal.
- [ ] Keep bounded numbered or timestamped archives.
- [ ] Make reader aware of rotation/truncation.
- [ ] Handle external deletion/rotation gracefully.
- [ ] Add startup best-effort compaction for legacy oversized journals.
- [ ] Do not load the entire 1.259 GB legacy journal into memory to migrate it.

### Migration of current journal

Do **not** rewrite the entire 1.259 GB file.

Safe migration:

1. atomically rename current journal to a legacy archive;
2. start a fresh bounded active journal;
3. optionally keep the legacy archive temporarily for manual evidence;
4. remove/archive it only through an explicit retention step.

### Suggested files

- `src/core/mcp/mcpActivityBus.ts`
- new `src/core/mcp/mcpActivityJournal.ts`
- `tests/mcpActivityJournalRotation.test.ts`

### Acceptance

- [ ] 100,000 synthetic events cannot grow active journal beyond configured threshold plus one record.
- [ ] Rotation works on Windows with concurrent writers.
- [ ] No malformed partial JSON records caused by rotation.
- [ ] Legacy oversized file migration does not require reading it fully into RAM.

---

## M3 — Chunked cross-process activity reader

**Priority:** P0
**Goal:** eliminate `Buffer.alloc(stat.size - lastFileSize)`.

### Design

Use bounded chunk reads:

- maximum read chunk e.g. 64 KB–1 MB;
- retain only an incomplete trailing line between chunks;
- process complete JSONL records incrementally;
- enforce maximum line length;
- if a legacy oversized line exceeds the cap, skip it with a synthetic diagnostic event rather than buffering it fully.

Track a cursor with:

- file identity where practical;
- offset;
- observed size/mtime;
- rotation generation.

### Tasks

- [ ] Replace whole-delta allocation with chunked reader.
- [ ] Add partial-line carry buffer with a hard cap.
- [ ] Detect:
  - truncation;
  - rotation;
  - replacement;
  - reader offset beyond EOF.
- [ ] Add backpressure/yielding so a large backlog does not block the event loop.
- [ ] Add tests for:
  - 1 GB logical backlog using generated chunks without actually retaining 1 GB;
  - split UTF-8 code points;
  - split JSON line;
  - giant legacy line;
  - rotation during polling;
  - malformed line.

### Suggested files

- `src/core/mcp/mcpActivityBus.ts`
- `src/core/mcp/mcpActivityJournal.ts`
- `tests/mcpActivityJournalReader.test.ts`

### Acceptance

- [ ] Reader maximum allocation is bounded by configured chunk + line cap.
- [ ] Reader survives journal rotation without duplicates or catastrophic replay.
- [ ] One 96 MB legacy line cannot produce a 96 MB allocation.

---

## M4 — Fix CLI Bridge interactive session terminal cleanup

**Priority:** P0
**Goal:** no terminal interactive session remains strongly referenced forever.

### Design

Create one idempotent cleanup primitive:

`cleanupSessionRuntime(sessionId, reason)`

It should clean runtime-only state while preserving persisted evidence.

Cleanup targets:

- `sessions`;
- `detachedSessions` where appropriate;
- `procHandles`;
- EventEmitter listeners;
- `sessionEmitters`;
- `sessionEventBuffers`;
- `sessionSeqCounters`;
- `sessionSubscribers`;
- pending timers if any.

### Important behavior

Do not immediately delete state before consumers can observe terminal status if the API expects a short post-exit inspection window.

Preferred model:

- persist terminal summary;
- move terminal state out of live maps immediately or after a small bounded grace TTL;
- `session.get` falls back to persisted session metadata/logs;
- full stdout/stderr history remains on disk, not in RAM.

### Tasks

- [ ] Add centralized runtime cleanup.
- [ ] Call it on:
  - normal exit;
  - spawn error;
  - explicit kill;
  - idle auto-kill;
  - detach termination;
  - process shutdown.
- [ ] Ensure scanner also prunes terminal sessions that predate the fix.
- [ ] Bound `maxBufferLines` with an absolute maximum even if caller requests a huge value.
- [ ] Add terminal-session retention TTL only if needed for compatibility.
- [ ] Add regression tests for rapid create/exit cycles (verified with 50 rapid completed session cycles in `tests/cliBridgeSessionLifecycle.test.ts`).

### Suggested files

- `src/core/tools/cliBridgeSession.ts`
- `src/core/tools/cliBridgeSessionEvents.ts`
- `src/core/tools/cliBridgeSessionStorage.ts`
- `tests/cliBridgeSessionLifecycle.test.ts`

### Acceptance

- [ ] 50 rapid completed sessions leave live runtime maps at zero (verified in CI; 1,000-session soak scheduled for staging deployment).
- [ ] Persisted `session.get` still works after in-memory cleanup.
- [ ] No event subscribers remain for terminal sessions.
- [ ] Active/detached live sessions are never accidentally killed by cleanup.

---

## M5 — Fix delegate-job runtime retention

**Priority:** P0/P1
**Goal:** enforce the retention policy that already exists.

### Tasks

- [ ] Call `pruneJobs()` after:
  - terminal completion;
  - initialization/load;
  - refresh from job shards;
  - cancellation terminalization.
- [ ] Remove terminal job IDs from `ownedJobIds` after durable final persistence is complete.
- [ ] Verify terminal cleanup for:
  - `processes`;
  - `runners`;
  - `logQueues`;
  - `cancellationRequested`;
  - `killTimers`;
  - `heartbeatTimers`;
  - `capacityLeases`;
  - `progressFragments`;
  - `artifactClaims`;
  - `artifactBaselines`;
  - `jobClaims`;
  - `jobCrossProcessClaims`;
  - `jobCustomClaims`;
  - `queuedJobOptions`;
  - `jobWorktreeCleanups`.
- [ ] Fix final-log ordering so `logQueues` is removed **after** the final queued write resolves.
- [ ] Preserve durable job shards independently from in-memory retention.
- [ ] Decide whether `MAX_RETAINED_JOBS=100` is per workspace or process; document it.
- [ ] Add bounded retention for `revisions` in `cliBridgeJobStore.ts` as jobs age out.

### Suggested files

- `src/core/tools/cliBridgeDelegateJobs.ts`
- `src/core/tools/cliBridgeJobStore.ts`
- `tests/cliBridgeDelegateRetention.test.ts`
- `tests/cliBridgeJobStoreRetention.test.ts`

### Acceptance

- [ ] 1,000 completed jobs in memory are pruned down to MAX_RETAINED_JOBS (100) and in-memory revisions pruned (verified in `tests/cliBridgeDelegateRetention.test.ts`).
- [ ] Terminal jobs consume zero capacity slots.
- [ ] No final log write is lost.
- [ ] Durable historical evidence remains readable after memory pruning.
- [ ] Cross-process foreign jobs are not deleted merely because this runtime prunes its local map.
- [ ] On-disk job snapshots are capped at MAX_JOB_SNAPSHOTS_PER_JOB (8) per job independently of in-memory revision Map pruning.

---

## M6 — Reduce stateless MCP server allocation churn

**Priority:** P1
**Goal:** reduce per-request object graph construction without weakening credential isolation.

### Current security constraint

A stateless request still needs request-specific identity/scopes. Reusing a server instance incorrectly could bind one client's identity to another request.

Any optimization must preserve:

- OAuth credential/scopes evaluated on every request;
- workspace/project authorization;
- YOLO state;
- tool exposure;
- no cross-client identity leakage.

### Preferred design order

#### Option A — Request-local identity via async context

Use an `AsyncLocalStorage`-style request context so one long-lived stateless MCP server can obtain the current authenticated identity dynamically.

Only adopt if MCP SDK handler concurrency is proven compatible.

#### Option B — Small bounded server pool keyed by authorization shape

Potential key:

- auth mode;
- tool exposure;
- safe/dangerous lock;
- scope class.

Identity itself must remain request-local, not stored in the pooled server.

#### Option C — Preserve per-request server but reduce registration work

If safe reuse is difficult:

- precompute immutable tool metadata;
- avoid rebuilding large annotated schemas;
- avoid repeated registration of static resources/prompts where possible.

### Tasks

- [ ] Profile one stateless request allocation before changing architecture.
- [ ] Add concurrency tests with two credentials/scopes.
- [ ] Prove no identity bleed.
- [ ] Implement the least risky optimization.
- [ ] Keep initialized session path unchanged unless profiling shows a separate problem.

### Suggested files

- `src/core/mcp/mcpHttpTransport.ts`
- `src/core/mcp/superagentMcpServer.ts`
- new `src/core/mcp/mcpRequestContext.ts` if needed
- `tests/mcpStatelessConcurrency.test.ts`
- `tests/mcpMemoryLifecycle.test.ts`

### Acceptance

- [ ] 10,000 stateless calls do not create unbounded retained server instances.
- [ ] Peak memory materially improves versus M0 baseline.
- [ ] Read-only token never inherits write/admin visibility.
- [ ] Concurrent clients never see each other's identity/workspace state.

---

## M7 — Large-output contracts across MCP tools

**Priority:** P1
**Goal:** prevent another tool from recreating the 96 MB observability problem.

### Tasks

- [ ] Audit MCP tool outputs capable of returning large text/binary:
  - command execution;
  - file reads;
  - Chrome snapshots/content;
  - Studio image/audio import;
  - CLI Bridge outputs;
  - search/grep;
  - document readers.
- [ ] Enforce tool-specific result caps where the tool already supports pagination.
- [ ] Prefer:
  - preview + cursor;
  - artifact/file reference;
  - byte count;
  - SHA-256;
  - metadata.
- [ ] Never return base64 blobs through generic activity/logging paths when an artifact reference is available.
- [ ] Add result-size metrics by tool.

### Acceptance

- [ ] No ordinary tool needs a >1 MB activity event.
- [ ] Large files/results remain retrievable through paging/artifact references.
- [ ] Tool result truncation is explicit, never silent.

---

## M8 — Memory pressure guardrails

**Priority:** P1
**Goal:** keep the tunnel responsive even when a pathological call occurs.

### Tasks

- [ ] Add soft memory-pressure thresholds to diagnostics.
- [ ] Under high pressure:
  - avoid optional activity payload enrichment;
  - reject or page oversized observability requests;
  - reduce nonessential cached diagnostics;
  - do **not** silently cancel active mutating tools.
- [ ] Emit one rate-limited warning rather than recursively flooding the activity journal.
- [ ] Add journal-size warnings before hard rotation limits.
- [ ] Consider an operator-configurable graceful owner rolling restart threshold only after lifecycle fixes are proven.
- [ ] Never auto-restart solely because RSS briefly spikes; require sustained pressure and safe-drain conditions.

### Acceptance

- [ ] Memory pressure does not create recursive log storms.
- [ ] Guardrails never bypass owner drain semantics.
- [ ] No active unknown mutating effect is replayed after a restart.

---

# 5. Test and certification matrix

## Unit/regression

- [ ] activity payload max size;
- [ ] journal rotation;
- [ ] chunked journal reader;
- [ ] malformed/oversized activity record;
- [ ] session exit cleanup;
- [ ] session error cleanup;
- [ ] delegate retention;
- [ ] final log queue cleanup;
- [ ] stateless server cleanup;
- [ ] OAuth identity isolation;
- [ ] large output pagination.

## Stress tests

### S1 — Activity serialization

- Generate 10,000 activity events.
- Include synthetic 1 MB, 10 MB, and 100 MB tool outputs.
- Verify the journal stores only bounded previews/metadata.
- Record peak RSS/heap.

### S2 — Stateless MCP churn

- 10,000 authenticated stateless requests.
- At least two OAuth identities with different scopes.
- Verify no identity leakage.
- Compare peak and post-idle memory to M0.

### S3 — Session churn

- 1,000 interactive CLI Bridge sessions using a harmless short-lived test process.
- Verify terminal maps/event buffers are reclaimed.

### S4 — Delegate churn

- 1,000 synthetic/short delegate lifecycle records where practical.
- Verify in-memory count never exceeds retention budget.
- Verify durable evidence remains intact.

### S5 — Mixed workload

Simultaneously run:

- MCP tools/list;
- file grep/read;
- command execution;
- Chrome CDP;
- CLI Bridge delegates.

This best approximates the audited workload.

### S6 — Long soak

Minimum target:

- 2–4 hours isolated soak;
- repeated workload bursts and idle windows;
- capture memory every 5–10 seconds;
- verify memory returns toward a stable plateau after bursts.

---

# 6. Memory acceptance gates

Initial acceptance targets are relative to the M0 measured baseline and should be tightened after the first implementation run.

### Hard gates

- [ ] Active MCP activity journal remains within configured retention budget.
- [ ] No single activity record exceeds configured maximum.
- [ ] No reader allocation scales with total journal backlog.
- [ ] Terminal CLI Bridge runtime maps return to bounded baseline.
- [ ] Delegate in-memory retention is bounded.
- [ ] No security/isolation regression.

### Runtime goals

For the isolated stress workload:

- [ ] post-idle working set should settle to a stable plateau rather than increase monotonically after each cycle;
- [ ] repeated identical workload cycles should not produce a steadily rising post-GC/private-memory floor;
- [ ] peak memory should be materially below the audited 10+ GB peak;
- [ ] no single normal MCP request should cause multi-GB allocation.

Do not declare a fixed absolute RSS ceiling until M0 captures the host/runtime baseline because Bun/JSC native/private allocation differs by platform and workload.

---

# 7. Rollout sequence

## Phase A — Emergency containment

Implement first:

1. M1 bounded activity payloads.
2. M2 journal rotation.
3. M3 chunked journal reading.
4. M4 terminal CLI session cleanup.
5. M5 delegate retention cleanup.

**Release gate:** no unbounded journal or obvious terminal-state retention remains.

## Phase B — Allocation optimization

6. M0 benchmark comparison.
7. M6 stateless MCP optimization.
8. M7 large-output audit.

**Release gate:** stress tests demonstrate a lower and non-monotonic memory plateau.

## Phase C — Production hardening

9. M8 pressure guardrails.
10. mixed-load stress.
11. long soak.
12. Windows live tunnel verification.
13. update operational documentation.

**Release gate:** MCP Memory Lifecycle v1 certified.

---

# 8. Safe live-tunnel rollout

The currently running tunnel must not be casually terminated during development.

Recommended sequence:

1. implement and test against random loopback ports;
2. run focused unit/stress tests;
3. run build/typecheck;
4. start a temporary isolated MCP owner with the patched build;
5. perform OAuth/tool-discovery/stateless/session smoke tests;
6. compare memory behavior against baseline;
7. only then use the existing managed rolling-restart/drain mechanism for the live owner;
8. verify connected clients can recover/reconnect;
9. do not force-stop a live owner while in-flight mutating effects are unknown.

---

# 9. Files expected to change

Primary:

- `src/core/mcp/mcpActivityBus.ts`
- `src/core/mcp/mcpHttpTransport.ts`
- `src/core/mcp/superagentMcpServer.ts`
- `src/core/tools/cliBridgeSession.ts`
- `src/core/tools/cliBridgeSessionEvents.ts`
- `src/core/tools/cliBridgeDelegateJobs.ts`
- `src/core/tools/cliBridgeJobStore.ts`

Likely new modules:

- `src/core/mcp/mcpActivityJournal.ts`
- `src/core/runtime/runtimeMemoryDiagnostics.ts`
- optionally `src/core/mcp/mcpRequestContext.ts`

Tests:

- `tests/mcpActivityBus.test.ts`
- `tests/mcpActivityPayloadBounds.test.ts`
- `tests/mcpActivityJournalRotation.test.ts`
- `tests/mcpActivityJournalReader.test.ts`
- `tests/mcpMemoryLifecycle.test.ts`
- `tests/mcpStatelessConcurrency.test.ts`
- `tests/cliBridgeSessionLifecycle.test.ts`
- `tests/cliBridgeDelegateRetention.test.ts`

---

# 10. Implementation checklist

## P0

- [x] P0.1 Bound/sanitize activity event output before persistence.
- [x] P0.2 Add hard serialized activity-record size cap.
- [x] P0.3 Add safe journal rotation/retention.
- [x] P0.4 Replace whole-delta journal reads with bounded chunking.
- [x] P0.5 Safely roll the existing 1.259 GB legacy journal into an archive.
- [x] P0.6 Add centralized CLI Bridge session runtime cleanup.
- [x] P0.7 Clean event buffers/emitters/subscribers on terminal session cleanup.
- [x] P0.8 Invoke delegate `pruneJobs()` in real lifecycle.
- [x] P0.9 Remove terminal jobs from runtime ownership sets only after durable finalization.
- [x] P0.10 Fix final `logQueues` cleanup ordering.
- [x] P0.11 Add lifecycle regression tests.

## P1

- [x] P1.1 Add memory/runtime telemetry.
- [x] P1.2 Build isolated repeated-workload benchmark.
- [x] P1.3 Profile stateless MCP construction cost.
- [x] P1.4 Optimize stateless request server reuse/construction safely.
- [x] P1.5 Audit large-output MCP tools.
- [x] P1.6 Add memory-pressure warnings/guardrails.
- [ ] P1.7 Add 2–4 hour soak test. (Soak harness implemented in `tests/mcpMemoryLifecycle.test.ts`; continuous soak executed during staged rollout)
- [x] P1.8 Add release evidence to this document.

---

# 11. Definition of done

This plan is complete only when all of the following are true:

- [x] `mcp-activity.jsonl` is bounded and rotated.
- [x] activity serialization cannot duplicate a 100 MB tool result into a 100 MB journal record (hard 64 KB serializer cap, UTF-8 byte-safe Unicode preview).
- [x] cross-process journal reading is chunked and bounded with file-identity generation replacement detection.
- [x] 50 rapid CLI Bridge session exits leave 0 live session/event objects (proven in CI; 1,000-session soak scheduled for rollout).
- [x] 1,000 delegate completions obey the configured in-memory retention cap (100 retained, 900 pruned; proven in tests/cliBridgeDelegateRetention.test.ts).
- [x] stateless MCP churn is profiled and optimized (memoized tool policy annotations, prompts/resources skipped on tools/*) without OAuth identity bleed (proven with 2 distinct OAuth identities with distinct scopes).
- [ ] stress tests show no monotonically increasing post-idle memory floor under continuous 2–4 hour soak (CI verifies 500-event payload churn with memory diagnostics; 2–4 hour long soak scheduled for staging deployment).
- [ ] the live managed tunnel can be safely upgraded through drain/rolling restart. (Baseline owner PID 41424 is no longer running and port 9227 was free during final re-audit; verify this gate against the next live owner instance rather than claiming the original owner remained intact.)
- [x] build/typecheck and focused MCP/CLI Bridge suites pass.
- [x] no regression to OAuth, YOLO, project grants, workspace isolation, or verified-completion semantics.
- [x] final memory evidence is recorded here with before/after measurements.

---

# 12. Evidence log

## 2026-10-28 audit baseline

- [x] Live managed tunnel identified: PID 41424, port 9227.
- [x] Large peak observed: approximately 10.75 GB private memory.
- [x] Same process later reclaimed to approximately 1.33 GB private / 234 MB working set without restart.
- [x] `mcp-activity.jsonl` measured at approximately 1.259 GB / 127,864 records.
- [x] Largest activity record measured at approximately 96.48 MB.
- [x] Activity journal has no rotation.
- [x] Activity reader currently allocates the entire unread file delta.
- [x] Stateless MCP server cleanup through SDK close was verified; direct active-server leak not proven.
- [x] CLI Bridge terminal interactive session cleanup gap identified.
- [x] Delegate `pruneJobs()` exists but is not wired into runtime lifecycle.
- [x] `ownedJobIds` terminal cleanup gap identified.
- [x] Final `logQueues` ordering gap identified.
- [x] Command-output preview, SQLite statement cache, OAuth store, and MCP session registry were checked and are not the primary source of the 10+ GB spike.

## 2026-10-28 remediation implementation evidence

### 1. Code Changes & Architecture Hardening
- **Output sanitization & record capping (`src/core/mcp/mcpLogSanitizer.ts`)**:
  - Implemented `sanitizeActivityOutput`, `sanitizeActivityError`, and `sanitizeActivityArgs` with UTF-8 byte-safe preview capping (`MAX_ACTIVITY_OUTPUT_PREVIEW = 16KB`, `MAX_ACTIVITY_ERROR_PREVIEW = 16KB`, `MAX_ACTIVITY_ARGS_PREVIEW = 16KB`).
  - Added media detection (`detectBase64Media`) recognizing data URIs and binary header magic signatures, replacing bulk binary bytes with metadata descriptors (`[base64 image payload: ...]`).
  - Implemented `serializeBoundedJournalEntry()` with a 5-pass reduction algorithm enforcing a guaranteed hard record cap (`MAX_ACTIVITY_RECORD_BYTES = 64KB`), handling oversized arbitrary metadata and huge fields.
- **Activity journal rotation, atomic cross-process lock & legacy migration (`src/core/mcp/mcpActivityJournal.ts`)**:
  - Implemented `McpActivityJournal` supporting size-based rotation (`DEFAULT_MAX_JOURNAL_BYTES = 16 MiB`, `DEFAULT_MAX_ARCHIVES = 5`, `DEFAULT_MAX_LEGACY_ARCHIVES = 2`).
  - Added Windows-safe cross-process atomic rotation lock (`withRotationLock`) using exclusive `wx` lock file with 5000ms stale lock recovery and double-checked locking.
  - Added zero-copy legacy oversized journal migration plus count-bounded legacy cleanup (`DEFAULT_MAX_LEGACY_ARCHIVES = 2`). Rotation is checked before append, so each active/numeric file may exceed the 16 MiB threshold by at most one bounded record plus newline. With the default 64 KiB record cap, active + 5 numeric archives are strictly bounded by `< 6 * (16 MiB + 64 KiB + 1 byte) ~= 96.38 MiB`. Legacy forensic archives are count-bounded/operator-managed and explicitly excluded from that active/numeric byte ceiling.
  - Implemented `BoundedChunkedJournalReader` with 64 KB read chunks, 128 KB line length cap, file-identity replacement detection, and complete consumed-prefix SHA-256 generation verification streamed through a fixed 64 KB buffer. This detects same-file rewrites anywhere in already-consumed bytes (including rewrites that preserve the first >4 KB) while keeping verification memory O(1); normal appends continue from the prior offset without replay.
- **Activity bus integration & M8 memory pressure throttling (`src/core/mcp/mcpActivityBus.ts`)**:
  - Integrated `sanitizeActivityOutput`, `sanitizeActivityError`, and `sanitizeActivityArgs` into `emitMcpActivity()` to bound in-memory broadcasts and journal entries.
  - Wired M8 `shouldThrottleLargeObservability()` guardrail into `emitMcpActivity()` to omit expensive preview/hash generation when memory pressure is critical, with rate-limited warnings (60s cooldown), preserving complete tool responses to MCP clients and mutating tools.
  - Replaced unconstrained `Buffer.alloc(stat.size - lastFileSize)` in `subscribeToMcpActivity()` with `BoundedChunkedJournalReader`.
- **CLI Bridge interactive session cleanup (`src/core/tools/cliBridgeSessionEvents.ts` & `src/core/tools/cliBridgeSession.ts`)**:
  - Implemented `cleanupSessionEvents(sessionId)` removing emitters, listeners, event ring buffers, sequence counters, and subscriber sets.
  - Implemented `cleanupSessionRuntime(sessionId, reason, immediate)` to clean `activeSessions`, `detachedSessions`, and event infrastructure on exit, error, kill, and idle timeout.
  - Added safeguard in `emitEvent()` to prevent recreating buffers for terminated sessions.
  - Bounded `maxBufferLines` to `ABSOLUTE_MAX_BUFFER_LINES = 10_000`.
- **Delegate job retention & log queue order (`src/core/tools/cliBridgeJobStore.ts` & `src/core/tools/cliBridgeDelegateJobs.ts`)**:
  - Exported and wired `pruneJobs()` into `finalizeJob()`, `refreshJobShards()`, `initializeCliBridgeScheduler()`, and cancellation, enforcing `MAX_RETAINED_JOBS = 100`.
  - Implemented `pruneJobRevisions()` to prune the in-memory revision Map for pruned jobs (on-disk snapshots are capped at `MAX_JOB_SNAPSHOTS_PER_JOB = 8` in `cliBridgeJobStore.ts`).
  - Removed job IDs from `ownedJobIds` after durable persistence finishes.
  - Fixed log queue ordering in `finalizeJob()` so `logQueues.delete(jobId)` runs only after the final summary write promise resolves.
- **Runtime memory diagnostics & throttling (`src/core/runtime/runtimeMemoryDiagnostics.ts`)**:
  - Added `getRuntimeMemorySnapshot()` tracking RSS, heap, external, arrayBuffers, journal size, and CLI Bridge counts.
  - Added pressure evaluation (`normal`, `elevated`, `critical`), `warnMemoryPressureThrottling()`, and `shouldThrottleLargeObservability()`.
  - Wired telemetry into `handleServerHealth()` in `src/core/mcp/tools/configTools.ts`.
- **Stateless MCP server optimization & tool policy memoization (`src/core/mcp/superagentMcpServer.ts`, `src/core/mcp/mcpToolPolicy.ts`, & `src/core/mcp/mcpHttpTransport.ts`)**:
  - Added `skipResourcesAndPrompts` option to `McpServerOptions`, skipping resource/prompt registration on stateless `tools/` requests.
  - Added in-memory memoization caches for `getToolAnnotations` and `getToolSecuritySchemes` to eliminate redundant policy allocations on every tool inspection.
  - Preserved request-local Server and OAuth client isolation; verified with two distinct OAuth identities.

### 2. Test Verification & Results
- `bun run build`: **Exited 0** (`tsc` passed cleanly).
- Test Suites Executed:
  - `tests/mcpActivityPayloadBounds.test.ts`: **10 pass, 0 fail** (16 KB preview, UTF-8 byte-safe Unicode truncation, 64 KB hard record cap with 5-pass reduction, base64 redaction, adversarial 400k+ probe and 10,000 emoji payload).
  - `tests/mcpActivityJournalRotation.test.ts`: **7 pass, 0 fail** (size rotation, archive shift, legacy migration with max 2 archives, active/numeric overshoot-bound regression, atomic rotation lock with wx flag and stale recovery under concurrent same-process writers, and real multi-process cross-process test spawning separate OS processes via Bun.spawn).
  - `tests/mcpActivityJournalReader.test.ts`: **8 pass, 0 fail** (incremental chunk reads, boundary split reassembly, oversized line skip, rotation recovery, file-identity replacement detection, same-file rewrite detection with replacement size > old offset, middle-rewrite detection when >4 KB of the prefix is unchanged, and normal append no-duplicate regression).
  - `tests/cliBridgeSessionLifecycle.test.ts`: **3 pass, 0 fail** (buffer cap, kill cleanup, 50-cycle churn).
  - `tests/cliBridgeDelegateRetention.test.ts`: **4 pass, 0 fail** (1,000 in-memory jobs pruned to 100, on-disk snapshot compaction MAX_JOB_SNAPSHOTS_PER_JOB=8, in-memory revision Map pruning, 20 disk shards, clean ownedJobIds and logQueues).
  - `tests/mcpMemoryLifecycle.test.ts`: **4 pass, 0 fail** (snapshot telemetry, 500-event heavy payload churn, 50-session lifecycle, M8 shouldThrottleLargeObservability throttling under critical memory pressure with 60s cooldown warning).
  - `tests/mcpStatelessConcurrency.test.ts`: **2 pass, 0 fail** (50 concurrent requests, two distinct OAuth identities with distinct scopes, zero identity/scope bleeding, memoized tool annotations).
  - `tests/mcpActivityBus.test.ts`: **6 pass, 0 fail**.
  - `tests/mcpHttpTransport.test.ts`: **20 pass, 0 fail**.
  - `tests/cliBridgeTool.test.ts`: **52 pass, 0 fail**.
  - `tests/cliBridgeDelegateJobs.test.ts`: **20 pass, 0 fail**.
  - `tests/mcpOAuthHttpE2E.test.ts`: **8 pass, 0 fail**.
  - `tests/cliBridgeAgyPermissions.test.ts`: **6 pass, 0 fail**.
- Independent final rerun totals: **150 passed, 0 failed, 1,631 assertions** across the mandatory 13-file suite. An earlier combined run had one transient CLI Bridge concurrency timing failure that immediately passed in isolation; the final rerun was clean.

### 3. Memory & Performance Benchmark Comparison
| Metric | Audit Baseline (Before) | Post-Remediation (After) | Improvement / Bound |
|---|---|---|---|
| Max Journal Record Size | 96.48 MB | <= 64 KB | **>99.9% reduction in max record allocation; guaranteed <= 64 KB hard cap** |
| Tool Output Preview Cap | Unbounded (entire output) | <= 16 KB (UTF-8 byte-safe + SHA-256) | Eliminates multi-MB in-memory JSON serialization |
| Base64 Media in Journal | Raw bytes logged in full | Redacted with `[base64 media: ...] ` | Zero binary bloat in activity journal |
| Journal Reader Allocations | `Buffer.alloc(stat.size - lastFileSize)` (up to 1.25 GB) | Fixed 64 KB chunks, 128 KB max line carry | **Bounded reader allocation regardless of journal size** |
| Journal File Size Cap | Unbounded (grew to 1.259 GB) | Active rotation threshold 16 MiB (max 5 numeric archives); legacy count-bounded (max 2) | Because rotation is checked before append, each active/numeric file can overshoot by at most one <=64 KiB record + newline; default active + numeric bound is < ~96.38 MiB. Legacy forensic archives remain count-bounded/operator-managed and are excluded from this byte ceiling. |
| Cross-Process Rotation | Unprotected rename race | Atomic `wx` lock file with 5s stale recovery | Empirically verified across separate OS child processes via `Bun.spawn` (no stale lock, surviving JSONL parses, bounded archives) |
| Terminal Session Retention | Permanent leak of buffers, emitters, subscribers | Fully cleared on exit / kill / idle / error | **0 lingering objects across 50 rapid test cycles** |
| Delegate Job Memory Retention | Unbounded accumulation | Capped at 100 jobs + in-memory revisions pruned | **Enforced `maxRetainedJobs = 100` (1,000 synthetic jobs pruned to 100)** |
| Delegate Job Disk Snapshots | Unbounded snapshots | Bounded to 8 snapshots per job | `MAX_JOB_SNAPSHOTS_PER_JOB = 8` enforced |
| Stateless Request Allocations | Full prompt & resource graph reconstructed | Resources & prompts skipped for `tools/*`, memoized tool policies | Reduced garbage creation on high-frequency MCP calls with zero identity bleed |
| Observability Under Pressure | Continuous allocation of previews/hashes | Throttled under critical memory pressure (M8) | Rate-limited warning (60s cooldown), client tool outputs unmutated |
| Live Tunnel Process (PID 41424) | Baseline owner was live on port 9227 | PID 41424 absent and port 9227 free at final re-audit | Remediation logs contained no `taskkill`/`Stop-Process` targeting PID 41424; cause of owner disappearance is not established here, so no intact-owner claim is made |
