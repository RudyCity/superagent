# SuperAgent Studio — Recovery and lock-safety implementation

Date: 2026-10-25
Workspace: `D:\backup from pc asus\Documents Development\superagent`
Scope: P0 queued render recovery, admission-lock ownership, diagnostic fidelity, and T-Line Studio regression verification.

## Findings

- Studio storage originally held 46 render jobs: 36 completed, 9 queued, 1 rendering.
- The connected MCP service classified 9 queued source snapshots as unverified. A fresh Bun/source-runtime inspection independently validated SHA-256, pinned revisions, workspace identity, and media for all 9. The same source-runtime CLI reported all 9 eligible. This is consistent with an out-of-sync long-lived MCP runtime, but the exact deployment skew remains to be confirmed after a controlled service restart.
- `studiojob-4139b19ce4c16c79224a7795` has a recorded owner PID and on-disk runner, waiting, project and render-slot claims. Windows process enumeration found no process with its recorded PID at inspection time, but that alone is insufficient to remove or reassign claims.

## Changes

1. `renderScheduler.ts`: remove mtime-only eviction of a potentially live admission lock. Persist an unguessable per-acquisition token, verify token and regular-file safety before release, and fail closed on unknown or replaced owner state.
2. `queueRecovery.ts`: classify snapshot hash mismatch, identity/revision mismatch, missing source/media, and validation failures without leaking raw file paths in diagnostics.
3. Regression tests cover stale-lock preservation, lock ownership replacement, one-at-a-time replay, corruption rejection, and 3840-pixel capability metadata.
4. The T-Line preset UI test now awaits asynchronous catalog loading rather than assuming the catalog is populated on initial render.

## Operational recovery

Using the source-version CLI and operator-approved, singly dispatched recovery:

- 9/9 formerly queued immutable jobs acknowledged by a new worker and reached `completed`.
- Each completed job was checked for terminal status, completed frames and artifact bytes before dispatching the next.
- Post-recovery snapshot: 46 total jobs; 45 completed, zero queued, zero failed, one `rendering` with unverified legacy process/slot claims.
- Completed artifacts were preserved. No render-slot lock, job metadata, partial output, or legacy storage directory was force-deleted.

## Verification

- `bun x vitest run tests/motionScheduler.test.ts tests/motionQueueRecovery.test.ts tests/motionSupervisor.test.ts tests/motionStorageMaintenance.test.ts --maxWorkers=2` — 22/22 passed.
- `bun x vitest run tests/motionStudioOptimizations.test.ts tests/motionAuthoringParity.test.ts tests/motionScheduler.test.ts tests/motionQueueRecovery.test.ts --maxWorkers=2` — 32/32 passed.
- `bun run build` — passed before a separate concurrent core-runtime edit began.
- T-Line: `bun run build:frontend` — passed; frontend Studio Vitest selector `Studio studio` — 122/122 passed.
- Full SuperAgent Studio selector `bun x vitest run motion studio --maxWorkers=2` — **60 suites / 303 tests passed**. An earlier run encountered a transient `coreRuntimeCommand.js` import during concurrent edits; it was resolved by the other session before final regression verification.

## Remaining controlled-release gates

- **P0:** Inspect the old rendering job's runner/waiting/slot claims and process identity with an operator-authorized forensic recovery workflow. Do not reclaim locks based only on PID absence or age.
- **P0:** Restart or roll forward the long-lived SuperAgent/MCP process under the normal service lifecycle, then compare source CLI and MCP recovery reports in the same workspace. Do not restart an active tunnel without coordinating connected clients.
- **P1:** Once all running/queued claims are reconciled, back up and dry-run `superagent studio migrate --workspace . --json` before any guarded `--apply` migration from `.superagent/motion` to `.superagent/studio`.
- **P1:** Run packaged Tauri desktop E2E against the rebuilt backend: prompt, storyboard, semantic revision, render, playback, download, authorization and crash/restart.
- **P2:** Clean up existing frontend Vite CSS and deprecated esbuild/oxc warnings in a separate changeset.

## Safe follow-up commands

```powershell
bun src/cli.tsx studio queue-recovery --workspace . --json
bun src/cli.tsx studio storage --workspace . --json
bun src/cli.tsx studio recovery studiojob-4139b19ce4c16c79224a7795 --workspace . --json
bun src/cli.tsx studio migrate --workspace . --json
```

All of these are read-only. Never run `studio recover --ack-stale` while runner, waiting or slot claims are unverifiable.
