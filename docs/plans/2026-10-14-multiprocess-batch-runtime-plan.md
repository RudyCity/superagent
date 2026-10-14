# Multi-process Runtime and Batch Safety — 14 October 2026

## Goal

Make safe, independent file operations use bounded operating-system processes and ensure both single-agent and multi-agent tool execution consume the same batch-first APIs. A batch must never route or pass approval guards based only on its first path.

## Delivered in this implementation

- [x] Added `src/core/agent/ProcessPool.ts`: ephemeral Node OS workers for local file-read batches.
- [x] Capped local read pool globally at four child processes across simultaneous batches and 50 files per tool call.
- [x] Added per-worker timeout (30 seconds by default), cancellation, stdout/stderr caps, result-shape validation, failure metrics, and bounded inline fallback.
- [x] Preserved input order in output regardless of process scheduling.
- [x] Added `getProcessPoolMetrics()` and safe MCP diagnostic `superagent_process_pool_status`.
- [x] Added shared `mapConcurrentOrdered` with bounded concurrency, input-order results, early stop scheduling on failures, and abort support.
- [x] Capped local multi-file mutations and MCP workspace file batches at six concurrent operations; capped SSH file reads/writes/edits similarly.
- [x] Removed legacy root-level single-file fields from the exposed read/write/replace/multi-replace/patch schemas. The batch array is required even for one file.
- [x] Rejects mixed local-config/session and SSH-remote targets in one batch; all targets are classified before routing.
- [x] Added batch-wide path checks in ToolExecutor and blocks batches that mix plan/task/walkthrough artifacts with source files.
- [x] Plan edits using `replace_file_content` are considered by plan validation. `apply_patch` is blocked on the plan file because ToolExecutor cannot reliably infer the final plan content from a generic patch payload.
- [x] Added process-pool and concurrency tests, including simultaneous-batch global cap and Unicode-output cases.

## Runtime contract

### Worker process

The parent validates and resolves all paths before dispatch. The child receives only a JSON list of file-read jobs; it has no tool registry, shell execution entry point, LLM credentials, or file mutation code. The parent owns cancellation, output caps, result ordering, fallback, and metrics. Workers are ephemeral per batch, so there is no long-lived worker heartbeat or replacement loop to manage.

### Scheduling and batching

- Use batch API fields in both single-agent and multi-agent modes: `filePaths`, `files`, `edits`, or `patches`, including for one item.
- Preserve item ordering when presenting results.
- Mutations to the same target file must remain within a single batch item (where appropriate) so the file-level lock protects a coherent operation.
- Independent targets run with a bounded concurrency of six for local/SSH/MCP operations.
- The ToolExecutor groups adjacent independent read-only calls into parallel groups. Mutations, shell commands, approval/question handlers, and unknown/stateful tools are ordered barriers; calls on either side of a barrier are not reordered.
- Local config/session paths cannot be mixed with remote SSH workspace paths within the same batch.
- Plan/task/walkthrough targets must be modified separately and retain existing tier-specific approval/allowlist checks.

## Observability

Call MCP tool `superagent_process_pool_status` to inspect:
- spawned/completed/failed worker counters,
- timeout and fallback counts,
- active and peak concurrent workers,
- last worker duration.

Counters are in-memory for the lifetime of the SuperAgent process and reset when the process restarts. The local file-read worker itself is an isolated Node process; general search, shell, LLM calls, and full Agent objects do not yet run in this pool.

## Important remaining architecture work: full Agent/subagent OS processes

This change **does not claim that each Agent or Subagent is itself an OS process**. Agent instances currently hold non-serializable runtime state: callbacks, event handlers, approval/question handlers, cancellation controllers, conversation history, tool permissions, in-memory subagent maps, and parent/child references. Spawning that object blindly would break human handover, tool authorization, live status, and cancellation.

The next phase must implement an explicit, versioned IPC protocol before migrating full Agent/subagent execution:

1. Define serializable messages: `START`, `EVENT`, `TOOL_APPROVAL_REQUEST`, `QUESTION_REQUEST`, `RESPONSE`, `CANCEL`, `HEARTBEAT`, `RESULT`, and `ERROR`.
2. Add a parent-side RemoteAgent/worker supervisor so current subagent UI/status APIs continue to work without holding a live child Agent object.
3. Keep permission decisions in the parent; children may request approval but cannot self-authorize.
4. Add per-worker heartbeat, graceful shutdown, kill-tree fallback, restart policy, and log correlation IDs.
5. Move each subagent's history writes to a process-safe per-session boundary and verify cancellation/recovery semantics.
6. Gate migration behind a feature flag; test that both single and multi modes use this same process supervisor and that no legacy in-process Agent path remains after parity is proven.
7. Benchmark process startup overhead, throughput, memory pressure, and failure recovery before enabling for every task type.

Do not mark phase 2 complete until IPC tests cover tool approval, user questions, event streams, output ordering, worker failure, cancellation, and session persistence.

## Verification

- `bun run build`
- `bun x vitest run tests/ProcessPool.test.ts tests/concurrency.test.ts`
- Focused run excluding the slow tier-resolution suite: 17 test files, 173 tests passed. The six cases in `tierToolsetResolution.test.ts` also passed across the combined and isolated runs, but combined runs intermittently hit the 30–60 second per-test timeout for different cases; the two slow cases passed when isolated (29.5s and 86.9s).

The full Vitest suite was not used as a completion signal because it has timed out in previous attempts; focused regression coverage is reported separately.
