# SuperAgent Runtime Supervisor — Batch 5 Independent Pre-Merge Audit

Date: 2026-10-29
Auditor: Independent follow-up through the @s90 SuperAgent connector
Branch: `agent/runtime-supervisor-m1-coverage-m2-reaper-20261028`
Reviewed HEAD: `1b0ff4d7`
Status: **BLOCK MERGE — SECURITY / CORRECTNESS GATES NOT MET**
Scope: Read-only code review, isolated runtime reproductions in ephemeral locations, regression tests. No production code edited; no commit, merge, rebase, push, or reset.

## Confirmed findings

### P0-1 — Unsafe restart retry in CLI Bridge outside Batch-5 reconciliation path

Source: `src/core/tools/cliBridgeReconciliation.ts:92-101,155-180`.

`reconcileJobOnRestart()` decides a job is read-only if `job.hasMutatingWrite === false` **or** `checkpoint.hasMutatingWrite === false`, even when checkpoint is missing, invalid, or belongs to another job. This bypasses the strict checkpoint handling added to `processReconciliation.ts`.

Independent live reproduction (no external side effects):
- `{jobId:'job_no_checkpoint',status:'running',pid:null,hasMutatingWrite:false}` with `checkpoint=null` => `reconciledStatus:'interrupted', eligibleForRetry:true, requiresReview:false`.
- Same job with mismatched checkpoint `checkpoint.jobId:'other_job', checkpoint.hasMutatingWrite:false` => same unsafe eligibility.
- Prior `job.status:'unknown_outcome_review_required'` => returns `requiresReview:false` despite the terminal status requiring manual inspection (though `eligibleForRetry:false`).

Risk: duplicate writes if in-memory job classification is stale or incorrect, or if the checkpoint was not durably retained. Fix all restart paths to require positive, validated, matching durable proof of read-only behavior. Preserve review status on already-flagged jobs and test actual retry consumers.

### P0-2 — TOCTOU stale-lock race can delete a newly acquired active registry lock

Source: `src/core/process/processRegistry.ts:430-443, 468-475`.

The stale-lock recovery compares the lock token, PID and creation time after reading `lockPath`, then performs a **separate** `fsp.unlink(lockPath)` operation. Another process can replace that file after verification and before unlink. Similar read-then-unlink window exists in lock finalizer. The checked identity is not bound atomically to the removal operation.

Deterministic injected-interleaving reproduction used a temporary registry and lock:
1. Create a stale lock for a dead PID.
2. When stale-recovery performs its final lockfile read, return the old content but replace the path with a new valid lock owned by the current PID and token `active_new`.
3. Observe the next unlink.

Exact observed result: `{"outcome":"saved","lockReads":3,"replaced":true,"deletedActive":true}`.

This proves the process can remove a replacement lock, defeating exclusive-writer guarantees. It is not a claim that normal two-process operation always hits this timing; it is a reproducible interleaving and needs an atomic, identity-safe lock design (e.g., persistent OS file locking / single-writer service, or an implementation with reliable replace/unlink identity guarantees). Test both stale reclaim and finalization races across independent writers.

### P1-1 — Unauthenticated privilege switch in process diagnostic API

Source: `src/core/process/processSupervisor.ts:76-87,399-455,478-525`.

The function treats `filter.isPrivilegedOperator === true` as sufficient to expose host-wide process entries with full workspace/job metadata. No authenticated operator identity, verified capability, or authorization check is performed in the function.

Independent in-memory reproduction:
`getProcessDiagnostics({callerWorkspaceRoot:'D:/other'})` => `totalTracked:0`.
`getProcessDiagnostics({callerWorkspaceRoot:'D:/other',isPrivilegedOperator:true})` => `totalTracked:1` and the foreign job ID `private_job` appears.

An external exploit path has **not** been established; source search found no production call site setting `isPrivilegedOperator` beyond this API. The issue is a missing trusted authorization boundary if this API is exposed to future user-controlled tooling, plugins or extensions. Require authorization validated in a trusted operator context, not a caller-controlled boolean.

### P1-2 — Existing unknown-outcome review flag can be lost on restart

Same CLI Bridge logic: when `job.status==='unknown_outcome_review_required'`, the early terminal-status return says `requiresReview:false`. This can suppress review indications downstream despite blocking retry. Ensure `requiresReview` is preserved consistently with terminal status.

### P2-1 — Local Windows test environment lacks free C: disk space

During audit:
```
Filesystem                              Size  Used  Avail  Use%
D:                                      352G  291G   61G    83%
C:/Users/USER/AppData/Local/Temp        601G  601G    0G   100%
```

The initial full regression execution failed with `ENOSPC`, including writes to registry and temporary test files. No user files or caches were deleted.

After redirecting `TEMP` / `TMP` / `TMPDIR` to a dedicated D: test directory:
- Full matrix: **168 passed, 3 failed, 2 errors, 847 assertions across 15 suites**. The three failures were 5-second timeouts involving registry concurrency, worktree creation, and 2-process registry tests; one `EBUSY` cleanup / Git worktree creation failure followed a timed-out test.
- Focused retry of the three relevant suites with 30-second timeout: **44 passed, 0 failed, 242 assertions, 3 suites**.

Those timeouts alone do not prove a deterministic production bug. C: disk exhaustion is an independent operating risk and affects assurance quality. Restore free space by an operator-approved cleanup, then run the full matrix under normal conditions and Windows host restart/crash soak.

### Passing checks / improvements

- `bun run build`: PASS (`tsc` and schema sync).
- `git diff --check 70af5b46..HEAD`: PASS (earlier whitespace errors resolved).
- Batch 5 hardened `processReconciliation.ts` for missing checkpoints and conflicting exits, `processRegistry.ts` for read errors, and basic workspace-scoped diagnostics.
- Separate fault-injection reproductions were performed without touching the main or production registry.
- Automatic orphan reaping, process adoption and mutation replay were not enabled.

## Pre-merge release gates

1. P0: Correct and regression-test *all* restart reconciliation paths, including `reconcileJobOnRestart()`; require matching, validated, durable checkpoint evidence for retry eligibility and retain explicit review flags.
2. P0: Replace the non-atomic lockfile check-then-unlink pattern with a mechanism that cannot delete a replacement lock. Add deterministic replacement-between-check-and-unlink regression and true cross-process load tests.
3. P1: Make global diagnostic privilege a server-side authenticated capability, not `isPrivilegedOperator:true` supplied by a caller. Ensure the operator path is intentionally wired and documented.
4. P2: Address full C: storage before normal Windows testing. Rerun full supervisor and splash matrix, real Windows restart/crash/AV contention tests, and verify no leaked descendants.
5. Keep `main` untouched until independent gates pass. At audit time branch was `2` commits behind and `5` ahead of `main`, with uncommitted parallel work on main. No broad reset, stash, or `git add -A`.

## Evidence commands

- Runtime repro of `reconcileJobOnRestart`: `cmd_1793230095922_2pohh`.
- Privileged boolean bypass repro: `cmd_1793230097463_8mpw2`.
- Stale-lock TOCTOU injected interleaving repro: `cmd_1793230124695_z1fo6`.
- Initial matrix with C: ENOSPC: `cmd_1793230135941_7bbfj`.
- Disk-space verification: `cmd_1793230224955_hnep5`.
- Full matrix on D: temp (168/171): `cmd_1793230243611_2vngx`.
- Focused 44/44 rerun: most recent audit command using `bun test --timeout 30000`.
- Build, commit delta check, source search: `cmd_1793230174775_4bjwr`.

**Decision: BLOCK MERGE, NOT PRODUCTION CERTIFIED.**