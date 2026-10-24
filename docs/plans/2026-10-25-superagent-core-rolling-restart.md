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

## Phase 3a: operator rollback, monitored failover and generation safety

The API control plane now supports core rollback. Actions:
- bun src/cli.tsx core rollback --port 7888
- /core rollback [--port 7888]
- /core status reports active/retained generations, session affinity, retained-worker limit and last rollback reason

A rollback first checks the previous worker with an authenticated localhost /api/status readiness request. The supervisor changes only its default route; sessions initialized by a different generation remain pinned to that owning generation. On observed exit of the current worker process, the supervisor automatically attempts the same verified previous-generation fallback. It does not migrate/abandon failed workers' in-memory sessions, nor does it restart MCP, Muse, Telegram, tunnel or unrelated processes.

To avoid unbounded growth, the supervisor refuses another restart once four prior live/recorded worker generations are retained. No worker is killed to create capacity; this is a fail-closed cap while verified idle-session, job and child-process draining remains unimplemented. Rollback preserves a former active worker if still alive. A crashed generation is not returned to retained generations.

The isolated acceptance test now exercises actual session initialization across worker generations, manual rollback, simulated crash of a test-owned worker PID and automatic failover. Credentials and public port remain stable. Run bun scripts/verify-core-supervisor.ts. Do NOT intentionally kill real worker PIDs to run this acceptance in production.

Operational caveat: process-exit monitoring is not the same as comprehensive hang detection, and the supervisor itself remains a single point of failure. This is Phase 3a API hardening, NOT independent MCP/OAuth/Telegram transport or true zero-downtime runtime migration.

## Phase 3b: verified idle worker drain (API worker only)

Added superagent core drain --port 7888 and /core drain. The operator-initiated action inspects retained worker generations and never drains the active worker. The supervisor performs two authenticated private loopback probes 300 ms apart and refuses retirement unless every condition holds:

- The worker is supervisor-owned and does not own the fixed-port Python vision helper. Supervised API workers no longer spawn competing remote Chrome bridge listeners.
- No session affinity entries, public HTTP requests, SSE streams or upgraded sockets remain on the generation.
- The worker reports no agent sessions, browser clients, pending approvals/questions, background tasks, subagents, CLI bridge/detached subprocess sessions, scheduled jobs, remote Muse tasks/watchers or active daemon scheduler.
- The report matches the expected process PID and supervisor-generated generation nonce. The private endpoint requires a distinct random 256-bit token and is blocked at the public reverse proxy.
- If activity changes between probes, the report cannot be verified or the worker does not exit after bounded SIGTERM, the worker is retained. No process-tree kill or unrelated MCP tunnel termination is performed.

The last drain result (inspected, retired and blocked PIDs) appears in core status. A successful retirement frees one retained-generation slot, allowing later rolling restarts.

Validation: bun run build; bun --bun x vitest run tests/coreDrainInspection.test.ts tests/coreGenerationPolicy.test.ts tests/coreSessionRouting.test.ts tests/coreSupervisor.test.ts; bun scripts/verify-core-supervisor.ts. The isolated smoke exercises session retention, rollback, crash failover, private endpoint denial, blocked drain and verified retirement.

This explicitly requested drain is conservative and limited to the supervised API host. It is NOT persistence of agent checkpoints, adoption after supervisor crash, complete separation of external transport, or a guarantee for unregistered out-of-band child processes. The original vision-owner worker remains retained. External MCP/Telegram/Muse transport supervision is future work.

## Phase 3c: durable API routing checkpoint and explicit supervisor recovery

Added superagent core recover --port 7888 as an EXTERNAL CLI action, not an in-session slash command. Recovery applies only to a service started with superagent core start; it does not adopt unsupervised servers or live MCP tunnels.

- The supervisor saves an atomic versioned routing checkpoint under ~/.superagent-r/core-checkpoint-PORT.json: active/retained workers, private ports, PIDs, generation nonces and session ID ownership mappings. It also contains sensitive API and inspection bearer tokens. Treat this checkpoint as an owner-only secret file; it contains no chat transcripts.
- HTTP 200 on session initialization is sent only after the session-to-worker mapping is durably checkpointed. Checkpoint failures produce HTTP 503 instead of falsely acknowledging durable registration.
- Explicit recovery validates the saved file type/size, schema, ports, token shapes and session ownership. Each surviving generation must prove its original PID, random 128-bit generation identity and private inspection capability, and answer an authenticated API readiness probe. With no verified survivor, recovery fails closed.
- The replacement supervisor rebinds the original public port, preserves the REST bearer, restores session affinity, and rotates the private supervisor control bearer. Adopted workers can serve traffic, but cannot be signalled by drain (no original child handle). New workers created afterward are managed normally.
- A fresh core start refuses to overwrite an existing checkpoint; after a crash, use core recover. Corrupt or stale checkpoint files require investigating orphan worker PIDs before any manual cleanup. There is no unsafe force-adoption switch.
- The isolated hard-crash smoke kills only its test-owned supervisor, performs authenticated recovery and a subsequent rolling restart, validates old session continuity, ensures dead-worker sessions return 503 and confirms bearer stability.

Limits: The public TCP listener is down until the supervisor is recovered, and open SSE/WebSocket TCP connections must reconnect with their session ID after its crash. This is durable routing metadata, NOT serialized LLM agent checkpoints. OAuth MCP sessions, Telegram, Muse and other external transports still require an independent host for true connection continuity. A Windows Service/systemd or similar supervisor is still required to relaunch the API supervisor automatically. Worker births before checkpoint commit remain a narrow crash window. Adopted old workers are deliberately protected from drain and may occupy retained-generation slots.

Validation: bun run build; bun --bun x vitest run tests/coreSupervisorCheckpoint.test.ts tests/coreDrainInspection.test.ts tests/coreGenerationPolicy.test.ts tests/coreSessionRouting.test.ts tests/coreSupervisor.test.ts; bun scripts/verify-core-supervisor.ts.

## Future phase: independent transport host

Move persistent MCP OAuth/session transport, Muse/T-Line sockets and gateway into a dedicated host; build durable agent checkpoints and session ownership with verified reconnect, PID fingerprints, idle draining and rollback tests. Full zero-downtime runtime restart is not guaranteed yet.
