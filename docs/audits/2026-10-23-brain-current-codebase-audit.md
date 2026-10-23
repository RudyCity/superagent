# Audit Brain SuperAgent / T-Line — 2026-10-23

**Audit mode:** code review + isolated, non-destructive regression suite and live status metadata; no source fixes, token exchange, process restarts, or pushes performed. SuperAgent snapshot: `31a039fd` (with unrelated dirty worktree), T-Line snapshot: `3581b31` (with other concurrent UI edits). The verified Brain core source directory itself had no local diffs.

## Overall conclusion

**Needs P0 remediation before production signoff.** Brain has meaningful positive guarantees (owner-scoped session paths, guarded cleanup, project provenance, checksum-checked artifacts, CLI job evidence, capability hashing, generated T-Line parity). However, the advertised completed lifecycle and quota guarantees are not consistently applied across all entrypoints or crash windows.

### Confirmed code-path findings (not exploitation proofs)

| ID | Priority | Location | Finding and realistic impact | Required fix |
| --- | --- | --- | --- | --- |
| BR-01 | P0 | `src/core/brain/brainTaskReconciler.ts:24-37`, `brainArtifactTransaction.ts:165-195` | **Reconcile is not idempotent after successful artifact promotion.** If the process crashes after batch promotion, or checkpoint/status update fails, the next reconciliation re-runs a create-only promotion. Existing destinations cause collision and the task becomes `blocked` despite verified artifacts already existing. Current journal only tracks files, not the task's finalization step. | Introduce a durable per-job promotion receipt bound to job ID + evidence digest + task; on resume verify existing files and finish checkpoint/status without replaying the batch. Add fault injection between publish, checkpoint, and status. |
| BR-02 | P0 | `t-line/backend/src/brainExplorerRoutes.ts:208-213`, `src/core/brain/brainTasks.ts:109-120`, `brainMcpTools.ts:222-235` | **Desktop can mark an active delegated task completed.** T-Line directly calls `updateBrainTask` without the CLI Bridge active-job check that exists on the MCP `task.status` path. A user can mark the task terminal while its child process is still running and writing, losing expected reconciliation. | Enforce job-active/terminal validation centrally inside a shared lifecycle coordinator used by both T-Line and MCP; add an HTTP regression proving `409` during active CLI jobs. |
| BR-03 | P0 | `src/core/brain/brainTasks.ts:170-194` vs `brainStorageManager.ts:77-80` | **Handoff bypasses the 50 MiB owner-session storage budget.** It copies up to 20 MiB per handoff, as many as 64 times per task, without checking session usage/reservations. Accumulated scratch can exceed advertised quota substantially and burden backup/cleanup. | Add same quota/reservation policy under session lock before writing; account for all recipient inboxes, rollback failed copy, and add boundary tests. |
| BR-04 | P1 | `src/core/brain/brainAgentCredentials.ts:71-105`, `brainMcpTools.ts:202-214` | **Expired remote agent capability has no owner-authorized recovery path in MCP.** Remote rotation itself requires a currently valid capability; after expiry, it cannot rotate. T-Line's privileged credential-admin API manages the local-cli owner, not a distinct OAuth principal's tasks. A long-running remote task may become unmanageable through MCP. | Add separately authenticated owner/operator recovery/rotation with explicit audit and bounded privileges, without granting admin authority to the expired agent. |
| BR-05 | P1 | `src/core/mcp/tools/brainMcpTools.ts:250-268,270-287` | **Delegation start and retry have no per-task active-job serialization.** Two simultaneous requests can observe the same task state, launch multiple background CLIs outside the session lock, then race to record their IDs. A job can run even when bookkeeping fails, and latest-job-only reconcile ignores earlier live children. | Store a reservation/idempotency key before process spawn, enforce one active job per claimed task, verify all task-linked processes before terminal transitions. |
| BR-06 | P1 | `src/core/brain/brainTaskRecovery.ts:17-35,42-46`, `brainTasks.ts:87-90` | **Recovery scans only up to 8 running tasks in recency order (16 max when called explicitly) with no cursor.** Sessions with more active delegated jobs can leave the older ones unreconciled repeatedly; errors are counted but not persisted for operator follow-up. | Bounded paginated sweeps with durable cursor, timeout/backoff, explicit `partial` reporting and persisted actionable review states. |
| BR-07 | P1 | `src/core/brain/brainTasks.ts:184-193,55-64` | **Handoff copy and metadata save are separate.** If `save()` fails (e.g. 60 KiB task cap or IO failure), the inbox copy remains but no handoff record is saved. | Prevalidate metadata bounds, write via temporary file + rename, and delete staged copy on metadata failure; add crash/retry tests. |
| BR-08 | P2 | `t-line/frontend/src/components/SuperAgentBrainTaskPanel.tsx`, `frontend/src/components/__tests__/SuperAgentBrainTaskPanel.test.tsx` | React emits an unkeyed-list warning during Brain task panel test. Not a functional blocker but signals component rendering debt. | Identify and provide stable keys for repeated elements, verify no warnings in UI regression. |
| BR-09 | Release gate | Live tunnel / installed T-Line / Claude | Public tunnel status metadata indicates OAuth mode, not an authenticated live MCP request. Packaged desktop UI interaction is unverified. Previous real Claude delegation failed due to untrusted TLS certificate; do not bypass TLS validation. | Authorize browser OAuth round-trip + read-only MCP tool call, packaged desktop smoke, configure trusted CA for Claude, and capture remote CI evidence once workflows are pushed. |

## Controls that passed code review

- Session manifests are tied to a principal-specific owner hash; session paths and user-provided filenames are bounded.
- Explicit artifact publish/cleanup challenges; cleanup checks nested task scratch for active CLI Bridge snapshots.
- SHA-256 verified delegated promotion with create-only target names and crash-recovery journal for file placement.
- Capabilities are hashed, scoped by task and agent, and support expiry/revocation/rotation for valid holders.
- T-Line Brain routes are mounted under `superAgentRoutes.ts:19,24` after `authMiddleware`. Separate OAuth owner state is not exposed via T-Line Brain.
- Source checksum and nested CLI command catalog parity are checked by build scripts.
- RMemory continuity is scoped to registered project provenance; task checkpoints are treated as untrusted text.

## Tests executed 2026-10-23 (working tree, offline)

- SuperAgent Brain/MCP/OAuth: **53/53 passed** across 17 Vitest suites.
- T-Line Brain backend: **14/14 passed**.
- T-Line UI Brain/CLI parity: **11/11 passed**.
- Canonical generated T-Line Brain source and suggestion checksum: **PASS**.
- MCP metadata: 4 public MCP tunnels active at probe time; SuperAgent tunnel on localhost 9227 was OAuth configured. Metadata inspection is **not** live OAuth acceptance.
- CLI Bridge: 8 retained jobs, 0 active, 0 unverified completion in the inspected project snapshot.
- Existing UI test warned about React list keys; Vite plugin also warned about deprecated options.

**Test gap:** the tests above prove the covered happy paths and selected guardrails, not the nine issues. BR-01 through BR-07 are code-path findings and should be converted into failing tests before patching. No destructive reproduction against the user's real Brain store was attempted.

## Recommended implementation order

1. **P0:** BR-02 unified live-job terminal-state guard, BR-01 idempotent job promotion/finalization receipt, BR-03 handoff quota and rollback; add tests at each surface.
2. **P1:** BR-04 authenticated owner recovery of expired credentials, BR-05 task-scoped launch reservations, BR-06 paginated recovery, BR-07 transactional handoff.
3. **P2 / release:** BR-08 UI warning cleanup; BR-09 authenticated tunnel, installed desktop and Claude TLS acceptance; run full gates, then only selectively commit/push after coordination with other sessions.

**Production decision:** **Not signed off** pending P0 issues and operational acceptance. No code changes were applied by this audit.
