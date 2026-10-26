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
