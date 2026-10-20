# Hermes Phase 4 — Safe Per-Job Metadata Retention

**Date:** 2026-10-20
**Scope:** CLI Bridge local per-job metadata, not remote or distributed execution
**Parent reference:** docs/plans/2026-10-18-superagent-hermes-like-implementation-master-reference.md
**Prior implementation:** docs/plans/2026-10-20-superagent-hermes-phase-4-cli-job-shards.md

## Failure mode

CLI Bridge writes a new immutable JSON checkpoint for every job-state persistence event under cli-bridge/delegations/jobs.d/<jobId>/. Without retention, a long-running or frequently updated job can accumulate unbounded files. Global cleanup is unsafe because the config root may be shared by multiple live SuperAgent processes.

## Bounded implementation

- src/core/tools/cliBridgeJobStore.ts now retains the **8 newest committed JSON snapshots per owned job** after a successful new snapshot write.
- Compaction runs only against the **specific job directory of the writer** after its new checkpoint is committed by a unique temporary file and rename. It never scans or deletes peer job folders.
- The newest committed snapshot must be valid JSON with the expected job ID before any old revisions are removed. An invalid newest state pauses compaction.
- Readers continue to fall back to a previous valid checkpoint when a newer file is unreadable.
- Files that do not match the exact snapshot filename pattern, including .tmp, notes and operator-created files, are **never** deleted.
- Only regular files are removed. Symlink entries and directories are skipped.
- Cleanup failures do not roll back successful writes. The append is authoritative; compaction is best effort.
- jobs.json remains a non-authoritative compatibility cache. This change does not alter job ownership, locks, cancellation or replay.

## Local acceptance

tests/cliBridgeJobStoreRetention.test.ts covers 30 successive checkpoints, latest-version recovery, preservation of peer jobs and unrelated files, and fail-closed retention with an invalid newest checkpoint.

Existing suites exercise actual CLI subprocesses, workspace ownership, cross-process artifact claims and two SuperAgent processes sharing the same config root.

## Remaining gates

- Bounded snapshots **per job** do not bound total jobs or log bytes. Global archival and retention need a separate ownership-safe policy.
- No automatic reattachment of subprocesses, orphan cleanup or stale-lock stealing.
- OS-level isolation of untrusted local executables is not provided by application-level file naming.
- Remote SSH/OAuth authorization, heterogeneous provider errors and staging restart recovery remain open.

Do not certify overall Hermes Phase 4 production readiness based on local tests.

## Final local verification — October 20, 2026

- bun run build: passed.
- bun run verify:extension-js: passed (8 extension files).
- bun run wiki:validate: passed (9 wiki documents and 24 links).
- Focused Vitest (retention, cross-process claims, delegation jobs and CLI Bridge): **76/76 tests passed across 4 suites**.
- Final full bunx vitest run --reporter=default --maxWorkers=3: **exit 0; 372 suites passed, 1 skipped; 3,558 tests passed, 5 skipped; 0 failed**.
- git diff --cached --check: passed. Focused and full counts overlap; they must not be added.

These results verify local behavior only. Crash-recovery, global job/log storage retention, live SSH/OAuth, and staging remain open release gates.
