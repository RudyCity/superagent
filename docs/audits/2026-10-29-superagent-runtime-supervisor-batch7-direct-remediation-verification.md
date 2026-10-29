# SuperAgent Runtime Supervisor — Batch 7 Direct Remediation Verification

Date: 2026-10-29
Scope: Independent follow-up to Batch 6 pre-merge audit
Starting commit: eb4742e8
Branch: agent/runtime-supervisor-m1-coverage-m2-reaper-20261028
Status: **IMPLEMENTED AND TESTED — NOT PRODUCTION CERTIFIED**

## 1. Changes directly implemented

### P0: Registry lock TOCTOU elimination

Replaced pathname-based `process-registry.json.lock` owner lock, check-token-then-unlink release, and unsafe static `recoverStaleLock()` deletion with an OS-managed SQLite exclusive writer transaction (`bun:sqlite`, `BEGIN IMMEDIATE`). SQLite releases the transaction on rollback/close or process termination; it does not delete any `.lock` path to release ownership. Randomized asynchronous backoff handles SQLITE_BUSY with bounded timeout; all errors fail closed.

The former static manual recovery API now always refuses with `recovered:false`; it will not touch a file even if called with a fixed confirmation string or unrelated JSON path. A pre-existing legacy `.lock` file stops acquisition with an explicit migration error; the new runtime will not remove it or mix protocols while it is visible.

**Migration prerequisite:** Stop *all* older SuperAgent processes before deploying the SQLite-lock version. A legacy writer that starts later without respecting SQLite cannot be safely serialized. After confirming no older writer exists, perform a controlled migration of any orphaned legacy locks out of band, with backups and operator approval. Never delete old locks while a writer might be active.

SQLite coordination artifact: `<registry path>.coordination.sqlite`. It is intentionally persistent, even though its transactions are short-lived. Windows/Bun may keep a file handle to this coordination database or its journal open temporarily after connection.close(); the functional tests verify exclusion/re-entry and isolate cleanup artifacts outside the source worktree.

### P0: Checkpoint validation and restart retry

Introduced `isValidJobCheckpoint()` and guarded `readJobCheckpoint()` with canonical job binding and full required field types. Reconciler rejects null, malformed, partial, invalid-type, or mismatched-job checkpoints and cannot throw a type error from `lastEvent.startsWith` on arbitrary JSON. Reuse of a local JSON flag as read-only proof is unsafe; both `reconcileJobOnRestart()` and the startup reconciliation now **deny all automatic interrupted-job retry until a trusted, job-bound read-only attestation producer exists**. This is an intentional temporary feature restriction. Already-running verified children can remain observed, and manual operator review is preserved for uncertain outcomes.

No automatic prompt replay, orphan reaping, or process adoption was enabled.

### P1: Operator capability authorization

`issueOperatorCapability()` now requires an authenticated nonempty principal with the operator role and a trusted host-injected policy callback that explicitly authorizes that principal. Default policy is deny: no ambient operator capability can be minted. Issued capabilities are immutable and stored by *object identity* in a WeakSet, preventing forged JSON/token copies. Boolean `isPrivilegedOperator` remains non-authoritative.

**Integration prerequisite:** The runtime/host must supply its real authenticated identity verifier and policy before privileged global diagnostics can be used. A callback installed by arbitrary in-process trusted code is not itself a remote authentication mechanism. No production operator authorization path was wired during this scoped remediation; unauthenticated privilege elevation is fail-closed.

## 2. Tests independently executed

- New `tests/processSupervisorBatch7DirectRemediation.test.ts`: **7 passed, 0 failed**, including unrelated-file protection, no legacy pathname lock creation, concurrent SQLite critical-section exclusion, legacy fail-closed behavior, checkpoint validation, partial-file rejection, and verified operator issuing rules.
- Updated historical tests assert the stronger fail-closed semantics rather than stale Batch 4–6 expectations for unsafe manual recovery and flag-based retry.
- Full supervisor / CLI bridge / Windows headless matrix: **204 passed, 0 failed, 1008 assertions across 18 files**, `bun test --timeout 30000`, TEMP/TMP/TMPDIR redirected to isolated D: audit folder. Command evidence: `cmd_1793239785822_id50w` for subprocess-only and full suite from current conversation.
- `bun run build`: **PASS**, TypeScript and MCP schema sync. Command evidence: `cmd_1793239859195_hl237`.
- `git diff --check`: **PASS**, ignoring pre-existing unrelated LF/CRLF warnings from scratch plan files not staged.

Subprocess regression on Windows initially failed during teardown only due to EBUSY for `proc-reg.json.coordination.sqlite` and SQLite journal. Teardown now strictly accepts only known test registry and SQLite coordination artifacts if Windows is still holding their handles; all other leftover files fail the suite. All temporary test artifacts should be removed out of band after the test process exits.

## 3. Known limitations and next release gates

1. **No live Windows power-loss/reboot / antivirus soak:** SQLite transaction release by OS is well-defined, but complete on-host crash, reboot, and AV contention certification remains untested.
2. **No mixed-version rolling deployment:** Older runtimes do not coordinate via SQLite. Enforce single-version upgrade with all old writers stopped; do not silently remove legacy locks.
3. **No automatic retry for read-only jobs:** Re-enable only after an independently audited, authenticated read-only execution attestation is produced and verified.
4. **No configured operator authorization backend:** Global diagnostic capability stays disabled unless a trusted host-authenticated authorization callback is supplied.
5. **Disk-space pressure:** The user's Windows C: temporary drive was nearly full (about 12 GB available in the previous audit); operational cleanup requires operator approval.

## 4. Git hygiene

The main branch and all pre-existing dirty worktree plan/scratch files were kept untouched. Commit only scoped production files, modified relevant tests, this report, and the new Batch 7 test. Do not stage earlier untracked independent audits or scratch documents. No merge, force reset, or push.

**Decision:** Scoped fixes are validated by the above regression suite. **Global production certification is still pending host-level evidence and the above integration gates.**
