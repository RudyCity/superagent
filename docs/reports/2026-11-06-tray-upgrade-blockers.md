# Tray upgrade blockers and non-destructive recovery review — 2026-11-06

**Scope:** Worker B, read-only review of source and isolated offline regression tests. No live process, owner record, service, journal or release manifest was modified. The PID/release observations below were supplied by the orchestrator; they were **not** independently refreshed in this audit.

## Current decision: NO-GO for upgrade, rollback, forced cleanup, or reconciliation

- Verified Windows Tray owner **PID 37244** (reported from debug), and foreign/unverified Tray **PID 26588** reportedly launched from a Temp `tray-release-e2e` directory. Do **not** kill, adopt, or silently ignore PID 26588.
- `SIDECAR_OPERATION_UNCERTAIN_PENDING` is a durable safety interlock, **not** evidence of success or failure. `managedSidecarLedger.ts` deliberately blocks both replay of the pending ID and new operations in its journal.
- Release **v1.14.64 built** (reported) is **not** proof that the installed, running, authenticated Tray uses that release or that its executable hash matches the staged target.
- Distinct journals exist: `service-owner-tray-45321.json` for start/stop/restart and `service-owner-tray-45322.json` for upgrade/rollback. Reconcile the **correct** journal only; `targetAction: "upgrade"` selects 45322 in `serviceManager.ts`. Never manually delete or edit a journal/lock.
- No automated recovery is safe while PID 37244 is a verified owner or PID 26588 is unverified and possibly running. Current status is **BLOCKED**.

## Verified code behavior

1. `managedTrayControl.ts` reads a size-bounded owner record, checks trusted executable location and kernel listener PID, then authenticates `/tray/health` with bearer token and instance ID. Start refuses any existing owner record; upgrade planning refuses foreign legacy Tray PIDs; mutation checks a fresh owner, planned hashes, revision and foreign process scan before proceeding.
2. Native `tray_lifecycle.rs` binds only loopback, authenticates the bearer, and accepts only `{action:"stop",instanceId:…}`. An authenticated stop is graceful, not a generic process killer. Rust's owner-file initialization may remove an invalid or stale owner record based on PID absence, but **that does not authorize manual record deletion**; a PID-alive test alone cannot attest process identity.
3. `ManagedSidecarLedger` stores only operation hashes, bounded receipts and states. `reconcile` requires an *absent* owner, explicit approval and at least 120 seconds since the pending receipt began; it transitions to `reviewed`, never `completed`. A reviewed ID can never replay.
4. `serviceManager.ts` adds stronger reconciliation preflight: inspected service must be inactive with no owner PID; no owner record; no legacy Tray process; for explicit port, kernel listener evidence must be available and port unbound. A mere failed health probe is insufficient. `reviewed:true`, `confirm:true`, and the **original** operation ID are required.
5. `trayReleaseStore.ts` uses SHA-256 content-addressed immutable executable slots, manifest revision check, and a guard lock. A staged release/rollback pointer is **not** a guarantee of a healthy live process. Upgrade catch retains pending receipt on uncertain outcome, and only attempts best-effort pointer restoration if no managed owner and no foreign Tray process are detected.
6. `nativeTrayLifecycleBridge.ts` allows only narrow lifecycle actions from an authenticated loopback boundary and sanitizes the UI response. It does not relax owner attestation or journal constraints.

## Operator-safe recovery protocol (not executed)

**Phase A — evidence only.** Record exact pending operation ID from the original plan (do not derive it from the 16-character hash prefix), target action, manifest revision and build SHA-256, original receipt timestamp, and the correct 45321/45322 journal identity. Use authorized read-only `status` / `inventory` / `doctor` / `logs` and non-mutating Windows process inspection to compare PID, creation time, full executable path, command line, signature/digest and listener ownership. Distinguish 37244 owner from 26588 foreign process; process identities can change after PID reuse. Capture evidence before any operator action.

**Phase B — resolve foreign instance through its rightful owner.** Have the operator of the Temp test Tray verify its identity and close it normally via its own Tray UI / Quit menu, only if authorized. Do not use taskkill, broad process-name matches, service recycling, test teardown, or an undocumented bypass. If its origin cannot be verified, remain NO-GO. Similarly the verified managed owner 37244 must be intentionally and gracefully stopped through an authorized, freshly planned owner-specific protocol if a later operator decides that interruption is acceptable; **this worker did not perform or authorize that stop**.

**Phase C — prove absence, then optionally review.** Reinspect kernel listener mappings, authenticated owner state, owner-record absence and all Tray process identities. Confirm the exact pending journal and original operation ID, cooldown >=120 seconds, and explicit operator approval. Only after **all** absence checks pass, the supported call is `manage_services({action:"reconcile",service:"tray",targetAction:"upgrade",operationId:"<original ID>",confirm:true,reviewed:true})` for the upgrade ledger (omit `targetAction` for lifecycle ledger 45321). A response marking `reviewed` does **not** establish that an upgrade succeeded; do not retry the original ID. Any unknown, record still present, PID present, or journal lock => stop and escalate.

**Phase D — fresh preflight.** Independently confirm that no foreign Tray remains and no owner record is stranded; re-read release state and trusted build hash, obtain a new `plan` with new operation ID, compare expected owner identity/port/revision/digests, then consider a separately authorized upgrade. Require post-launch native health, kernel PID matching and executable SHA-256. A rollback also requires a separately verified target and fresh plan.

## Audit gaps / follow-ups

- Live evidence was *not* fetched for the two PIDs, actual journal receipt, full binary path, hash, lock state or running installed version. Therefore the original operation ID, exact pending ledger, and completion outcome are **unknown**.
- `serviceManager.ts` picks journal 45322 only when `targetAction==="upgrade"`; **rollback reconciliation also uses journal 45322**, so an ambiguous rollback requires the same selection. Current router lacks an explicit `rollback` selection for that branch: treat as a correctness blocker, **do not fix by modifying the ledger**, and request an owner-reviewed change outside this worker's file scope.
- `managedSidecarLedger.reconcile` accepts a caller-supplied `ownerAbsent` boolean; the safety guarantee depends on the stricter `serviceManager` path. Do not expose ledger reconciliation directly to a UI without equivalent checks.
- `managedTrayControl.ts` creates the release-ledger pending receipt *after* staging the target/fallback and before stop/promotion/launch. A pending receipt can correspond to several partial states; manifest state alone cannot disambiguate it.
- Existing `tests/managedTrayControl.test.ts` contains process-spawning integration tests and conditional `taskkill` cleanup of its own child. **Do not execute this suite** as part of a non-destructive audit. The new test suite uses temp files only, never spawns Tray processes or calls lifecycle mutators.
- Native process ownership, release launch and real Windows regression remain untested here. A separate authorized and isolated E2E is required before production GO.

## Test scope

`tests/trayDeploymentSafetyAudit.test.ts` checks ledger namespace isolation, pending and fingerprint fail-closed rules, 120-second cooldown, manual review semantics, manifest syntax and slot hash validation, and native request validation entirely in temporary fixtures. Intended commands: `bun --bun x vitest run tests/trayDeploymentSafetyAudit.test.ts` and `bun --bun x tsc --noEmit`. Test results must be reported separately; code review does not equal a passing run.
