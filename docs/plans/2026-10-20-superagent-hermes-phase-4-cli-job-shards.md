# Hermes Phase 4 — Multi-process CLI Job Metadata

**Date:** 2026-10-20
**Status:** Bounded local implementation; live production acceptance remains open.
**Previous increment:** `docs/plans/2026-10-20-superagent-hermes-phase-4-cross-process-artifact-claims.md`

## Problem

Previously each SuperAgent process rewrote a shared `cli-bridge/delegations/jobs.json` snapshot. Two instances sharing a config directory could overwrite another instance's jobs and incorrectly label a still-running peer as interrupted on restart.

## Implementation

- `src/core/tools/cliBridgeJobStore.ts` provides authoritative immutable per-job metadata snapshots in `cli-bridge/delegations/jobs.d/<jobId>/`, committed via unique temporary files and renames. This avoids Windows delete-then-rename windows for previously existing files.
- Each process persists only its own jobs. Readers refresh peer shards and must never mutate foreign active jobs or infer a live peer's death from missing local process handles.
- Legacy `jobs.json` is read as a migration/compatibility fallback. A shard overrides a corresponding legacy record. The aggregate JSON file is best effort and is **not** the source of truth for multi-process reads.
- The per-process job reset helper removes only its own shard directories, not a peer's.
- Completed local jobs are not needlessly re-snapshotted on subsequent persistence passes.

## Acceptance and limitations

- Local Node processes sharing one config root simultaneously start and finish separate CLI jobs, preserving both authoritative records.
- Existing background job, artifact proof, workspace isolation and cross-process locking tests must continue to pass.
- The snapshot journal is append-only and not yet compacted. Automatic retention/compaction and orphaned subprocess reconciliation need their own safe design; never delete records belonging to a live peer.
- This is not shared-host global job concurrency enforcement or distributed locking. Existing in-process concurrency ceilings still apply per instance.
- Production SSH/OAuth, cancellation after crash, and live provider end-to-end remain open.

## Verified local acceptance

- TypeScript build, extension JavaScript verification (8 files) and wiki validation (9 documents, 24 links): passed.
- Focused `cliBridgeDelegateJobs`, `cliBridgeCrossProcessClaims`, `cliBridgeTool`: 73 tests passed, 3 suites.
- Two independent child processes sharing the **same config root** both produced authoritative completed job records.
- Full `bunx vitest run --reporter=default --maxWorkers=3`: **exit code 0; 371 suite passed, 1 skipped; 3,555 tests passed, 5 skipped; 0 failed**.
- These focused and full test counts overlap; they are not additive.
- Remaining: snapshot compaction, safe crash-recovery decisions and live SSH/OAuth/provider acceptance.
