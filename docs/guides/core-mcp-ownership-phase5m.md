# Phase 5m — Core / MCP process ownership separation

**Implementation:** Read-only production ownership audit plus test-only independent MCP HTTP process. This does not migrate or rotate the existing OAuth tunnel, stop the legacy API listener or take over the production TCP socket.

## Confirm current ownership before making a restart decision

    superagent core ownership-audit --port 7888

The command compares Windows kernel TCP LISTENING PID evidence (netstat -ano -p TCP) for Core and each recorded MCP server state file. It also checks whether the Core belongs to a verified supervisor or is an unsupervised/foreign process. MCP state files are untrusted hints; a recorded PID without matching OS listener evidence is NOT sufficient to prove ownership. On unsupported operating systems, missing netstat, symlinks, malformed state or ambiguous listening PIDs, the report fails closed.

The report intentionally excludes bearer credentials, OAuth issuers, public URLs, workspace paths and tool arguments. It has no process signals or cleanup side effects. All outcomes report canRestartCore=false, canStopMcp=false and canTransferOAuth=false; even separately owned processes require operator review before cutover.

Observed on this machine (26 October 2026, subject to change): old unsupervised Core port 7888 and MCP OAuth port 6789 share the same PID 13424. Port 9877 MCP OAuth belongs to a separate PID 10060. The decision is shared_owner_do_not_cutover: stopping port 7888's process would interrupt MCP 6789.

## Isolated independent MCP owner smoke

A purposely restricted new CLI mode exists for local staging ONLY:

    superagent mcp owner-sandbox --port ALTERNATE_TEST_PORT

It refuses use unless the operator supplied all of SUPERAGENT_MCP_OWNER_STAGING=1, SUPERAGENT_CORE_STAGING=1, SUPERAGENT_SENOPATI_AUTOSTART=0, a dedicated SUPERAGENT_CONFIG_DIR under the user's .superagent-local-staging directory, and a private 256-bit SUPERAGENT_MCP_OWNER_STAGING_BEARER. It forbids --oauth, --tunnel, dangerous tools and default API port 7888. It creates a local 127.0.0.1-only Streamable HTTP MCP server with static bearer and a restricted safe-tool catalog. It never creates global MCP public-tunnel state, publishes a bearer, or adopts/changes existing OAuth identities.

For controlled validation, do NOT prepare the environment by hand. Run the provided harness:

    bun run build
    bun --bun x vitest run --maxWorkers=2 tests/coreMcpOwnershipAudit.test.ts
    bun scripts/verify-core-mcp-owner-split.ts

The harness starts two completely independent processes under new test-only profiles: one supervised Core and one authenticated MCP HTTP owner. It verifies unique listener PID ownership using the Windows TCP table, an unauthorized 401 and an authorized no-session 400, and no tunnel/OAuth registration. It then terminates only test-owned process trees after confirming each listener still belongs to the spawned PID. It makes no tool calls and does not touch MCP 6789/9877. The report remains inside .superagent-local-staging.

**Important:** The safe-tool classification and the use of a private staging profile are logical application controls, NOT a kernel filesystem/process sandbox. Never expose the sandbox bearer publicly or reuse it for production. In this test no MCP tool method is invoked.

## Roadmap to actual production separation

1. Finish independent MCP owner service with a durable, authenticated lifecycle, secure persistent OAuth key handling, separate tunnel ownership and drain/reconnect protocol.
2. Move production MCP 6789 off the legacy combined PID only in a separately approved maintenance window. Existing OAuth tokens, clients and active MCP sessions cannot be transparently transferred by this phase.
3. After separate ownership is verified and rollback plans are captured, route T-Line through the independent front door and supervised Core; validate installed desktop and session reconnect.
4. Then plan any port 7888 Core cutover. Never kill PID 13424 merely to make port 7888 free.

Full uninterrupted migration of an existing unsupervised process's TCP sockets or active OAuth sessions is NOT implemented. CI matrix covers pure ownership policies; Windows-only test exercises actual two-process listener separation. Remote workflow results remain unverified.
