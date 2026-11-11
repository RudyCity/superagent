# SuperAgent Safe Lifecycle v2 — Core and Tray

## Purpose

Fail-closed advisory preflight appears in the native Tray Unified Lifecycle Supervisor through dashboard.safeLifecycle.core and dashboard.safeLifecycle.tray. A READY verdict is never an authorization. An owner-verified new plan plus explicit human approval is required.

## Core

Before any blue-green restart: compile current Core; verify owner contract, source/dist SHA digest, and Safe Lifecycle protocol v2; match current supervisor PID, worker PID and public port; inspect retained workers, sessions and in-flight requests; validate fixed Delegate listener port owner and persisted ON/OFF preference; reject pending lifecycle operations. A legacy supervisor WITHOUT safeLifecycleVersion 2 is NO-GO even if it has a fresh worker. Do not force a recycle to skip this gate.

Native restart uses owner-bound expectedSupervisorPid, expectedWorkerPid, expectedBuildDigest and an operationId. User must confirm. The native UI performs a second non-mutating dashboard check immediately before dispatch. Any unknown state blocks; never auto-replay after timeout. Draining retained workers may only retire nonce-verified, quiescent owned worker children and must preserve adopted helpers.

## Legacy Core recycle preflight

Use `manage_services` with `action=doctor`, `service=core`, and the intended port before requesting a recycle plan. The read-only `coreRecycleReadiness` section reports separate owner and build readiness, redacted blocker codes, and a next step. This report never authorizes shutdown and never issues an operation ID.

A Windows TCP listener may temporarily expose PID 0. Recycle only accepts that case when the listener is present, the recorded Core PID has the expected command and port, its OS creation time matches the server-info timestamp, and an authenticated Core probe succeeds. A conflicting positive PID, absent listener, missing process identity, stale checkpoint, or failed authentication still blocks recycle.

`CORE_BUILD_STALE_OR_UNVERIFIED` requires a fresh compiled build and matching manifest. Build from the installed package root in an approved maintenance window, then repeat `doctor` and request a **new** `plan` with `targetAction=recycle`. Never auto-build or skip a source/dist mismatch during plan or execution. Keep MCP, tunnels, and unrelated processes untouched.

Recycle execution requires the exact owner-bound operation ID, PID, birth identity, command SHA-256, build SHA-256, client mode, and explicit confirmation. The detached helper acknowledges process spawn before the request reports `scheduled`; monitor `manage_services action=logs service=core` for success or uncertain outcome. A pending/unknown operation must be reconciled, never silently replayed under another ID. Missing Core and healthy supervised Core are not legacy recycle cases.

## Tray

Both operation journals must be free of uncertain pending entries: 45321 for native lifecycle, 45322 for release upgrade/rollback. Owner PID, instance ID, listener port and executable SHA must be verified. A foreign/unverified Tray PID blocks restarting even a verified owner. Never kill it blindly, delete journal files, or infer absence from an unsuccessful health probe. Ask the owner to close its test Tray normally. Plans require noCoreShutdown true; Core, MCP and tunnels are not part of Tray restart. If outcome is uncertain, keep the exact operation ID for authorized review; never regenerate and retry automatically.

## UI and checks

Tray → Runtime → Unified Lifecycle Supervisor → Refresh Lifecycle. Review each Core/Tray card showing Safe Restart READY or NO-GO with reason codes. Select service → Safe Restart → Prepare Plan → Confirm & Execute only when current evidence is READY. Core also has dedicated Drain and Rollback actions requiring their own owner-bound plans and explicit confirmation.

Offline checks: run bun --bun x tsc --noEmit and the safeLifecycle, safeTrayRestartPlanGuards, nativeTrayLifecycleBridge, nativeTrayLifecycleUi and coreLifecycleControl Vitest suites, then bun run build. Passing offline tests is not a substitute for a separately authorized real multi-worker restart or installed Tray upgrade. Keep production NO-GO until real owner evidence and post-operation health are independently verified.
