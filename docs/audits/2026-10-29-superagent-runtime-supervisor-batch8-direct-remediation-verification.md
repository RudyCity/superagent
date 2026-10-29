# SuperAgent Runtime Supervisor — Batch 8 Direct Remediation Verification

Date: 2026-10-29
Base commit: `2300852c`
Branch: `agent/runtime-supervisor-m1-coverage-m2-reaper-20261028`
Scope: Direct remediation of the Batch 7 independent pre-merge audit; no AGY delegation.
Status: **CODE-LEVEL AUDIT FINDINGS REMEDIATED / HOST CERTIFICATION STILL PENDING**

## Implemented remediations

### P0 — A local checkpoint can no longer prove absence of side effects

`processReconciliation.ts` now treats a structurally valid local checkpoint as self-declared task data, not authenticated side-effect evidence. On restart, mutation is conservatively assumed possible until a separately trusted, job-bound verifier attestation contract exists.

The former case:
- terminal failure,
- `checkpoint.hasMutatingWrite:false`,
- no independent proof,

now returns `unknown_outcome_review_required`, `hasMutatingWrite:true`, `requiresReview:true`, and `eligibleForRetry:false`.

### P0 — A local "verified" status can no longer manufacture authoritative success

`verificationState:"verified"`, `"artifacts_verified"`, `lastEvent:"verified_succeeded"`, or local rollback strings are no longer considered authoritative completion evidence by startup reconciliation.

Until trusted verifier attestation is implemented, a terminal clean exit plus a self-declared checkpoint remains review-required. Automatic retry was already disabled and remains disabled.

Contradictory local receipts are still detected as contradictions for diagnostics, but positive claims do not become authority.

### P1 — Mixed-version registry writers are fenced atomically

The registry now creates a **persistent DIRECTORY** at the legacy `<registry>.lock` pathname before entering the SQLite coordination protocol.

Why a directory:
- legacy runtimes attempt `open(path, "wx")`;
- a directory at exactly that pathname makes the legacy file-lock acquisition fail atomically;
- new runtimes never delete this directory;
- new runtimes serialize through `<registry>.coordination.sqlite` using `BEGIN IMMEDIATE`.

This closes the Batch 7 reproduction where a legacy `wx` lock could be created while the new SQLite transaction was active.

If a legacy **FILE** already exists at `<registry>.lock`, the new runtime fails closed and does not remove it. Operators must stop all legacy writers, verify process identity, back up the registry, and perform migration under controlled downtime.

The directory itself is the protocol fence. No marker file is required, avoiding a partial-marker race between concurrent new writers.

### P2 — Checkpoint freshness is enforced

`isValidJobCheckpoint()` now rejects checkpoints older than 24 hours, future timestamps beyond the existing tolerance, malformed types, incomplete schema, and job-ID mismatch.

`writeJobCheckpoint()` refuses malformed or stale checkpoints before persistence. Secure canonical job-ID/path validation remains first, preserving traversal rejection.

### P1 — Global operator diagnostics remain fail-closed

The incomplete privileged diagnostic issuance path is now intentionally disabled. `issueOperatorCapability()` always refuses until a real authenticated host identity/authorization integration exists, and `verifyOperatorCapability()` always returns false.

Workspace-scoped diagnostics continue to function. Caller booleans, callback configuration, JSON objects and forged capability IDs cannot enable host-wide process metadata.

## Independent reproduction closure

The exact Batch 7 audit reproductions were rerun after remediation:

1. Failed terminal job + local `hasMutatingWrite:false`:
   - now `unknown_outcome_review_required`;
   - mutation conservatively true;
   - review required;
   - retry false.

2. Clean terminal exit + local `verificationState:"verified"`:
   - now `unknown_outcome_review_required`;
   - review required;
   - retry false.

3. Legacy `open(<registry>.lock, "wx")` attempted inside a live new SQLite critical section:
   - returns `EEXIST`;
   - `<registry>.lock` is a directory.

4. Checkpoint `timestamp:1`:
   - `isValidJobCheckpoint(...)` returns false.

Dedicated test file:
`tests/processSupervisorBatch8DirectRemediation.test.ts`

Result: **6 passed, 0 failed, 13 assertions**.

## Full regression evidence

Full focused supervisor/CLI/Windows matrix after remediation:

- **210 tests passed**
- **0 failed**
- **1024 assertions**
- **19 test files**
- Runtime: Bun 1.4.2
- Full suite duration: ~50.46 seconds
- Temporary test root redirected to D: to avoid C: pressure.

Included:
- Batch 4, 5, 6, 7 and new Batch 8 remediation tests;
- registry legacy safety and multi-process concurrency;
- startup reconciliation;
- process status / workspace privacy;
- CLI Bridge;
- core supervisor and checkpoint tests;
- worktree isolation;
- dynamic hooks;
- Windows subprocess splash / leaked-descendant regression.

`bun run build`: PASS.
`git diff --check`: PASS (pre-existing LF/CRLF warnings on unrelated scratch files are not staged).

## Intentional safety restrictions

These are deliberate until stronger evidence systems exist:

1. No automatic retry of interrupted jobs based only on local checkpoint flags.
2. No authoritative "verified success" from local checkpoint status strings.
3. No host-wide privileged diagnostics until real host authentication is integrated.
4. No mixed-version rolling registry deployment. A legacy lock FILE is a migration blocker.

## Remaining production-certification gates

The code-level findings from the Batch 7 independent audit are addressed, but global production certification still requires:

- real Windows power-loss / forced-reboot recovery;
- antivirus / filesystem handle-contention soak;
- controlled upgrade test from a legacy lock FILE to the persistent directory fence;
- validation that all deployed processes use the same lock protocol;
- future independent design and audit if trusted verifier attestation or privileged global diagnostics are re-enabled.

No automatic stale-lock deletion, process adoption, orphan reaping, or prompt replay was introduced.

## Git hygiene

Only scoped production source, affected regression tests, the new Batch 8 test, and this report should be committed. Pre-existing scratch documents and older untracked audits remain untouched. Main must not be merged or reset as part of this remediation.
