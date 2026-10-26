# Phase 5n — managed independent MCP owner (staging) and OAuth cutover safety gates

**Status:** local persistent process lifecycle and staging acceptance implemented. **Not production migration**. At the last ownership audit, production API Core on 7888 and MCP OAuth 6789 shared one PID. MCP 9877 had another owner. None were killed, adopted, redirected or automatically updated.

## Independent managed MCP lifecycle

Commands below manage only a loopback static-bearer safe-tool staging owner. Choose an unused alternate port other than 6789, 7888, 7892 or 9877.

    superagent mcp lifecycle plan --port 6792
    superagent mcp lifecycle status --port 6792
    superagent mcp lifecycle start --port 6792 --approve START_STAGING_MCP_OWNER
    superagent mcp lifecycle stop --port 6792 --approve STOP_STAGING_MCP_OWNER

Start requires exact approval, refuses reserved/occupied ports and duplicate owners, and creates a private staging profile beneath ~/.superagent-local-staging with a separate MCP-only process. It starts a local 127.0.0.1 MCP HTTP transport with restricted gateway tools, static private bearer, NO OAuth issuer, NO public tunnel, and NO model autostart. The persisted lease contains the process PID and a random stop nonce but never the bearer, which is only passed in the private child environment. No global MCP tunnel state is created.

Status verifies the file lease, OS listener PID and unauthorized HTTP 401 challenge. A recorded PID alone is not proof of readiness. Corrupt/stale metadata is blocked, without auto-adoption. Stop requires separate exact approval, verified listener ownership and matching lease. It writes a private nonce-bound stop request; the owner closes its own listener, removes only its matching metadata and exits voluntarily. No process kill is issued. A failed proof/timeout leaves state untouched for operator review.

This is persistence ACROSS CLI EXECUTIONS, not an OS service or auto-reboot recovery. Same-user files are coordination artifacts, not kernel access controls. Application safe-tool mode is not a Windows privilege sandbox.

## OAuth production migration policy

Use:

    superagent core ownership-audit --port 7888
    superagent mcp lifecycle plan --port 6792

The migration gate remains blocked while Core and MCP share a PID, independent OAuth owner is unverified, public endpoint/issuer untested, clients have not reauthorized, legacy sessions or tool effects are unknown, rollback is unproven, or operator approval absent.

Current MCP OAuth state in src/core/mcp/mcpOAuthStore.ts is in-memory. This phase deliberately does NOT export OAuth tokens, transfer live sessions, inherit issuer credentials or move published endpoints. Production clients need explicit reauthorization with the new audited OAuth owner. Even after all checks pass, the policy only offers manual-review candidacy: never automatic cutover, token copying or process termination.

Suggested controlled production sequence:
1. Implement a production-grade independent MCP owner with durable secure OAuth secrets, issuer, logging and rollback.
2. Run in parallel on a new secure endpoint; validate PKCE, token lifecycle, scopes, discovery and explicit client reauthorization.
3. Reconcile external tool side effects; drain or expire legacy sessions, verifying original owner still serves old clients.
4. Rehearse a reversible client/network routing change during a maintenance window.
5. Separately verify supervised Core on 7888 can be cut over without interrupting a live MCP owner. Never force-release the old process.

## Validation

    bun run build
    bun --bun x vitest run --maxWorkers=2 tests/mcpOwnerLifecyclePhase5n.test.ts tests/coreMcpOwnershipAudit.test.ts
    bun scripts/verify-managed-mcp-lifecycle.ts
    bun scripts/verify-core-mcp-owner-split.ts

The Windows staging lifecycle drill selects its own unused loopback port, verifies denial of unauthorized start/stop, owner longevity after CLI exit, duplicate-start refusal, private lease, graceful stop and production PID stability. No external tool is called and no public tunnel is created.

Pending: real production OAuth owner with protected durable credentials, client reauthorization E2E, Windows reboot service installation, installed desktop E2E, extended soak, remote CI confirmation and explicit production cutover.
