# Hermes Phase 4 — Process Start Identity Diagnostics

**Date:** 2026-10-20
**Scope:** Bounded local CLI Bridge recovery evidence, not automatic crash recovery
**Previous increment:** docs/plans/2026-10-20-superagent-hermes-phase-4-cli-recovery-diagnostics.md

## Failure mode

A numeric owner PID can be reused after an instance crash. A simple PID-present observation can mistake an unrelated process for the original SuperAgent owner. PID absence does not establish that children or grandchildren have stopped.

## Implementation

- src/core/tools/cliBridgeProcessIdentity.ts reads the OS process creation fingerprint on **Windows** (Win32_Process CreationDate UTC ticks via bounded PowerShell CIM probe) and **Linux** (kernel boot ID plus /proc/PID/stat start-time ticks). Other systems return unknown.
- New CLI background jobs store an optional ownerProcessIdentity and an optional childProcessIdentity in their authoritative immutable metadata. The child probe is **asynchronous after registering stdout, stderr and exit listeners**, so slow OS queries never delay output capture or background starts.
- The owner fingerprint is observed once per SuperAgent process and reused for subsequent starts. Child identity is best-effort; very short-lived processes may exit before the OS fingerprint is read.
- delegate.recovery compares stored owner/child start metadata with fresh OS observations. A mismatch is flagged as a potential PID reuse; a match remains **matched_unverified**, not an attestation that descendants or artifact writers stopped.
- Legacy jobs without fingerprints and probe failures stay unknown. Recovery inspection never changes job status, reattaches, kills, unlocks or rewrites a peer job.
- The tool response reports only comparison states, not raw fingerprints. Workspace authorization is applied before probing a job.

## Local tests

Tests cover live OS process birth observation, comparison of sequential process starts, matches/mismatches, fabricated stale job records using a reused live PID, cross-workspace denial, and preservation of captured CLI output while an OS probe runs.

## Explicit limitations

- Neither Windows CIM start ticks nor Linux proc metadata are cryptographic remote attestations; only host-local observations.
- PID + birth-time matching does not prove that all descendants have exited, a worktree is safe, or a stale output lock can be released.
- Child snapshots can be unavailable when a CLI exits too quickly. That condition must not become a false mismatch or authorize cleanup.
- Multi-host/SSH process identity, OAuth permissions, staged restart tests and automatic recovery remain open, and these tests must not be described as Phase 4 production certification.

## Final local acceptance — 2026-10-20

- TypeScript build: passed.
- Extension JavaScript verification: passed (8 JavaScript files).
- Wiki validation: passed (9 wiki documents, 24 links).
- Focused recovery, birth-identity, delegate jobs, workspace and CLI Bridge suites: 89/89 tests passed across 6 suites.
- Final full Vitest regression (maxWorkers=3): **exit code 0**, **374 suites passed, 1 skipped; 3,571 tests passed, 5 skipped; 0 failed**.
- A first focused run detected a real Windows output-capture race from waiting on process birth metadata before registering listeners. The child probe was moved off the delegation critical path; the focused and full reruns passed.
- Focused and full totals overlap. Owner/child birth fingerprints are read-only diagnostic observations, not proof that remote children stopped.

SSH provider execution, live MCP OAuth grants and production crash/restart acceptance remain unverified.
