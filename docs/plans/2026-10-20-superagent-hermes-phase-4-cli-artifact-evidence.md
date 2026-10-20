# Hermes Phase 4 — CLI Bridge Artifact Evidence and Concurrent Output Claims

**Date:** 2026-10-20
**Status:** Bounded local implementation; cross-provider production acceptance remains open
**Canonical plan:** `docs/plans/2026-10-18-superagent-hermes-like-implementation-master-reference.md`
**Depends on:** `docs/plans/2026-10-20-superagent-hermes-phase-4-cli-bridge-workspace-isolation.md`

## Problem and contract

Before this increment, a CLI Bridge background job was marked `succeeded` whenever its process returned exit code 0. That is evidence of **process execution**, not completed work. A model's textual claim of success must not replace evidence of file changes.

`cli_bridge` `action=delegate.start` now accepts optional `expectedArtifacts: ["relative/path.ext", ...]`.

- **Omitted:** legacy process status `succeeded` is retained after exit 0, but `completionState=unverified` (no task proof).
- **Declared and all produced/changed:** status `succeeded`, `completionState=artifacts_verified`, and per-artifact path, SHA-256 digest, byte count and `created`/`updated` state. This is **file-change evidence only**, not semantic correctness or authorship attestation.
- **Declared but missing, unchanged, invalid or oversized:** status `verification_failed`, `completionState=artifact_verification_failed` even if exit code is 0. Per-artifact states remain inspectable.
- **Nonzero exit, timeout, cancellation and interrupted restart:** never promote to artifact-verified success. Completion states preserve the failed/timed-out/cancelled/interrupted outcome. Live output claiming otherwise is not trusted.
- The original `delegate` blocking action rejects `expectedArtifacts` explicitly rather than ignoring it. Structured proof for synchronous delegations is a separate future increment.

## Bounded implementation

`src/core/tools/cliBridgeArtifactEvidence.ts` holds scoped, pre-run and post-run file fingerprints. All declared file paths must be relative to the effective delegated cwd and inside the already-authorized caller workspace; path traversal, absolute paths, duplicates, symlink escapes, and existing non-files fail closed. A maximum of **12 artifacts** is allowed, each **10 MiB** or less. File content is not copied into job metadata.

`src/core/tools/cliBridgeDelegateJobs.ts` reserves expected output claims synchronously in-process **before any await for snapshots or filesystem IO**. Canonical keys collapse case differences on Windows and in-workspace symlink aliases. A second simultaneous job targeting the same canonical output path is rejected; independent file claims remain parallel. Locks are released on every terminal path and start-up failure.

Job metadata persists `expectedArtifacts`, `completionState` and `artifactEvidence` through the existing persisted job registry. Initial content digests and active locks live only in memory; after restart, active jobs are marked `interrupted`, never reconstructed as verified.

`src/core/tools/cliBridgeTool.ts` exposes evidence in `delegate.start`, `delegate.jobs`, `delegate.get` and `delegate.tail`. Existing callers need not opt in and continue to see the process-level status, with `unverified` disambiguation.

## Verification

The updated `tests/cliBridgeDelegateJobs.test.ts` covers:

- Bare exit 0 remains unverified
- Newly created and modified files yield stored SHA-256 evidence
- Unchanged/missing files override false success
- Concurrent collision rejection and independent parallel files
- Claimed-file reuse after terminal completion
- Invalid/outside/symlink paths, duplicate targets, and oversized files
- Failure, timeout and cancellation preventing proof promotion
- Real `cli_bridge delegate.start/get/tail` output contract

Run:

```bash
bun run build
bunx vitest run tests/cliBridgeDelegateJobs.test.ts tests/cliBridgeWorkspaceIsolation.test.ts tests/cliBridgeTool.test.ts tests/projectProvider.test.ts tests/mcpWorkspaceBoundary.test.ts
bunx vitest run --reporter=default --maxWorkers=3
```

## Known limitations and next gates

**Not an OS sandbox, semantic task verification, or cryptographic authorship attestation.** An authorized local process sharing filesystem permissions can modify declared files. The hash is a bounded local change observation and cannot establish which process wrote a file. Checks are not atomic against a malicious concurrent filesystem actor.

Artifact collision claims are **per SuperAgent process only**. Cross-process/host locking, SSH/remote artifact hashing, live provider errors, process-tree reliability under OS failure, signed completion manifests, artifact-specific acceptance criteria, and staging remain open.

Also outstanding: live MCP OAuth project grants; RMemory gateway/provider replay; Phase 4 full external acceptance. Do not label the migration production-ready on this increment alone.


## Final local acceptance — 2026-10-20

- `bun run build`: passed.
- `bun run verify:extension-js`: passed (8 extension JavaScript files).
- `bun run wiki:validate`: passed (9 wiki files, 24 checked links).
- Focused CLI/Workspace/Delegation regression `vitest`: **97 tests passed in 7 suites**. An initial run exposed a terminal status versus disk metadata persistence race; terminal reads now await the job's final persisted write and the focused suite passed on rerun.
- Final full `bunx vitest run --reporter=default --maxWorkers=3`: **exit code 0**, **370 test files passed, 1 skipped; 3,548 tests passed, 5 skipped; 0 failed**.
- `git diff --cached --check`: passed after staging and Markdown whitespace cleanup.

The focused and full suite overlap, so their test totals must not be added. Production provider/SSH/OAuth and external staging gates remain open.
