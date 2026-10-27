# Independent MCP tunnel owner

**Version:** 1.14.53  
**Behavior:** both `/mcp tunnel start` and `superagent mcp tunnel start` now launch the MCP HTTP/OAuth+tunnel stack in a dedicated detached process.

## What changed

Previously the interactive slash command called `startMcpTunnel()` inside the running Core process. If Core already owned port 7888, starting MCP from that process could make Core and MCP share one PID. Restarting Core could then interrupt MCP and its OAuth sessions.

The start path now forks an internal `mcp tunnel-owner` child. Startup secrets (Bearer token or one-time OAuth bootstrap code) return to the caller over local process IPC and are not persisted in the owner lease. The owner process writes the existing MCP state plus a private local lifecycle lease.

Expected topology:

    Core API            PID A
    MCP HTTP/OAuth      PID B
    Cloudflare/OpenAI   owned by MCP owner lifecycle

`PID A` and `PID B` must differ.

## Lifecycle

    superagent mcp tunnel start --provider cloudflare --port 9227 --mcp-auth oauth
    superagent mcp tunnel status
    superagent mcp tunnel restart --port 9227
    superagent mcp tunnel stop --port 9227

Stop/restart of a detached owner verifies:

- recorded MCP state PID;
- Windows kernel listener PID;
- authenticated private owner nonce;
- Windows process-birth timestamp.

The controller first requests drain. New sessions are rejected while draining. Stop is accepted only when active MCP sessions and in-flight MCP requests are zero. No `taskkill` or arbitrary PID adoption is used.

Owner-control routes are protected by a separate random credential and accept only a loopback `Host` header, so a public tunnel cannot invoke them.

## Compatibility and limits

The existing `mcp lifecycle` staging owner remains safe-tool, static-bearer, loopback-only and keeps its stricter staging contract.

The new managed tunnel owner supports the same public Cloudflare/OpenAI tunnel and OAuth modes as the existing tunnel command. This process separation does **not** migrate an already-running legacy OAuth owner or copy its tokens/sessions. A legacy Core+MCP process must remain online until clients explicitly reauthorize to a new endpoint and the old owner is safely drained.

Cloudflare quick-tunnel URLs change after restart, so their OAuth issuer/resource also changes. Long-lived OAuth identity requires a stable public endpoint plus the separately certified durable OAuth storage path.

## Validation performed on Windows

- focused MCP regression tests: 31/31 passed;
- independent Core/MCP split verifier: 24/24 passed;
- managed staging MCP lifecycle verifier: 17/17 passed;
- independent OAuth stage verifier: 20/20 passed;
- live static-bearer managed tunnel start/stop on an isolated port;
- live OAuth managed tunnel start/restart/stop on an isolated port;
- production Core and legacy MCP listener PIDs remained unchanged during those tests.
