# Brain P0/P1 Remediation — 23 October 2026

## Scope and changes
Based on `docs/audits/2026-10-23-brain-current-codebase-audit.md`.
Code changes are confined to canonical Brain modules, MCP/CLI Brain entrypoints, generated T-Line Brain runtime, Brain Explorer operator UI/API, matching tests, and source integrity scripts. Other active SuperAgent worktrees were not overwritten.

### Resolved / substantially mitigated
- **BR-01 (P0) — Idempotent promotion:** committed batches have owner-session, job-bound, SHA-256-verified receipts at `.promotion/receipts/<jobId>.json`. Recovery of a committed transaction reconstructs receipts, and repeated promotions validate the evidence/destination rather than refusing existing files. Reconciler avoids a duplicate checkpoint and can continue a previously blocked task once evidence validates. Tests simulate committed-journal recovery and tampering.
- **BR-02 (P0) — Shared terminal-state guard:** canonical `updateBrainTask`, used from CLI, MCP and generated T-Line backend, refuses completed/cancelled while any persisted CLI Bridge session-scratch delegation is active. T-Line HTTP regression checks 409 while a nested job reports running and success after the snapshot reaches a terminal state. This is a session-wide conservative check.
- **BR-03 + BR-07 (P0/P1) — Bounded, rollback-safe handoff:** handoff checks the Brain session 50 MiB quota and active transfer reservations while holding the session lock. Oversized metadata is rejected before copying; an IO/metadata-save failure removes the new inbox copy. Regression tests cover quota refusal and a deliberately oversized task record.
- **BR-04 (P1) — Owner recovery:** new MCP tasks issue a separate owner-only, single-use recovery capability, persisted only as SHA-256. `task.credential.recover` requires it, rotates both the target agent token and the owner recovery capability, and works after expiry or revocation. Never give this recovery secret to a delegated agent. Local T-Line task creation displays this owner recovery token once; T-Line's operator privilege remains limited to `local-cli`.
- **BR-05 (P1) — Launch serialization:** task-owned delegations and retries must create a `.tasks/<taskId>.launch.json` reservation under the cross-process Brain lock before dispatch. On acknowledged job ID + metadata persistence the reservation is cleared. Concurrent starts are rejected; normal starts cannot silently launch a second job on the same task. A missing acknowledgement deliberately retains its reservation for operator triage rather than guessing that the child never started.
- **BR-06 (P1) — Fair bounded recovery:** `brainTaskRecovery.ts` now persists a per-session cursor and sweeps eligible running delegated tasks in stable task-ID order, rotating across pages with `partial` and `nextCursor` in the status. It never launches retries automatically.
- The T-Line canonical source + generated manifest checksum are synchronized, and the Brain release suite includes newly added launch/handoff regression tests.

## Verification
- SuperAgent: **60/60 tests passed** across 19 suites (Brain, MCP and in-process OAuth HTTP).
- T-Line backend: **15/15 tests passed**, including newly added refusal to complete a task with a live nested delegation.
- T-Line UI: **11/11 tests passed**.
- Bun SuperAgent build, T-Line backend/frontend builds, README checks, canonical Brain/suggestions checks: **PASS**.
- A complete `bun scripts/verify-brain-release.ts --with-tline` run reached the terminal `PASS: offline Brain release checks` marker after the test expectations were updated for idempotent promotion.

## Remaining limitations / follow-ups
1. **Not all reservations are automatically recoverable.** After an ambiguous delegate-start failure the persistent launch reservation remains and the operator must inspect the persisted CLI Bridge jobs/process status before any manual recovery; automatic clearing would risk a duplicate process. No unsafe clear endpoint has been added.
2. **Task terminal guard depends on persisted CLI Bridge snapshots.** No snapshot/unknown process status is not proof that a child is dead. MCP has an additional per-task live lookup guard; T-Line and local CLI use the conservative shared session-level active-snapshot guard. Hard fail-closed handling for missing/invalid snapshots can be improved without breaking legitimate manual-only tasks by recording a verified per-job terminal proof.
3. **The owner recovery secret is an additional bearer capability, not a new identity system.** An OAuth MCP client that itself creates a task sees the initial recovery token. Separate custody by the owner application is still required; do not hand it to a worker prompt.
4. **BR-08 (P2) test-fixture fix:** the React key warning was caused by the test returning a task's `agents: string[]` for the credentials-status endpoint, which expects credential objects with `agentId`. The corrected mocked API returns objects matching the production schema; the Brain Task Panel test now passes without that warning. The panel also displays the owner recovery token only during its initial one-time creation response.
5. **Live production signoff remains outstanding:** authenticated OAuth exchange through the real public tunnel, installed T-Line desktop GUI interaction, and real Claude CLI delegation after trusted TLS CA remediation. Do not disable TLS certificate verification.
6. **No auto push/restart** of shared tunnels or unrelated in-progress branches. Other active sessions have many uncommitted SuperAgent files.

## Safe operator next checks
```sh
bun scripts/sync-brain-runtime.ts --check
bun scripts/verify-brain-release.ts --with-tline
```
Do not manually delete a `.launch.json` reservation unless the related CLI process and persisted job status have been independently checked and the outcome documented.
