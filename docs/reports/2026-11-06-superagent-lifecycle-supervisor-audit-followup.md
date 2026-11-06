# SuperAgent Native Tray — Owner-Verified Lifecycle Supervisor Follow-up

**Date:** 2026-11-06
**Repository:** `D:\backup from pc asus\Documents Development\superagent`
**Branch:** `main`, shared working checkout, no new worktree
**Operational boundary:** no live Core, Tray, MCP, Guardian, Vision, tunnel, or daemon restart was requested or performed during this work.

## Summary

Implemented the audited native Tray lifecycle integration gaps and added regression coverage. Lifecycle mutations remain owner-bound, plan-bound, explicitly confirmed, and fail-closed. An authenticated, responsive service is **not** treated as a verified owner when kernel/listener or owner-contract evidence is unavailable.

## Changes

1. `apps/superagent-tray/src-tauri/src/lifecycle_console.rs`: aligned the native Rust allowlist with the TypeScript bridge for supervised Core **restart, rollback, and drain**. Mutations require exactly port 7888, a lower-case SHA-256 build digest, positive expected Core supervisor and worker PIDs, an operation ID, and explicit confirmation. Core start/stop and arbitrary process control remain denied. Added Rust negative tests.
2. `src/core/runtime/serviceManager.ts`: increased Core owner-attestation probe timeout from 1,200 to 2,500 ms. A bound Core listener with a failed supervisor probe is now `unverified`, not falsely `inactive` or definitively legacy. The health readiness calculation rejects unverified owners except the explicitly ownerless in-process process registry; snapshots include `observedAt`.
3. `apps/superagent-tray/ui/lifecycle.js`: integrated the previously unbound **Recycle System** controls with a durable, five-minute, global owner-scoped plan. Analyze only inventories and records the plan. Prepare requires an unexpired, non-blocked plan with actual work. Execute demands explicit human confirmation and dispatches **exactly the original operation ID**; uncertain results are never automatically retried. Manual reconciliation is a separate confirmed step and may still be refused by the owner evidence gate. The UI also clears stale health evidence, identifies `unverified` status separately, uses existing timeline CSS classes, and prevents in-flight responses from a previously selected Core being applied to the new selection.
4. `src/core/runtime/nativeTrayLifecycleBridge.ts`: preserves stable `GLOBAL_RECYCLE_* ` error codes across the native boundary and correctly redacts Windows drive paths and UNC paths, including paths containing spaces.
5. `tests/nativeTrayRecycleUi.test.ts`: new test coverage for analysis, blocked/expired plans, confirmation, exactly-once dispatch, uncertain results, reconciliation, and owner-selection races.
6. `tests/nativeTrayLifecycleBridge.test.ts`: regression test covering redaction of real Windows and UNC path examples.
7. `tests/nativeTrayLifecycleCoreHttp.test.ts`: corrected staging launcher to use Bun rather than Node 24; the SuperAgent CLI explicitly requires Bun and Node rejects the `.tsx` entrypoint.

## Safety invariants maintained

- No arbitrary PID kill or command execution exposed by the Tray lifecycle console.
- All lifecycle dispatches still pass the existing authenticated loopback Core and native Rust validation.
- Only owner-verifiable services are eligible for actual mutation; plans and UI snapshots alone do not authorize mutations.
- MCP reloadable ownership, public Cloudflare tunnel URLs, and OAuth credentials are not modified by global recycle.
- No automatic retry of an uncertain recycle or restart outcome; operators must inspect the original operation ID.
- Selected-Core changes invalidate pending UI plans.
- Automatic recovery remains explicitly opted-out by default.

## Verification

- `cargo test --manifest-path apps/superagent-tray/src-tauri/Cargo.toml --bin superagent-tray lifecycle_console`: **1/1 PASS**, with native owner-bound Core action acceptance and denial gates.
- Final lifecycle regression suite (10 targeted Vitest files, including native staging HTTP E2E): **72/72 PASS** after the owner-selection race enhancement and timeline styling fix.
- `tests/nativeTrayLifecycleCoreHttp.test.ts`: **1/1 PASS** after changing the test launcher from Node to Bun. This starts only an isolated, temporary staging Core on a random loopback port.
- `bunx tsc --noEmit --pretty false`: PASS.
- `node --check apps/superagent-tray/ui/lifecycle.js`: PASS.
- Scoped `git diff --check` on lifecycle files: PASS. Unrelated existing changes in the shared checkout were left intact.

## Explicit release gates and limitations

- **Live version handshake:** at audit time the running Core supervisor reported `ownerContract.version=1` without `safeLifecycleVersion=2`, while current source advertises version 2. The Safe Restart gate is **intentionally NO-GO** until an authorized deployment of a compatible Core generation and verified fresh owner-bound plan. The version check was **not** relaxed.
- The UI is implemented and covered by VM-based DOM tests and a real staging Core HTTP test, but a manual visual/Tauri packaged-app smoke test has not yet been performed.
- Read-only health probes can still fail transiently under host load; the UI now timestamps reports, does not trust prior status after a failed dashboard refresh, and requires fresh backend owner verification for mutations. Independent status endpoints are not a transactional distributed snapshot.
- Direct CDP Delegate work distribution could not start: the authorized Delegate endpoint rejected requests with `DELEGATE_MCP_ATTESTATION_DENIED`. The attestation check was not bypassed; implementation was completed through permitted project tools in the same checkout.
- No commit, push, production restart, or release publication was performed. The working tree also contains concurrent unrelated modifications owned by other developers; these were not reset or staged.

## Recommended deployment verification

After normal release coordination, build and verify the matching Core and native Tray versions without dropping active sessions. Confirm that the authenticated Core supervisor advertises `safeLifecycleVersion=2`, status and native Dashboard agree on owner identity, a new Core plan contains the matching supervisor PID, worker PID and digest, and all required native regression suites pass. Only then consider an explicit owner-bound production restart with user approval.
