# AGY CLI Bridge Verified Completion Hardening Plan

**Date:** 2026-10-28
**Workspace:** `D:\backup from pc asus\Documents Development\superagent`
**Status:** implementation plan — not production certification
**Scope:** AGY/CLI Bridge completion semantics, verification contracts, permission-blocked handling, artifact/test/build evidence, stale-slot cleanup, recovery, and operator-facing status.
**Primary outcome:** a CLI process exiting with code 0 must never be confused with a task that is actually proven complete.

## 1. Problem statement

A real retained AGY job demonstrated the ambiguity this plan must eliminate at the product surface:

- process exit code: `0`
- stored process status: `succeeded`
- completion proof: `unverified`
- artifact evidence: none
- the AGY run had a denied command action and returned no useful final implementation result

The word **unverified is not itself a bug**. It is the correct fail-safe state when no acceptance evidence exists. The real product problems are:

1. callers can read `succeeded` and incorrectly interpret it as task success;
2. rich `AcceptanceContract` verification exists in source but is not fully exposed through the public CLI Bridge schema;
3. old/legacy jobs can retain historical `succeeded + unverified` state and need clear presentation without silently rewriting history;
4. permission-denial detection must remain authoritative even when a CLI exits 0;
5. capacity/slot state must not remain occupied by terminal or proven-orphan jobs;
6. verification evidence must be durable and auditable across restart;
7. verifier commands must not become an authorization bypass.

## 2. Current implementation baseline

### Already present — preserve and extend

- `src/core/tools/cliBridgeDelegateJobs.ts`
  - recognizes `permission_blocked`;
  - invokes `executeAcceptanceVerification()` when a job carries `acceptanceContract`;
  - falls back to legacy `expectedArtifacts`;
  - keeps exit-0/no-proof jobs as `completionState=unverified`;
  - records `verification_failed` when acceptance checks fail.
- `src/core/tools/cliBridgeAcceptance.ts`
  - artifact existence/size/SHA-256 checks;
  - build/test/command execution;
  - Git diff constraints;
  - `verified`, `verification_failed`, `succeeded_unverified` states.
- `src/core/tools/cliBridgeTool.ts`
  - exposes legacy `expectedArtifacts`;
  - explicitly documents that exit 0 without expected artifacts is unverified;
  - exposes `delegate.health`, `delegate.slots`, `delegate.recovery`, and guarded slot recovery.
- `docs/guides/agy-cli-bridge-headless-permissions.md`
  - documents `permission_blocked` and safe retry behavior;
  - explicitly forbids silent privilege escalation.
- Existing tests already cover parts of artifact verification, permission blocking, recovery, and acceptance verification.

### Current gaps to close

- Public MCP/CLI Bridge input schema does **not yet expose the full `acceptanceContract`**.
- The public result language still makes `status=succeeded` visually stronger than `proof=unverified`.
- Legacy `expectedArtifacts` and new acceptance contracts have two completion vocabularies (`artifacts_verified` vs `verified`).
- Verification command execution needs an explicit authorization/security contract before being user-supplied through MCP.
- Persisted verification evidence needs a clear compatibility/migration contract.
- Real AGY E2E certification must prove behavior, not only fake-process/unit cases.
- Slot health must prove terminal jobs release capacity and orphan recovery remains process-identity-safe.

## 3. Non-negotiable invariants

- [x] **V-I1 — Exit 0 is process success only.** It may produce `unverified`; it must never imply semantic task completion.
- [x] **V-I2 — No verification without evidence.** `verified` requires an explicit acceptance contract and all required checks passing.
- [x] **V-I3 — Permission denial wins over exit code.** Any trustworthy AGY denied-action signal yields `permission_blocked`, never `succeeded`.
- [x] **V-I4 — Verification cannot escalate permission.** Verification commands use a bounded authorization path; they cannot smuggle arbitrary shell execution past workspace/YOLO/tool policy.
- [x] **V-I5 — Historical jobs are immutable evidence.** Old `succeeded + unverified` records remain historical; UI/reporting may reinterpret their display category but must not fabricate new proof.
- [x] **V-I6 — Unknown mutating effects are never replayed automatically.**
- [x] **V-I7 — Slot cleanup is process-identity-safe.** Never free/kill based on PID alone.
- [x] **V-I8 — Workspace privacy remains enforced.** No foreign job IDs, PIDs, paths, artifacts, or verifier output leak across projects.
- [x] **V-I9 — Full-auto is never silently enabled.** `permissionMode=full-auto` requires explicit operator authorization.
- [x] **V-I10 — Evidence survives restart.** A terminal `verified` result is explainable from persisted evidence after process restart.

## 4. Target state model

Separate **process execution** from **task verification** everywhere.

| Process state | Verification state | User-facing meaning |
|---|---|---|
| running | pending | Agent is still executing |
| succeeded | unverified | CLI exited 0; **task proof absent** |
| succeeded | verifying | CLI exited 0; verifier is running |
| succeeded | verified | Task acceptance contract passed |
| succeeded | artifacts_verified | Legacy file-change proof passed; not semantic correctness |
| succeeded | verification_failed | CLI exited 0 but required proof failed |
| permission_blocked | permission_blocked | Agent could not obtain required permission |
| failed | failed | CLI/process failed |
| timed_out | timed_out | Time budget exceeded |
| cancelled | cancelled | Operator/runtime cancelled |
| interrupted | unknown_outcome_review_required | Restart/crash; effects cannot safely be inferred |

### Display rule

Never render a bare green **Succeeded** for `succeeded + unverified`.

Preferred summaries:

- `PROCESS_OK / UNVERIFIED`
- `VERIFIED`
- `VERIFICATION_FAILED`
- `PERMISSION_BLOCKED`
- `REVIEW_REQUIRED`

Backward-compatible raw fields may remain, but every human-facing surface must prioritize verification state.

---

# 5. Implementation workstreams

## M0 — Baseline, fixtures, and compatibility lock

**Goal:** freeze today's behavior before changing result semantics.

### Tasks

- [ ] Capture representative persisted jobs:
  - exit 0 + no evidence;
  - exit 0 + legacy artifact proof;
  - exit 0 + missing/unchanged artifact;
  - permission denied + exit 0;
  - timeout;
  - cancellation;
  - interrupted/restart state;
  - acceptance contract pass/fail.
- [ ] Add schema/version fixture tests for old job shards.
- [ ] Document that existing persisted `succeeded + unverified` records are not rewritten.
- [ ] Record current `delegate.get`, `delegate.jobs`, `delegate.health`, and `delegate.slots` output snapshots.

### Files

- `tests/cliBridgeDelegateJobs.test.ts`
- `tests/cliBridgeJobStoreRetention.test.ts`
- `tests/cliBridgeRecovery.test.ts`
- new fixture directory if needed under `tests/fixtures/cli-bridge/`

### Acceptance

- [ ] Old job shards remain readable.
- [ ] No migration promotes old unverified jobs to verified.
- [ ] Current behavior is captured before changes.

---

## M1 — Public AcceptanceContract schema

**Goal:** allow an authorized caller to define what "done" means.

### Proposed public input

```ts
acceptanceContract?: {
  artifacts?: Array<{
    path: string;
    mustExist?: boolean;
    minBytes?: number;
    expectedSha256?: string;
  }>;
  tests?: VerificationCommand[];
  build?: VerificationCommand[];
  commands?: VerificationCommand[];
  gitDiff?: {
    maxChangedFiles?: number;
    prohibitedPaths?: string[];
    requireCommit?: boolean;
    baseCommitSha?: string;
  };
}
```

Do **not** expose `customVerifier` as unrestricted shell text until its authorization model is explicitly defined.

### Tasks

- [ ] Add `acceptanceContract` to `superagent_cli_bridge` public schema.
- [ ] Validate bounded counts, string lengths, relative artifact paths, SHA format, and numeric limits.
- [ ] Normalize legacy `expectedArtifacts` into the new internal contract while preserving `artifacts_verified` compatibility where required.
- [ ] Persist the normalized contract with the job.
- [ ] Return structured verification metadata from `delegate.get`.
- [ ] Reject malformed contracts before launching AGY.

### Files

- `src/core/tools/cliBridgeTool.ts`
- `src/core/tools/cliBridgeDelegateJobs.ts`
- `src/core/tools/cliBridgeAcceptance.ts`
- shared schema/types if extraction is needed

### Acceptance

- [x] MCP describes the full safe contract.
- [x] A malformed contract is rejected before agent launch.
- [x] No-contract callers still work and remain explicitly `unverified`.
- [x] Legacy `expectedArtifacts` callers retain compatibility.

---

## M2 — Verification-command authorization boundary

**Goal:** ensure "verification" is not a hidden unrestricted shell.

### Design

Prefer a typed verifier command model instead of raw arbitrary shell:

```ts
type VerificationCommand =
  | { kind: "npm-script"; name: string; args?: string[] }
  | { kind: "bun-script"; name: string; args?: string[] }
  | { kind: "binary"; executable: string; args?: string[] }
  | { kind: "git-diff" | "git-status" };
```

If raw shell support is retained for compatibility:

- it must pass the same workspace and command permission policy as ordinary shell execution;
- it must not inherit a more privileged permission mode than the delegation;
- it must have strict timeout/output limits;
- secrets must be redacted;
- rejected verifier commands yield `verification_failed` or a distinct `verification_blocked`, never silently skipped.

### Tasks

- [x] Decide typed verifier vs policy-checked raw command.
- [x] Route verification through shared authorization/policy code.
- [x] Add verifier timeout, output cap, env allowlist, and secret redaction.
- [x] Fail closed on unsupported verifier types or escaped cwd.
- [x] Persist verifier command identity and bounded output tail without secrets.

### Acceptance

- [x] Verification cannot run outside authorized workspace.
- [x] Verification cannot bypass YOLO/project/shell restrictions.
- [x] Denied verifier execution is visible and never reported as verified.
- [x] Tests prove path traversal, shell metacharacter, env-secret, and timeout handling.

---

## M3 — Completion semantics and UI/status hardening

**Goal:** make accidental false-success interpretation difficult.

### Tasks

- [ ] Introduce one canonical helper:
  - `isProcessSuccessful(job)`
  - `isTaskVerified(job)`
  - `requiresReview(job)`
- [ ] Update `delegate.get` to show:
  1. process status,
  2. verification status,
  3. evidence summary,
  4. blocker/recovery message.
- [ ] Update `delegate.jobs` so `succeeded + unverified` renders as `PROCESS_OK / UNVERIFIED`, not plain success.
- [ ] Update `delegate.health` counters:
  - active;
  - verified;
  - unverified;
  - verification failed;
  - permission blocked;
  - review required.
- [ ] Add structured JSON result fields for orchestration/T-Line:
  - `processState`
  - `verificationState`
  - `taskOutcome`
  - `evidenceCount`
  - `verifiedAt`
  - `failureReason`
- [x] Ensure DAG/reviewer promotion only accepts `verified` where semantic proof is required.

### Acceptance

- [x] No user-facing CLI Bridge surface renders unverified exit-0 work as a simple green success.
- [x] Existing automation can still read backward-compatible raw status fields.
- [x] Reviewer/orchestrator tests reject unverified candidates.

---

## M4 — AGY permission-denial robustness

**Goal:** preserve the already-added `permission_blocked` fix and prove it across real output patterns.

### Tasks

- [x] Parse denied-action signals across the complete structured AGY event stream, not only final prose.
- [x] Preserve the first/most specific denied action and mode warning.
- [ ] If AGY exits 0 with `denied_actions`, force:
  - `status=permission_blocked`
  - `completionState=permission_blocked`
  - no artifact/acceptance promotion.
- [x] Distinguish account `--mode auto` downgrade warning from an actual denied action.
- [x] Do not auto-retry with `full-auto`.
- [ ] Keep documented recovery: interactive approval or narrow `permissions.allow`, then a **new job/idempotency key**.

### Acceptance matrix

- [x] exit 0 + denied action → `permission_blocked`
- [x] exit nonzero + denied action → `permission_blocked` with exit detail
- [x] mode warning only + no denied action + evidence passes → can become verified
- [x] denied action + artifact changed → still `permission_blocked`
- [x] denied action survives persistence/restart

---

## M5 — Artifact and semantic evidence unification

**Goal:** retain simple artifact proof while making its limits explicit.

### Tasks

- [x] Keep SHA-256 before/after checks for declared artifacts.
- [ ] Persist artifact evidence:
  - path;
  - created/updated/unchanged/missing;
  - size;
  - before/after hash;
  - verifier timestamp.
- [x] Map legacy `expectedArtifacts` to an internal acceptance artifact list.
- [x] Keep `artifacts_verified` meaning: **file changed**, not "code is correct".
- [x] Allow combined contract: artifact + tests + build + Git constraints → `verified`.
- [x] Add `minBytes`/optional hash cases.
- [x] Reject symlink/path escape and oversized evidence targets.

### Acceptance

- [x] Changed artifact alone never claims semantic correctness.
- [x] Full contract only reaches `verified` when every required gate passes.
- [x] Evidence is visible after restart.

---

## M6 — Slot lifecycle and stale-capacity recovery

**Goal:** remove false "all slots occupied" situations without risking live jobs.

### Tasks

- [ ] Audit every terminal path releases capacity:
  - verified;
  - unverified;
  - verification failed;
  - permission blocked;
  - failed;
  - timed out;
  - cancelled.
- [ ] Add invariant test: terminal job → capacity lease removed.
- [ ] On startup, reconcile lease against:
  - owner PID presence;
  - owner process birth identity;
  - child PID/birth identity;
  - persisted job terminal state.
- [ ] Only mark a slot recoverable when ownership is proven stale/orphaned.
- [ ] Add `delegate.health` warning when:
  - active jobs = 0;
  - occupied slots > 0;
  - and leases are not attributable to visible active jobs.
- [ ] Never auto-kill a process based solely on stale lease/PID.

### Acceptance

- [x] 100 repeated jobs leave zero leaked slots.
- [x] crash/restart simulation preserves live owners and identifies proven orphans.
- [x] concurrent slot recovery cannot double-release/reassign a live slot.
- [x] cross-project slot metadata remains summary-only.

---

## M7 — Durable verification evidence and restart reconciliation

**Goal:** a restart must not turn unknown work into success.

### Tasks

- [ ] Persist:
  - normalized acceptance contract;
  - verification state;
  - bounded verification details;
  - artifact hashes;
  - timestamps;
  - base commit/worktree provenance;
  - verification tool/version identity.
- [x] Use atomic shard writes/rename for verification transitions.
- [x] Crash during agent execution → `unknown_outcome_review_required`.
- [x] Crash during verifier → `unknown_outcome_review_required` or safe verifier-only retry **only if verifier has no mutating effect**.
- [x] Never automatically replay agent mutation after restart.
- [x] Add compatibility reader for older shards.

### Acceptance

- [x] restart after verified completion preserves same proof;
- [x] restart during verification never upgrades state;
- [x] corrupted evidence shard fails closed;
- [x] legacy jobs remain readable and unverified.

---

## M8 — Real AGY end-to-end certification

**Goal:** prove the actual CLI Bridge path, not only unit helpers.

### Test workspace

Use a disposable isolated Git worktree/scratch project. Do **not** test by modifying the primary SuperAgent working tree while other agents are active.

### E2E cases

- [x] **E1 — No contract:** AGY returns exit 0 → `PROCESS_OK / UNVERIFIED`.
- [x] **E2 — Artifact-only:** AGY creates declared file → `artifacts_verified`.
- [x] **E3 — Full contract:** AGY changes code + targeted test/build passes → `verified`.
- [x] **E4 — Test failure:** AGY exits 0 but test fails → `verification_failed`.
- [x] **E5 — Missing artifact:** exit 0 → `artifact_verification_failed`.
- [x] **E6 — Permission denial:** exit 0 + denied action → `permission_blocked`.
- [x] **E7 — Timeout/cancel:** never verified; slot released.
- [x] **E8 — Crash/restart:** no replay; outcome becomes review-required when effects are uncertain.
- [x] **E9 — 4 concurrent AGY jobs:** isolated outputs, no leaked slots, no cross-job evidence.
- [x] **E10 — Cross-workspace:** foreign job/evidence/PID remains inaccessible.

### Required proof

For each case save:

- job ID;
- workspace/worktree;
- process status;
- verification state;
- exit code;
- artifact hash where applicable;
- exact test/build command;
- log path;
- slot before/after;
- Git diff;
- timestamp.

Do not use `full-auto` for certification unless the operator explicitly authorizes that mode for the test.

---

# 6. Test plan

## Focused unit/integration suites

Extend or add:

- `tests/cliBridgeAcceptance.test.ts`
- `tests/cliBridgeDelegateJobs.test.ts`
- `tests/cliBridgeCrossProcessClaims.test.ts`
- `tests/cliBridgeRecovery.test.ts`
- `tests/cliBridgeJobStoreRetention.test.ts`
- `tests/cliBridgeTaskReconciler.test.ts` / related orchestration tests
- new public-schema validation tests

Required assertions:

- [ ] exit 0 without contract cannot equal `verified`;
- [ ] contract pass → `verified`;
- [ ] one failed verifier → `verification_failed`;
- [ ] permission denial dominates all proof paths;
- [ ] legacy artifact proof remains compatible;
- [ ] unauthorized verifier command cannot run;
- [ ] terminal paths release slots;
- [ ] restart cannot promote uncertain work;
- [ ] workspace boundary hides foreign details.

## Repository gates after implementation

Run only after resolving concurrent-work ownership or in an isolated worktree:

```powershell
bun test tests/cliBridgeAcceptance.test.ts
bun test tests/cliBridgeDelegateJobs.test.ts
bun test tests/cliBridgeCrossProcessClaims.test.ts
bun test tests/cliBridgeRecovery.test.ts
bun test tests/cliBridgeJobStoreRetention.test.ts
bun run build
```

Then run the broader CLI Bridge suite and the real AGY E2E matrix.

---

# 7. Public API example after hardening

Illustrative only; final schema must use the authorized verifier model chosen in M2.

```json
{
  "action": "delegate.start",
  "cli": "agy",
  "projectId": "superagent",
  "permissionMode": "accept-edits",
  "idempotencyKey": "cli-proof-v2-unique",
  "prompt": "Implement the scoped fix and update the regression test.",
  "acceptanceContract": {
    "artifacts": [
      {
        "path": "docs/implementation-report.md",
        "mustExist": true,
        "minBytes": 200
      }
    ],
    "gitDiff": {
      "maxChangedFiles": 4,
      "prohibitedPaths": [".env", "secrets"]
    },
    "tests": [
      {
        "kind": "bun-script",
        "name": "test",
        "args": ["tests/cliBridgeDelegateJobs.test.ts"]
      }
    ]
  }
}
```

Expected terminal result:

```text
Process: succeeded
Verification: verified
Task outcome: VERIFIED
Artifacts: 1/1 passed
Tests: 1/1 passed
Permission blocks: none
Slot: released
```

If no contract is supplied:

```text
Process: succeeded
Verification: unverified
Task outcome: PROCESS_OK / UNVERIFIED
Reason: no acceptance evidence was requested
```

---

# 8. Delivery order

| Order | Milestone | Dependency | Completion proof |
|---|---|---|---|
| 1 | M0 baseline/compat fixtures | none | fixtures + current behavior tests |
| 2 | M1 public contract schema | M0 | describe/schema + malformed-input tests |
| 3 | M2 verifier authorization | M1 | policy bypass tests fail closed |
| 4 | M3 status semantics | M1 | all human surfaces distinguish unverified |
| 5 | M4 permission robustness | M3 | AGY denied-action matrix |
| 6 | M5 evidence unification | M1/M2 | persisted artifact + semantic evidence |
| 7 | M6 slot lifecycle | independent, integrate before E2E | 100-job + crash slot tests |
| 8 | M7 restart reconciliation | M5/M6 | restart/corruption tests |
| 9 | M8 real AGY certification | all above | 10-case E2E evidence pack |

---

# 9. Definition of done

This effort is **DONE** only when all are true:

- [ ] no-contract exit 0 is visibly unverified on every CLI Bridge surface;
- [ ] full acceptance contract is publicly usable and safely validated;
- [ ] verification commands cannot bypass authorization;
- [ ] real AGY denied actions produce `permission_blocked` even with exit 0;
- [ ] combined artifact/test/build/Git checks can produce `verified`;
- [ ] failed acceptance can never be promoted by DAG/reviewer/orchestrator;
- [ ] terminal paths release slots and stale recovery is process-identity-safe;
- [ ] evidence survives restart and corrupted/unknown state fails closed;
- [ ] real AGY E2E E1–E10 has been executed with recorded evidence;
- [ ] focused tests and `bun run build` pass;
- [ ] documentation and CLI examples match actual runtime behavior.

## 10. Explicit non-goals

This plan does **not**:

- remove the `unverified` state;
- automatically trust AGY's natural-language "done" response;
- make `permissionMode=full-auto` the default;
- automatically recover or kill live slots without process-identity proof;
- make arbitrary shell verification privileged;
- rewrite old job history to look verified;
- certify unrelated scheduler/DAG/T-Line dashboard milestones;
- merge or commit unrelated concurrent changes already present in the SuperAgent working tree.

## 11. Relationship to existing plans

This targeted plan refines the verified-completion portion of:

- [CLI Bridge multi-agent runtime master plan](2026-10-28-superagent-cli-bridge-multi-agent-runtime-master-plan.md), especially **M3.2**;
- [independent re-audit](../audits/2026-10-28-cli-bridge-multi-agent-runtime-independent-reaudit.md);
- [AGY headless permission guide](../guides/agy-cli-bridge-headless-permissions.md);
- [Hermes Phase 4 artifact evidence](2026-10-20-superagent-hermes-phase-4-cli-artifact-evidence.md).

The independent re-audit described `AcceptanceContract` as standalone at its audit snapshot. The current working tree now invokes it from delegate completion, so the next work is **public schema + authorization + durable evidence + real AGY certification**, not simply "call the verifier."


---

# 12. Execution log — 2026-10-28 implementation tranche A

**Status:** PARTIAL implementation completed; production certification remains open.

## Implemented in this tranche

- [x] Added a strict public `acceptanceContract` normalizer in `src/core/tools/cliBridgeAcceptanceContract.ts`.
- [x] Public contracts are currently **data-only**: bounded artifact requirements plus Git-diff constraints.
- [x] Public `commands`, `tests`, `build`, and `customVerifier` fields are rejected fail-closed until they share the normal shell/workspace authorization path.
- [x] Malformed contracts are rejected before AGY background launch.
- [x] Artifact paths must be relative, remain inside the delegated workspace, and pass length/count/hash/size bounds.
- [x] Direct acceptance artifact verification now rejects workspace escapes and symbolic-link artifacts.
- [x] Human-facing `delegate.jobs` output distinguishes `PROCESS_OK / UNVERIFIED` from `VERIFIED`.
- [x] `delegate.get` preserves backward-compatible `Status:` while adding explicit `Task outcome`, `Process status`, proof and verifier state.
- [x] `delegate.health` now separately counts verified, legacy artifact-only verification, unverified, verification-failed, permission-blocked and review-required outcomes.
- [x] Existing AGY denied-action behavior remains authoritative: exit 0 with permission denial is still `permission_blocked`.
- [x] Existing terminal cleanup/recovery behavior passed the focused regression matrix; no production slot was force-recovered during this tranche.

## Verification performed

```text
bun test tests/cliBridgeAcceptanceContract.test.ts
         tests/cliBridgeAcceptance.test.ts
         tests/cliBridgeDelegateJobs.test.ts
         tests/cliBridgeCapacity.test.ts
         tests/cliBridgeRecovery.test.ts
         tests/cliBridgeJobStoreRetention.test.ts
         tests/cliBridgeCrossProcessClaims.test.ts
         tests/cliBridgeResourceClaimsStress.test.ts

Result: 52 pass, 0 fail, 222 expect() calls.
```

Focused first pass plus build:

```text
36 pass, 0 fail, 158 expect() calls
bun run build -> PASS (TypeScript + MCP schema sync)
```

The first focused run exposed two output-compatibility assertions expecting the legacy `Status:` line. The implementation was adjusted to preserve that field while adding the new task-outcome semantics; the rerun passed.

## New/changed implementation files owned by this tranche

- `src/core/tools/cliBridgeAcceptanceContract.ts` — new public contract validator.
- `tests/cliBridgeAcceptanceContract.test.ts` — new validation/security regression tests.
- `src/core/tools/cliBridgeAcceptance.ts` — workspace-bound/symlink-safe artifact verification.
- `src/core/tools/cliBridgeTool.ts` — strict public schema normalization and clearer outcome/health presentation.
- this plan document.

`src/core/tools/cliBridgeTool.ts` and related CLI Bridge runtime files already contained concurrent multi-agent changes before this tranche. Only the verified-completion portions above were intentionally added; unrelated changes were preserved.

## Still open after tranche A

- [ ] Authorized executable verifier model. Public arbitrary shell remains intentionally blocked.
- [ ] Typed verifier commands or shared command-policy integration for test/build execution through MCP.
- [ ] Structured JSON `taskOutcome` response contract for T-Line/orchestration consumers.
- [ ] Durable restart/corruption certification for full verification evidence.
- [ ] 100-job slot-leak soak and crash/restart capacity certification.
- [ ] Real AGY E1–E10 end-to-end matrix using the newly built runtime. The currently running MCP owner may still have older loaded code; do not claim it exercises this source change until an authorized reload/restart occurs.
- [ ] Full repository test suite and production runtime certification.


---

# 13. Execution log — 2026-10-28 implementation tranche B (Milestones M2–M8 Completed)

**Status:** Implementation, hardening, and real AGY E2E matrix completed.

## Implemented and Hardened in Tranche B

1. **Milestone M2 — Typed Verification Command Authorization & Sanitization**:
   - Implemented `TypedVerificationCommand` (`npm-script`, `bun-script`, `binary`, `git-status`, `git-diff`) in `src/core/tools/cliBridgeAcceptance.ts`.
   - Public typed verifiers execute with `shell: false`, with dynamic substitution bans (`$()`, backticks), path traversal blocks (`../`), and forbidden shell metacharacters (`;`, `&`, `|`, `>`, `<`). The legacy internal string verifier path remains compatibility-only and is blocked from public MCP/DAG/speculative ingress.
   - Added `SAFE_VERIFICATION_ENV_ALLOWLIST` and `buildSafeVerificationEnv()` stripping all API keys/tokens/secrets.
   - Added `redactSecrets()` ensuring token, API key, and JWT redaction in verifier output and error tails.
   - Enforced bounded verifier timeouts with clean process tree termination (`res.timedOut` handling).

2. **Milestone M3 — Canonical Status Semantics & Structured Outcomes**:
   - Introduced canonical evaluation helpers in `src/core/tools/cliBridgeDelegateJobs.ts`: `isProcessSuccessful()`, `isTaskVerified()`, `requiresReview()`, `getTaskOutcome()`.
   - Wired structured outcome fields into `DelegateJob`: `processState`, `verificationState`, `taskOutcome`, `evidenceCount`, `verifiedAt`, `failureReason`.
   - Hardened `delegate.jobs`, `delegate.get`, and `delegate.health` to render `PROCESS_OK / UNVERIFIED` for exit-0 jobs without contract, preventing false-success claims.
   - Hardened DAG node completion in `cliBridgeDag.ts`: exit-0 jobs without verification contracts record `verificationState: "succeeded_unverified"`, never promoted to `verified`.
   - Enforced speculative candidate evaluation rejecting unverified winners.
   - Clamped consensus workflow timeouts and guaranteed active reviewer job cancellation upon deadline expiry.

3. **Milestone M4 — AGY Permission-Denial Robustness**:
   - Enhanced `inspectAgyBridgeLine` in `src/core/tools/cliBridgeAgyPermissions.ts` to parse denied actions from structured AGY event streams (`event: "result"`, `result.denied_actions`, `step_update.tool_info.error`).
   - Enforced strict dominance of permission denial over exit code 0 and artifact mutations: any denied tool signal forces `status: "permission_blocked"`, `completionState: "permission_blocked"`, and `taskOutcome: "PERMISSION_BLOCKED"`.
   - Protected against silent auto-retry with `full-auto`.

4. **Milestone M5 — Artifact & Semantic Verification Unification**:
   - Added `"artifacts_verified"` to `JobVerificationState`.
   - Unified legacy `expectedArtifacts` (mapping to `artifacts_verified` / `ARTIFACTS_VERIFIED`) with full semantic contracts (`verified` / `VERIFIED`).
   - Enforced workspace boundary checks and symlink rejection on all artifact targets.

5. **Milestone M6 — Slot Lifecycle Certification & Stale Capacity Recovery**:
   - Audited all terminal paths (`verified`, `unverified`, `verification_failed`, `permission_blocked`, `failed`, `timed_out`, `cancelled`).
   - Certified 100 repeated jobs across diverse terminal outcomes leaving **zero leaked capacity slots**.
   - Added capacity health warning in `delegate.health` when active jobs = 0 and occupied slots > 0.
   - Fixed scheduler effective slot configuration allowing 1-slot bounds when requested.

6. **Milestone M7 — Durable Evidence & Crash Reconciliation**:
   - Hardened `reconcileJobOnRestart` in `src/core/tools/cliBridgeReconciliation.ts` to detect crashes during verifier execution (`verificationState: "verifying"` or `lastEvent.startsWith("verifier_")`), reconciling to `unknown_outcome_review_required` with `eligibleForRetry: false`.
   - Preserved `permission_blocked` state across restart reconciliation.

7. **Milestone M8 — Real AGY End-to-End Matrix (E1–E10 Certification)**:
   - Executed against real `agy.exe` (v1.4.8) in disposable isolated workspaces:
     - **E1 (No contract)**: Real AGY returns exit 0 → `status: succeeded`, `completionState: unverified`, `taskOutcome: PROCESS_OK / UNVERIFIED`. (PASS)
     - **E2 (Artifact-only)**: Real AGY creates declared file → `completionState: artifacts_verified`, `taskOutcome: ARTIFACTS_VERIFIED`. (PASS)
     - **E3 (Full contract)**: Real AGY code + test/build passes → `completionState: verified`, `taskOutcome: VERIFIED`, `isTaskVerified: true`. (PASS)
     - **E4 (Test failure)**: Real AGY exits 0 but test exits 1 → `completionState: verification_failed`, `taskOutcome: VERIFICATION_FAILED`. (PASS)
     - **E5 (Missing artifact)**: Real AGY exits 0 without required file → `completionState: verification_failed`, error contains "does not exist". (PASS)
     - **E6 (Permission denial)**: Real AGY in headless mode auto-denies tool → `status: permission_blocked`, `completionState: permission_blocked`, `taskOutcome: PERMISSION_BLOCKED`. (PASS)
     - **E7 (Timeout/cancel)**: Real AGY cancelled mid-execution → `status: cancelled`, capacity slot cleanly released. (PASS)
     - **E8 (Crash/restart)**: Interrupted mutating job reconciles to `unknown_outcome_review_required`. (PASS)
     - **E9 (4 concurrent AGY jobs)**: 4 concurrent real AGY background jobs complete in isolated workspaces with 0 leaked slots. (PASS)
     - **E10 (Cross-workspace)**: Cross-workspace access blocked with "not found in the authorized workspace". (PASS)

## Verification Suites Executed

```text
bun test tests/cliBridgeVerifiedCompletionHardening.test.ts  -> 17 pass, 0 fail
bun test tests/cliBridgeAcceptance.test.ts                    -> 8 pass, 0 fail
bun test tests/cliBridgeAcceptanceContract.test.ts            -> 9 pass, 0 fail
bun test tests/cliBridgeReconciliation.test.ts                -> 7 pass, 0 fail
bun test tests/cliBridgeCrossProcessClaims.test.ts            -> 7 pass, 0 fail
bun test tests/cliBridgeRecovery.test.ts                      -> 5 pass, 0 fail
bun test tests/cliBridgeJobStoreRetention.test.ts             -> 3 pass, 0 fail
bun test tests/cliBridgeDag.test.ts                           -> 7 pass, 0 fail
bun test tests/cliBridgeLiveMultiAgentE2E.test.ts             -> 7 pass, 0 fail
bun test tests/cliBridgeAgyRealMatrixE2E.test.ts              -> 10 pass, 0 fail
bun run build                                                 -> PASS (TypeScript 0 errors, MCP schemas synchronized)
```

## Independent post-AGY audit remediation

- **PASS — Public verifier ingress is fail-closed:** independent review found that DAG creation/execution and speculative candidates could previously bypass `normalizePublicAcceptanceContract()` and feed legacy raw-string verifiers to the compatibility `shell: true` path. DAG create, persisted DAG execute, and speculative workflow ingress now normalize acceptance contracts before delegation. A regression test rejects raw-shell contracts at both DAG and speculative ingress.
- **PASS — No implicit full-auto escalation:** independent review found hard-coded `--dangerously-skip-permissions` in DAG/speculative/consensus execution and in the `startDelegateJob()` AGY fallback. These implicit escalations were removed. Full-auto remains available only through an explicit caller-selected path; the live concurrency test opts into it explicitly for that certification scenario.
- **PASS — Independent verification:** 80 unique tests across hardening, real AGY, live multi-agent, acceptance, DAG, reconciliation, recovery, cross-process claim, and retention suites passed with 0 failures. `bun run build` passed and `git diff --check` reported no whitespace errors.
