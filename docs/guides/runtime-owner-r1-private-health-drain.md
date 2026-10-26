# R1 — Authenticated MCP owner health and graceful drain (staging)

**Status:** first implementation of R1.3 and R1.5 on the EXISTING MCP HTTP host and the Phase 5n persistent lifecycle. This does not install a Windows service, migrate OAuth, move a public tunnel, or authorize any production restart. R1.1–R1.2 host consolidation and R1.4 full gateway/write permission audit remain open.

## Implementation / security boundaries

- `src/core/mcp/mcpHttpTransport.ts` exposes `/_internal/owner/status` (GET) and `/_internal/owner/drain` (POST) **only** when its caller explicitly sets a distinct 256-bit `ownerControlToken` and immutable `ownerStartedAt`.
- The option is intentionally rejected in OAuth and dangerous-tool modes. The HTTP listener remains on loopback, uses normal Host/Origin validation, refuses wrong/missing control token with HTTP 401, refuses wrong method with 405, and sends `Cache-Control: no-store`. Without opt-in, these routes return 404.
- The private status is `version=1`, `kind=private_mcp_owner`, `port`, `pid`, `startedAt`, safe-mode flags, `draining`, active MCP session count, and in-flight MCP HTTP request count. It never outputs raw session IDs, workspace paths, OAuth subjects, client tokens, control nonce, or tool arguments.
- Unknown external side effects remain explicitly `inflightToolEffects="unknown"`; the transport **does not claim exact-once effects or prove a remote job is finished**.
- The private owner control is tied to the existing same-user protected local lease `managed-owner.json` (nonce, PID and start timestamp). `probePrivateMcpOwner` authenticates with that nonce and verifies the returned process generation fields, independently of the client's MCP bearer. The lifecycle still requires matching Windows kernel listener PID and an unauthorized 401 check.
- `drain` requires its own exact operator approval. It changes only the managed owner's in-memory draining flag; existing initialized sessions may finish or expire. New session initialize calls and new stateless POST requests are rejected 503. Drain does not kill a process, revoke tokens, disconnect existing clients or bind any external provider.
- `stop` requires a separate approval AND verified drain AND zero remaining sessions AND zero HTTP requests in flight. The owner checks these again before voluntarily closing after receiving the private, nonce-bound stop marker. Any uncertain identity or active work blocks stop.

There remains a race window inherent to same-user file coordination and OS scheduling. The managed owner is a staging safety mechanism, NOT a hardened Windows security boundary or a live OAuth-session migration tool.

## Operator commands (fresh, unused alternate staging port only)

    superagent mcp lifecycle plan --port 6792
    superagent mcp lifecycle start --port 6792 --approve START_STAGING_MCP_OWNER
    superagent mcp lifecycle status --port 6792
    superagent mcp lifecycle drain --port 6792 --approve DRAIN_STAGING_MCP_OWNER
    superagent mcp lifecycle status --port 6792
    superagent mcp lifecycle stop --port 6792 --approve STOP_STAGING_MCP_OWNER

Do not issue commands against 6789, 7888, 7892 or 9877; production ports are explicitly refused. A refused stop with active sessions is intentional, not a signal to use taskkill. The private management nonce must never be copied to client MCP bearer configuration.

## Test acceptance and remaining work

    bun run build
    bun --bun x vitest run --maxWorkers=2 tests/mcpOwnerControlR1.test.ts tests/mcpHttpTransport.test.ts tests/mcpOwnerLifecyclePhase5n.test.ts
    bun scripts/verify-managed-mcp-lifecycle.ts

Tests cover opt-in route hiding, rejected client bearer, generation mismatch, rejected drain without control credentials, live initialized session preservation, rejected new sessions while draining, eventual session DELETE, explicit approvals, duplicate ownership, graceful owner exit and unchanged production listeners.

## R1 completion addendum — verified staging owner

R1.1 and R1.2: The existing mcpOwnerLifecycle.ts exposes ONE typed McpOwnerHost interface and stagingMcpOwnerHost facade to status, start, drain, and stop the same existing owner process. Capabilities are versioned, private-auth only, and explicitly mark external ingress and OAuth as unsupported. There is no additional daemon or silently adopted provider.

R1.3: The owner must pass all three attestations before a ready/drain/stop decision: private nonce-bound generation probe (PID, exact port, start timestamp), Windows kernel TCP owner PID and Windows Get-Process kernel birth timestamp. A stale PID, missing PowerShell or reused PID fails closed. The private staging lease uses exclusive-create semantics and stops only through its original private nonce request; process signals are not sent.

R1.4: Safe-only policy is immutable at the MCP dispatch layer. It cannot be unlocked by machine-wide scoped/full YOLO mode, even after launch. A narrowed explicit read-only tool catalog excludes global project listing, global config and administrator tools, denies arbitrary remote project IDs and workspace/path traversal, resolves symlinks against the private owner workspace, and recursively checks nested tool_execute targets. Resources and Prompts are not advertised by this restricted owner. Legacy non-staging MCP hosts retain their existing behavior.

R1.5: Authenticated status, generation identity, counters and drain behavior are live and covered by unit and real-process acceptance tests. In-flight external tool outcomes remain "unknown", not a false promise of exactly-once effects.

This completes **R1 acceptance for the isolated Windows staging safe-tool owner**, NOT the unimplemented R2 production OAuth issuer, R3 public tunnel ownership, T-Line native rollout, system-wide task scheduling or R7 manual client migration. Do not use the staging owner as a privileged/unrestricted production MCP deployment.

Additional validation:

    bun --bun x vitest run --maxWorkers=2 tests/mcpSafeOwnerR1.test.ts tests/mcpProcessBirthR1.test.ts tests/mcpGatewayHttp.test.ts tests/mcpProjectAccessPolicy.test.ts
    bun scripts/verify-managed-mcp-lifecycle.ts

**Master roadmap:** `docs/plans/2026-10-26-runtime-ownership-and-safe-recovery-master-plan.md`.
