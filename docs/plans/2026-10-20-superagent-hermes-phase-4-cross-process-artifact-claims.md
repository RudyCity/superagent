# Hermes Phase 4 — Host-local Cross-Process Artifact Claims

**Date:** 2026-10-20
**Status:** Bounded local implementation and independent-process regression accepted; external provider/staging sign-off remains open.
**Reference:** `docs/plans/2026-10-20-superagent-hermes-phase-4-cli-artifact-evidence.md`

## Why this increment exists

The initial artifact proof gate reserved output paths only in `cliBridgeDelegateJobs.ts` memory. Two independent SuperAgent processes with different `SUPERAGENT_CONFIG_DIR` values could start jobs for the same canonical file, corrupt each other's output and each incorrectly claim a successful artifact.

This increment extends output claims to **independent SuperAgent processes on the same host under a shared per-user temp directory**. The lock guards file ownership during start, execution, hashing and finalization; it is not a distributed filesystem or permission sandbox.

## Implementation

`src/core/tools/cliBridgeCrossProcessClaims.ts` creates lockfiles with atomic `fs.open(..., "wx", 0o600)`. The name is SHA-256 of the artifact's canonical filesystem identity; filenames never expose the output path. Locks live in the host-local directory `os.tmpdir()/superagent-cli-bridge-artifact-claims-v1`, separate from each instance's config folder. This avoids the false assumption that two instances use the same config folder.

- Multiple claims are canonicalized, deduplicated and acquired in stable sorted order. If one file is already claimed, newly acquired claims from this request are rolled back.
- Metadata contains an unguessable 192-bit owner token, job ID, owner process ID and creation time. Release requires matching token/job ID; malformed or replaced lockfiles are not silently deleted.
- A job takes the host-local claim **before** reading its pre-run SHA-256 snapshot, spawning a child or writing normal run metadata.
- Normal termination, failed start, timeout and cancellation attempt claim release; release failures retain a fail-closed lock and are surfaced in job error metadata for operator review.
- In-process claims remain as a fast guard; host-local claims are the independent-instance guard.
- Lock-acquisition failure never launches the CLI child.

## Read-only operator diagnostics

The cli_bridge action=delegate.claims supports expectedArtifacts with 1-12 relative file paths and optionally a child cwd. It reports a selected file's canonical lock status and owner job/PID when available without revealing owner tokens or deleting locks. The same workspace and symlink boundaries as delegate.start are enforced; another project cannot inspect foreign output claims.

The action intentionally never performs stale-lock cleanup. PID disappearance alone is not proof that child CLI writers stopped. An operator must investigate all descendants before any manual recovery.

## Crash and recovery policy

Locks are **not expired or stolen automatically**, even if the recorded owner PID is missing. The owner process can crash while an independently spawned CLI subprocess continues writing its expected artifact. PID disappearance or elapsed time alone cannot establish that it is safe to grant a competing writer.

An operator investigating an orphaned lock must identify the relevant output, inspect the lockfile and job, confirm the owner *and any child/descendant subprocesses* have stopped, then explicitly remove the matching stale lock. The internal read-only `inspectCrossProcessArtifactClaim(identity)` provides metadata; `releaseCrossProcessArtifactClaims` requires the original owner token, preventing accidental release by a competing job. This is a deliberate availability trade-off to preserve output integrity.

**Limitations:** This is a **same-host, cooperative-writer** mechanism, not a mandatory OS filesystem sandbox; untrusted executables can still modify other files. Multiple hosts with separate temp directories do not share locks. Child/grandchild process tree termination is not formally verified by these locks; crash cleanup must be operator-gated. The shared `jobs.json` metadata store is not upgraded to a transactional multi-writer store by this increment. That remains a follow-up task.

## Real process verification

`tests/cliBridgeCrossProcessClaims.test.ts` launches real independent Node processes through `tests/fixtures/cliBridgeCrossProcessWorker.mjs`. It tests:

1. Competing claims across independent instances/config dirs, normal release and reacquisition.
2. Multi-file acquisition rollback on later-file contention.
3. Parent crash leaves the orphaned claim blocked until explicit token-checked cleanup.
4. Forged owner token cannot delete another process's lock.
5. Real `startDelegateJob` in one process prevents a competing background CLI job in another, then allows a follow-up job after normal termination.

The existing 14-job `cliBridgeDelegateJobs.test.ts` suite continues covering expected artifact hashing, timeout/cancellation, workspace, symlink aliases, output collisions and legacy exit-code compatibility.

## Release criteria

Run:
```bash
bun run build
bunx vitest run tests/cliBridgeCrossProcessClaims.test.ts tests/cliBridgeDelegateJobs.test.ts tests/cliBridgeWorkspaceIsolation.test.ts tests/cliBridgeTool.test.ts
bunx vitest run --reporter=default --maxWorkers=3
bun run verify:extension-js
bun run wiki:validate
```

Still unverified: distributed lock broker for multi-host deployments, concurrent `jobs.json` writers with shared config, live SSH/OAuth project grants, child-process-tree crash recovery, untrusted-agent OS sandboxing, provider cancellation/outage E2E, and production staging. **Do not mark all Hermes Phase 4 or production readiness complete.**


## Tunnel setup test hardening

The tunnelClientSetup unit test now mocks the external global npm installation subprocess. Its graceful failure case and npm argument checks run offline; tests no longer perform actual system-wide npm installations. Production installation code is unchanged.


## Final diagnostics / tunnel test acceptance (2026-10-20)

- TypeScript build: passed.
- Extension JavaScript verification: passed (8 files).
- Wiki link validation: passed (9 wiki documents, 24 checked links).
- Focused diagnostic/delegation/tunnel tests: 94 tests passed across 5 suites.
- Full Vitest regression after offline tunnel test fix: **exit 0**, **371 suites passed, 1 skipped**, **3,554 tests passed, 5 skipped, 0 failed**.
- Workspace-scoped lock diagnostics and owner-token secrecy are exercised by the added independent-process test; a foreign caller is denied and no automatic recovery API was introduced.

Full and focused counts overlap. Production provider, cross-host locking, shared multi-writer metadata and operator-verified crash recovery remain release blockers.
