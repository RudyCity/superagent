# R6 Security and Release Certification — Evidence Matrix

## Scope

R6 adds adversarial tests and read-only release evidence, separate from any production cutover. It checks the fail-closed boundaries of R1 safe MCP tool dispatch, R2 issuer credentials, R3 ingress, R5 cold recovery and R7 manual cutover.

Passing source-level or isolated staging tests does NOT certify live clients, a hardened production OAuth key store, native installed T-Line, an actual Windows reboot, public TLS, or a 24–72-hour soak. None is marked complete automatically; live processes are not restarted.

## Local verification

    bun run build
    bun --bun x vitest run --maxWorkers=2 tests/runtimeSecurityMatrixR6.test.ts tests/runtimeReleaseGateR5R7.test.ts tests/mcpDurableOAuthR2.test.ts tests/mcpIngressStageR3.test.ts tests/mcpSafeOwnerR1.test.ts tests/mcpProcessBirthR1.test.ts
    bun scripts/verify-runtime-security-release-r6.ts 7888

Windows isolated acceptance:

    bun scripts/verify-independent-oauth-stage.ts
    bun scripts/verify-managed-mcp-lifecycle.ts
    bun scripts/verify-core-mcp-owner-split.ts

Every integration test must use a private staging directory, random local port, and test-owned PID. Do not target production MCP ports 6789/9877 or legacy Core 7888.

The read-only release-evidence command reports BLOCKED unless live independent owners, installed desktop E2E, actual client reauthorizations, zero unknown external tool outcomes, Windows security certification, extended soak and tested rollback are verified. A zero exit code confirms only that fail-closed checks work, not that production is certified.

## Negative test matrix

- Each missing certificate blocks rollout even if others are synthetically fulfilled
- Shared Core and MCP PID or unverified MCP owner blocks cutover
- Unknown or nonzero external effects, invalid session counts and corrupt snapshots block recovery
- Absent issuer secret, stale/reused PID, and unverified ingress prohibit service adoption
- MCP HTTP ingress rejects Core endpoints, private management paths, encoded traversal and wrong methods
- Restricted MCP owner denies write/admin/execute, cross-workspace file access, symlinks and gateway recursion
- Even idealized synthetic release evidence permits only manual-review candidacy, not automatic routing, OAuth token import, process termination or tool replay

## Outstanding real release certificates

| Gate | Evidence required | Current certification |
|---|---|---|
| OAuth production secrets | Protected OS-keystore/DPAPI, ACL, backup, rotation and recovery | Not certified |
| Public ingress | TLS issuer/resource parity, owner separation and rollback | Not certified |
| Installed T-Line | Native two-workspace replay/approval isolation, reconnect and runtime compatibility | Not certified |
| Windows actual reboot | Startup/recovery with stale PID, lease and session chaos | Not certified |
| Extended soak | At least 24–72 hours of CPU/RAM/handles, reconnect and process measurements | Not run |
| Live client migration | PKCE reauth per client, legacy session drain and external effect reconciliation | Not performed |
| Cutover | Maintenance window, operator approval and tested reverse routing | Not authorized |

Forward roadmap: docs/plans/2026-10-26-runtime-ownership-and-safe-recovery-master-plan.md R2–R7. The current release gate intentionally does not include any auto-takeover action.

## Read-only short / extended process observation (2026-10-26)

Use `bun scripts/observe-runtime-soak-r6.ts 6 2` on the staging / Windows
host for a six-second minimum observed window (two-second nominal sample
interval). The command samples OS listener PID ownership on ports 7888,
6789 and 9877, working set, cumulative process CPU seconds and OS handle
counts. It only runs netstat and Get-Process; no process signals,
credentials, OAuth requests, session creation, external notifications or
route changes. It emits a machine-readable JSON report to stdout without
writing private process details to shared folders.

For an operator-supervised long observation, the foreground command accepts
a duration in seconds (up to 259200, 72h) and sample interval (1–30s);
run within a managed terminal and explicitly preserve the JSON result.
There is NO built-in background scheduler, persistent storage, or alerting.
If the terminal exits, no completion may be claimed. Before long sessions
choose a 30-second interval to limit in-memory accumulation. A result is
`incomplete` when the requested observation window is not covered,
`unstable` when PIDs change, samples have large gaps, CPU counters
regress or process metrics are missing; otherwise
`observed_window_complete` means **only this interval** was observed.
Any result always has productionCertified=false and never permits a
restart, cutover or token import. A stable 24–72h observation still must
be combined with installed desktop, TLS/keystore and operator certification.

Negative tests: tests/runtimeReadOnlySoakR6.test.ts. CI exercises the
assessment policy; it never assumes running Core/MCP listeners in CI.
