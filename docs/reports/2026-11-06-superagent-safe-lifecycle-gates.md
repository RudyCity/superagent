# Safe lifecycle owner guards — independent regression evidence

**Date:** 2026-11-06
**Scope:** Core blue–green, Tray owner and release journal, rollback/restore, service manager selection.
**Owner:** Delegate Worker B. **No production lifecycle mutation authorized.**

## Verified source contracts

- `coreLifecycleControl.ts` checks public port, supervisor PID, `ownerContract.role=core-supervisor`, `mcpLifecycle=not-owned`, and worker port != public port. Mutations demand explicit confirmation, fresh source/dist SHA-256, and matching planned digest; it subsequently verifies the same supervisor, stable active generation, and on restart a retained prior worker plus new build attestation.
- `coreSupervisor.ts` manages blue–green generations and session affinity. `coreGenerationPolicy.ts` bounds retained generations at **4**, omits the current PID from rollback candidates and retains the live previous active generation when rolling back.
- `managedTrayControl.ts` refuses to adopt legacy/unverified instances. Its verified owner must match the kernel listener PID and authenticated native loopback health response, and executables must come from trusted install candidates. Tray start/stop/restart requires `noCoreShutdown:true` and a plan-scoped owner PID/instance/digest.
- `managedSidecarLedger.ts` hashes operation IDs; pending receipts block retries and unrelated operations; a different fingerprint under the same ID conflicts. Manual reconciliation requires verified owner absence, explicit approval and a 120-second cooldown, and ends in `reviewed`, **not** `completed`.
- `managedTrayControl.ts` release upgrade/rollback requires a 24-hex release revision, SHA-256 digests, exact old-owner identity and `noCoreShutdown:true`. It stages trusted binaries before touching an owner. On ambiguous stop/launch it reports `TRAY_RELEASE_OUTCOME_UNCERTAIN`; rollback of the manifest is best-effort only when no new owner/legacy process remains.
- `trayReleaseStore.ts` restore checks a matching release manifest revision and refuses stale restore with `TRAY_RELEASE_CHANGED_DURING_RECOVERY`.
- `serviceManager.ts` validates strict service/action/operation fields, uses service-specific plans and authenticated control; unsupported mutation returns `SERVICE_UNSUPPORTED_MUTATION`. The service API's mutating orchestration and audit journal were **not invoked** by this suite.

## New isolated regression coverage

`tests/safeLifecycleOwnerGuards.test.ts` uses an injected fake Core request function and temporary `SUPERAGENT_CONFIG_DIR` fixture directories. The suite tests Core confirmation, owner-contract and port mismatches, stale build and digest drift, supervisor drift, unstable generations, missing session retention, attestation mismatch, noop rollback, idempotent completed replay; pure retained-generation selection; Tray malformed owner records, cross-service shutdown guards, pending/conflicting/reviewed receipts, cooldown, corrupted journal, stale release-restore CAS; and service-manager input rejection. No `manageServices`, real Core supervisor RPC, live Tray probe, service restart, PID termination, tunnel changes, or actual deploy.

## Fail-closed limitations and ownership boundaries

1. A successful *mocked* blue–green test cannot prove live kernel ownership, worker session survival, or real restore. Those are separate, orchestrator-controlled tests with explicit approval.
2. Release recovery is intentionally **not** a guaranteed rollback: an uncertain spawned owner, foreign process or journal pending must block automation until authenticated review. The suite only tests stale manifest restore and input gates, never executes release transactions.
3. **Shared-code review item:** `coreGenerationPolicy.rollbackCandidates()` filters by PID but does not independently require a `verified` field; `coreSupervisor.ts` should continue to vet candidate verification at its call site. Treat independent use of this pure helper with unverified candidates as unsafe; orchestrator owns any shared hardening.
4. **Shared-code review item:** `coreLifecycleControl.controlCoreLifecycle()` reports success of a `drain` by retained count but does not independently prove each retired worker had no active sessions; supervisor-owned session evidence remains required. Do not generalize the wrapper's `verified` flag to cross-service health.
5. **Shared-code review item:** owner identities in plan and operation journals are **not** permission to kill foreign processes; `noCoreShutdown` is a mandatory cross-service fence. Operator workflow must not bypass `SIDECAR_OPERATION_UNCERTAIN_PENDING` or delete journals to force an operation.

## Reproduction

```sh
bun x vitest run tests/safeLifecycleOwnerGuards.test.ts
bun --bun x tsc --noEmit
```

Tests intentionally avoid `manage_services` mutation actions, live owner/ledger directories and all process-control commands. Test execution status must be recorded from actual command output, not inferred.
