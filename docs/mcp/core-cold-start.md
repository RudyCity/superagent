# Core cold start through independent MCP

The independent, authenticated MCP owner can bootstrap a stopped SuperAgent Core without restarting the public Cloudflare tunnel. This is a **manual, owner-bound** lifecycle operation, not an automatic service takeover.

## Operation

1. Call `superagent_manage_services` with `{"action":"status","service":"core"}`. A healthy Core does not need bootstrapping.
2. When the Core is inactive, request a read-only plan: `{"action":"plan","service":"core","targetAction":"start","port":7888}`.
3. Only if the plan returns an `operationId`, submit `{"action":"start","service":"core","port":7888,"confirm":true,...}` with the **unchanged** `operationId`, `expectedOwnerPid`, `expectedInstanceId`, `expectedBuildDigest`, and `clientMode` from that plan.
4. Verify the resulting `ownerPid`, `verified` and `tunnelUnaffected` fields, then recheck Core and MCP status independently.

The plan and the command are protected by the existing MCP OAuth write scope, local dangerous-tool permission, and owner-bound lifecycle checks. An unverified or foreign listener, a stale build, unresolved durable effects, an unsafe checkpoint, a concurrent launch, or a pending uncertain operation all prevent a new start. This procedure neither executes arbitrary commands nor kills processes. It never replaces a Cloudflare URL.

The launcher starts only the checked-in compiled Core entry using the verified Bun executable and calls the existing `core boot` recovery policy. Existing checkpoints and session receipts are not discarded or replayed automatically. Successful readiness requires an authenticated Core supervisor, the expected kernel listener owner and a child/Guardian link to the launch.

## Failure and reconciliation

A `CORE_START_UNCERTAIN_TIMEOUT` or pending receipt is **not** proof of failure. Do not immediately send another start with a new operation ID. Review the Core listener, guardian lease, ownership ledger, and recovery evidence with an authorized operator. The operation log and bootstrap lock are local-only. No process is killed to resolve an uncertain launch.

The MCP owner must itself remain running for the request. If both MCP and Core are down, an independent OS or Tray supervisor must first restore MCP. Automatic Core starts are not enabled by this change. Rebuilding the runtime and reloading the independently managed MCP backend is required before the live MCP tool uses this code.

## Verification

Run `bun --bun x tsc --noEmit`, `bun --bun x vitest run tests/coreMcpBootstrap.test.ts tests/serviceManager.test.ts tests/serviceManagerMcp.test.ts tests/coreBoot.test.ts`, and `bun run build`. Never use the production Core port for destructive failover tests. A full cold-start E2E needs an isolated profile and explicit cleanup of the temporary owned process.
