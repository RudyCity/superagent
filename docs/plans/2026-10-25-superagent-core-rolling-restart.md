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
- Requests already streaming remain bound to the previous worker. New requests for existing pinned session IDs stay on their original worker; previously unseen sessions go to the new worker. Sessionless clients may need explicit resume.
- Old workers intentionally remain alive. Repeated restarts consume memory and ports; generation draining must wait for verified idle jobs/sessions/leases in a later phase.
- Supervisor termination closes public API listener. Full protection requires Windows Service/systemd or another external supervisor.
- Cannot adopt a currently active unsupervised port without disruption. Do NOT launch this over a live T-Line server.

## Phase 2: session-bound routing and process ownership

The supervisor records session affinity only when /api/init or /api/switch-workspace returns successful, server-authorized session metadata. On rolling restart:

- Requests with a known sessionId in URL, x-superagent-session-id, or bounded JSON body for /api/init, /api/chat, /api/switch-workspace stay on the original worker. SSE and upgraded requests with a session ID use the same routing.
- Requests without a known session ID, including new sessions, go to the new active worker.
- The underlying API still validates workspace and client mode. A supplied session ID alone never authorizes access or claims affinity.
- Session traffic is not silently reassigned if its worker exits; the proxy returns 503 and asks for explicit session resume.
- /core status reports pinned session IDs. Routing state is supervisor memory, not an external durable store.
- Session-bound JSON payloads have a 1 MiB routing inspection limit; other routes still stream without buffering.
- Only the initial supervised worker launches the fixed-port Python vision helper. Later workers do not attempt competing port 8095 binds; the initial worker is retained.

Verification:
- bun run build
- bun --bun x vitest run tests/coreSessionRouting.test.ts tests/coreSupervisor.test.ts
- bun scripts/verify-core-supervisor.ts (isolated port, real /api/init sessions, authorization and /api/chat routing; live MCP tunnel untouched)

Known limitations: clients omitting sessionId cannot reliably route to a pre-restart in-memory session; attach it on reconnect, SSE, chat and workspace commands. Agent execution is retained on old workers, not serialized or migrated. Old generations accumulate without automatic drain, session rollback or transport-host crash recovery. OAuth MCP sessions, connected external MCP tools and Muse/Telegram listeners are out of scope.

## Future phase: independent transport host

Move persistent MCP OAuth/session transport, Muse/T-Line sockets and gateway into a dedicated host; build durable agent checkpoints and session ownership with verified reconnect, PID fingerprints, idle draining and rollback tests. Full zero-downtime runtime restart is not guaranteed yet.
