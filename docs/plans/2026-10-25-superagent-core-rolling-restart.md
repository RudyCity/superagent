# Opt-in rolling restart for SuperAgent API Core (2026-10-25)

## Supported implementation (phase 1)

The dedicated API supervisor owns the stable public loopback REST/SSE/WebSocket port. Child core workers run on separate private loopback ports. On restart, a new worker first passes an authenticated HTTP readiness probe, then starts receiving new requests. Old workers are retained, so open SSE/WebSocket connections and subprocesses are not deliberately terminated.

CLI commands:
- Start ONLY after moving any unsupervised listener off the selected port: bun src/cli.tsx core start --port 7888 --client-mode tline
- Inspect: bun src/cli.tsx core status --port 7888 or /core status
- Roll worker: bun src/cli.tsx core restart --port 7888 or /core restart

The compiled dist/cli.js works after rebuilding; build before the restart to use new dist code.

Security: control listener is loopback-only, protected by a random 256-bit bearer key stored in an owner-mode file under ~/.superagent-r/core-supervisor-PORT.json. The public REST token remains constant between worker generations. Neither credential appears in status output. There is no remote/core-control MCP tool.

Scope:
- No taskkill, /stop all, tunnel replacement, or process-tree cleanup for previous worker generations during core restart.
- Standalone MCP HTTP tunnel, OpenAI/Cloudflare MCP connector, Muse transport, Telegram, CLI jobs, and other background processes are not restarted by this supervisor.
- This does NOT hot-patch already running MCP server code, nor migrate in-memory agent sessions, OAuth registries, or MCP Session IDs across processes. Those components require future out-of-process connection and session management.
- Requests already streaming remain bound to the previous worker. New requests after the switch use the new worker. Clients may need to resume sessions on the new worker.
- Old workers intentionally remain alive. Repeated restarts consume memory and ports; generation draining must wait for verified idle jobs/sessions/leases in a later phase.
- Supervisor termination closes public API listener. Full protection requires Windows Service/systemd or another external supervisor.
- Cannot adopt a currently active unsupervised port without disruption. Do NOT launch this over a live T-Line server.

## Next phase

Move persistent MCP OAuth/session transport, Muse/T-Line sockets and gateway into a dedicated transport host; create durable session/checkpoint store, session-affinity and verified handoff; add generation ownership, safe retirement, crash recovery and rollback tests. Full zero-downtime restart is NOT available yet.
