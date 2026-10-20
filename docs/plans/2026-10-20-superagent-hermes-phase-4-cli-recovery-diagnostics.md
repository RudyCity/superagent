# Hermes Phase 4 — Read-Only CLI Job Recovery Diagnostics

**Date:** 2026-10-20
**Status:** Local read-only diagnostic implementation; crash recovery execution remains operator-gated.
**Previous increment:** docs/plans/2026-10-20-superagent-hermes-phase-4-job-shard-retention.md

## Problem

Background jobs owned by another SuperAgent runtime may still appear `starting`, `running` or `cancelling` after the original owner disappears. A different runtime cannot safely assume that an absent parent PID means the CLI process tree has exited. Conversely, PID presence does not prove that the observed process is the original owner, due to PID reuse.

## Implemented contract

- New CLI Bridge action **`delegate.recovery`** requires `jobId` and enforces the same workspace authorization as `delegate.get`. Foreign workspace callers receive the same generic not-found response, with no leaked PID or job metadata.
- New job records capture `ownerPid` for the initiating SuperAgent runtime. Legacy jobs without an owner PID remain explicitly **unknown**.
- `src/core/tools/cliBridgeRecovery.ts` classifies terminal records, current in-memory owner handles, foreign owner PIDs present but unverified, absent owner PIDs needing manual review, and uncertain or legacy ownership.
- Both owner and child PID probes are **read-only**. Numeric PID existence is described as `pid_present_unverified`, never as verified process identity. Permission errors are `unknown`.
- The persisted job status, output evidence and on-disk snapshots are **not mutated** by recovery inspection. No kill, auto-restart, reattach, stale-lock deletion or recovery ownership takeover is introduced.
- For orphan-suspected jobs, operators must inspect process descendants and `delegate.claims` lock status separately before any manual intervention.

## Verification

`tests/cliBridgeRecovery.test.ts` exercises the classifier and PID probing limits, including old records without parent identities. Additional tests in `tests/cliBridgeDelegateJobs.test.ts` exercise a real owned subprocess and a synthetic foreign persisted job, verify other workspace denial, and confirm cancellation cannot mutate a foreign job without a local process handle.

## Remaining gates

- No reliable process identity attestation from numeric PIDs alone. OS process creation-time checks, process-tree reconciliation and signal-safe recovery require separate design and live testing.
- Crash-time child/grandchild shutdown is not established. Artifact claims deliberately remain fail-closed after owner loss.
- Cross-host SSH execution, MCP OAuth grant/deny, staging restarts and true provider runtime failures remain unverified.

Do not mark overall Phase 4 production-ready based on these local recovery diagnostics.


## Final local acceptance — October 20, 2026

- TypeScript build: passed.
- Extension JavaScript verification: passed (8 JS files).
- Wiki validation: passed (9 wiki documents and 24 links).
- Focused CLI recovery, delegation, cross-process claims, workspace and tool suites: 83/83 tests passed across 5 suites.
- Final full Vitest (maxWorkers=3): **exit 0**, **373 suites passed, 1 skipped; 3,565 tests passed, 5 skipped; 0 failed**.
- git diff --cached --check passed. Focused and full totals overlap and should not be added.

These prove local read-only behavior; live SSH/provider, child-process identity attestation, and production staging remain unverified.
