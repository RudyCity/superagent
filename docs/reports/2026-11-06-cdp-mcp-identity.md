# Delegate MCP principal binding — Worker A (2026-11-06)

## Implemented boundary
- An AsyncLocalStorage identity context maps one **verified MCP transport session** to a derived opaque `mcp-...` actor. Untrusted `agentId`, client label, payload, forwarded Core arguments, and profile IDs cannot create this context.
- MCP Delegate-CDP handlers with no verified context fail closed for claimed/mutating operations; read-only inventory is allowed but claimed sessions are filtered out. Local direct invocation retains the legacy agent contract.
- Delegate target selectors are checked for mismatch between qualified target IDs, profile, and tab. All session authorization still happens under the existing per-profile/tab FIFO coordinator lock; stale revisions and owner-only actions remain there.
- The principal identity is **not** proof of end-to-end cryptographic token binding. Browser profile pairing and direct local Core/CDP entrypoints are separate trust boundaries.

## Required integration before enabling authenticated multi-orchestrator MCP operations
`src/core/mcp/superagentMcpServer.ts` is outside Worker A ownership. Its existing `createSuperagentMcpServer` closure already has `connectionBrainSessionId` (generated per MCP transport) and `getIdentity?.()` (authenticated transport identity), but it currently calls `dispatchChromeMcpTool` without propagating either. The owning orchestrator must pass the **trusted** connection as the optional third argument of `dispatchChromeMcpTool(name, args, {sessionId:connectionBrainSessionId,mode:identity.mode,subject:identity.subject})` (the wrapper calls `runWithAuthenticatedDelegatePrincipal`). Do not obtain these values from user tool arguments. Until this wiring, protected MCP Delegate-CDP operations are intentionally rejected rather than pretending authentication succeeded.

For MCP-to-Core proxy forwarding, the remote host sees only a server token, not the original MCP session identity. A trusted, narrowly-scoped, authenticated forwarder context (or owner-side execution within the original MCP dispatch scope) is required. Do not forward a claimed `agentId` as an authorization substitute. `superagent_chrome_vision` has a separate path; keep delegated vision writes denied until the same principal context is enforced end-to-end.

## Regression and limits
`tests/delegateMcpPrincipalBinding.test.ts` exercises two authenticated connections, attempted actor spoofing, missing principal, token reuse across profiles and tabs, owner revisions, and shared observer role. Local tests use in-memory coordinator state only; never mutate a browser or live session. Other workers may change the session coordinator; re-run cross-worker tests before release.
