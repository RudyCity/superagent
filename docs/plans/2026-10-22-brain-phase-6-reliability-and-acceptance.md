# SuperAgent Phase 6 — Production Reliability Implementation

Date: 2026-10-22. Repositories: SuperAgent Core and T-Line Desktop.

## Implemented

### P0 — Acceptance and release checks
- SuperAgent and T-Line build with Bun and run a reproducible Brain test suite via `bun scripts/verify-brain-release.ts --with-tline`.
- Live MCP status inspection found a SuperAgent OAuth tunnel on local port 9227, plus two unrelated tunnels. No tunnel was restarted or reconnected. The status tool only reports runtime metadata; this is **not** authenticated public OAuth acceptance.
- CLI Bridge health inspection found eight retained jobs and zero active jobs. This does not establish that a previously unverified Claude delegation has succeeded.
- The packaged T-Line interactive desktop and remote GitHub Actions workflow execution have not been verified; do not treat offline tests as production deployment signoff.

### P1 — Journaled multi-artifact promotion
- New `brainArtifactTransaction.ts` validates all SHA-256 evidenced source files and destination names before publishing any.
- A session-wide lock serializes quota reservation and the batch, with create-only hardlinks from verified staging files. It rejects duplicate or existing output names and limits a batch to ten verified files, individual size <=10 MiB, total session quota 50 MiB.
- A write-ahead `.promotion/transaction.json` journal records prepared and committed phases. On a failed commit or restart, `recoverBrainArtifactPromotion` rolls back only files proven to be the same staged inode, or removes staging after the committed marker.
- Bridge-to-Brain `reconcileBrainTask` now uses a single batch rather than serial per-file publication; checkpoints reference all verified outputs only after the batch succeeds.
- MCP actions `delegate.promote.batch` and `artifact.recover`, plus CLI `/brain artifact.recover`, expose controlled recovery.
- Tests simulate a conflicting second filename, failure after first hardlink, a crashed prepared journal, and an altered destination that must **never** be removed.
- **Limit:** files are not a transactional snapshot to independent OS readers during a crash window; a partial set could temporarily be visible until recovery. This is crash-recoverable batch publication, not global filesystem ACID.

### P1 — Expiring agent credentials
- New task credentials default to 24-hour validity (configurable 1 minute–7 days), store hashes only, and have a monotonically increasing credential generation.
- Rotation immediately invalidates the previous token. Revocation disables use. Remote MCP operations `task.credential.rotate` and `task.credential.revoke` require the currently valid agent credential; `task.credential.status` returns redacted status without raw hashes.
- T-Line's authenticated local operator has routes for status, explicit confirm-to-rotate and confirm-to-revoke; one-time credentials are displayed in the Brain Task panel, never kept in `localStorage`.
- Legacy version-1 capability stores receive a finite expiration derived from their original issue time. Treat a credential as secret; avoid copying it into agent prompts or chat histories.
- Backend route and Core tests cover wrong token, revoked token, token rotation, hash-only storage and owner isolation.

### P1 — Restart-aware reconciliation
- New `brainTaskRecovery.ts` performs a bounded (max 8 per normal run) scan of running task jobs when a local owner chat session is loaded. It first recovers pending artifact journal state, consults persisted CLI Bridge job records, and then marks verified success, active, blocked or review-needed.
- The recovery workflow never launches, silently retries or cancels a job. Missing/uncertain status remains review-required.
- MCP `task.reconcile.all` and CLI `/brain task.reconcile` provide explicit recovery status.
- In-flight checks are coalesced and normal session recovery is limited by a cooldown to avoid startup loops.
- A test verifies bounded scans and that missing jobs are not retried.

### P2 — Operations and memory continuity
- Brain Task panel now refreshes sanitized job status, surfaces capability expiration/revocation and allows explicitly confirmed rotation/revocation.
- On task creation, all agent tokens are returned only in the operator-authenticated, `no-store` response and temporarily displayed in UI for copying. Choosing another task/session or clearing the display removes them from the component state.
- Existing RMemory writes remain opt-in. Task continuity uses registered project provenance and bounded untrusted checkpoints; task history never becomes a privileged prompt.
- Existing Brain Explorer displays activity, retention, search and storage. No automatic destructive cleanup is enabled.

## Verification commands
```bash
# SuperAgent repo
bun scripts/verify-brain-release.ts --with-tline
bun --bun x vitest run tests/brainArtifactTransaction.test.ts tests/brainAgentCredentials.test.ts tests/brainTaskRecovery.test.ts

# T-Line repo
bun scripts/check-brain-runtime.cjs
bun --bun x vitest run backend/tests/brainExplorerRoutes.test.ts
```

## Operational limitations
- Live public tunnel OAuth, packaged T-Line desktop GUI, actual third-party Claude success, and remote CI run remain outstanding.
- Before a controlled tunnel restart, verify the workspace/port; never restart unrelated active tunnels on a shared host.
- Brain task agent capabilities are authorization inside an authenticated owner's namespace, **not** independently isolated OS processes or arbitrary cross-tenant identities.
- Remote retries remain explicit and fail closed if prior job status cannot be verified.
- Concurrent external readers can briefly observe incomplete multi-file commits after a process crash before recovery runs.
- Confirm remote CI and run authenticated end-to-end smoke in the actual deployed environment before production signoff.
