# Core Guardian — supervised Core crash recovery

**Status:** implemented opt-in, verified on isolated Windows staging. This is an initial stage of unified runtime lifecycle, NOT whole-system zero downtime.

## Command

Run only on a free API Core port with a new, isolated profile. Never aim at a running unsupervised or unknown process:

~~~powershell
superagent core guard --port 7888 --client-mode tline
superagent core guard-status --port 7888
superagent core status --port 7888
superagent core restart --port 7888
superagent core rollback --port 7888
superagent core drain --port 7888
~~~

Core Guardian is a **separate long-running CLI process**, not a new in-chat slash action. Client mode may be tline or chrome-extension. To enable controlled stdin shutdown by a process manager:

~~~powershell
superagent core guard --port 7888 --stop-on-stdin
~~~

Send a single line **STOP** to guardian stdin. That stops the guardian but deliberately **leaves Core and its sessions running**. The Windows terminal SIGTERM path may not invoke graceful cleanup; prefer controlled stop.

## Ownership and recovery behavior

1. Startup requires **no existing core supervisor discovery or durable checkpoint** at the requested port. It claims an exclusive lease under ~/.superagent-r/core-guardian-PORT.json, containing its PID and instance ID but no bearer token.
2. Guardian spawns an **independent detached** Core supervisor, verifies supervisor PID via authenticated loopback control, and validates Core's durable checkpoint and client mode.
3. When **that exact child** crashes, guardian checks that no other authenticated supervisor is online and checkpoint evidence is still valid. It then invokes the existing Core **recover** operation instead of overwriting checkpoint or spinning up a new blank Core.
4. Recovery still verifies preserved worker PID, generation identity, private inspection capability and authenticated readiness. Client bearer, original worker, and session affinity remain stable **only when the same worker survived**.
5. Up to **3 recoveries in 10 minutes**, with exponential backoff starting at 1 second. If a worker/checkpoint is unavailable, the port is occupied, or the budget is exhausted, fail closed and require operator intervention.
6. Neither guardian shutdown nor Core recovery kills or adopts MCP tunnels, Muse, Telegram, T-Line transport, unknown PIDs, or worker session processes.

**Important:** An existing guardian lease file is only stored metadata, NOT proof the guardian itself is still alive. Guardian startup never auto-clears stale locks. If it crashes while Core is alive, new guardian startup is refused while an existing checkpoint remains; verify owner/worker evidence manually. No unsafe auto-adoption of pre-existing Core is implemented.

**Reconnect reality:** Existing SSE/WebSocket streams through the Core supervisor are interrupted during a supervisor crash and need to reconnect using sessionId. The separate T-Line front door stays bound and its process PID remains unchanged; backend may return 503 during recovery. An agent worker crash is NOT equivalent to supervisor crash: non-durable in-memory agent state cannot be magically migrated or replayed.

## Local-only staging acceptance

~~~powershell
bun run build
bun --bun x vitest run --maxWorkers=2 tests/coreGuardian.test.ts tests/coreSupervisor.test.ts tests/coreSupervisorCheckpoint.test.ts tests/coreSessionRouting.test.ts tests/coreGenerationPolicy.test.ts tests/coreDrainInspection.test.ts tests/transportHost.test.ts
bun scripts/verify-core-guardian.ts
bun scripts/verify-core-supervisor.ts
~~~

The guardian smoke script creates a new private home/config profile and two random loopback ports for the Core and independent T-Line transport. It uses real authenticated init requests, then force-terminates **only its own verified Core supervisor**; it checks that the original worker, bearer and session affinity survive and the transport PID/listener remain the same. After a controlled guardian STOP, Core and transport still run, and the script cleans up only processes created within this test. It never connects to an external AI model, sends notifications, restarts any MCP tunnel, or modifies production config.

Acceptance: **21/21 real-stage checks**, plus unit tests; audit record retained under ~/.superagent-local-staging/core-guardian-*/guardian-report.json. The script is not a live production failover test.

Cross-platform workflow: .github/workflows/core-guardian.yml (Ubuntu and Windows). Local PASS does NOT prove remote GitHub Actions succeeded.

## Phase 5b: login-time boot and Windows Task Scheduler

The new Core boot command is a fail-closed entry point for per-user login startup:

    superagent core boot --port 7888 --client-mode tline

When an authenticated Core is already running, boot does nothing. With no discovery and no checkpoint, it starts a fresh guardian. With a valid checkpoint and no active guardian lease, it attempts authenticated recovery of the original worker. A **full OS reboot destroys worker memory**: boot refuses to erase old session checkpoints or silently recreate the old agent. Bad checkpoint, wrong client mode, conflicting discovery, or leftover guardian lease also refuse unsafe recovery.

Preview the Windows **per-user at-logon** task without registering anything:

    bun run build
    bun scripts/setup-core-windows-startup.ts --port 7888 --client-mode tline

The preview exposes the exact Bun/CLI paths, task name, installation and inspection commands. It does not change OS scheduling, send notifications or start a Core. After verifying all paths and ownership, the **explicit operator opt-in** is:

    bun scripts/setup-core-windows-startup.ts --port 7888 --client-mode tline --apply

The registration uses Task Scheduler with limited user privileges, runs after the user logs on (not as a machine-wide service before login), and has bounded restart on command failure. The generated launcher contains only executable paths, no credentials; existing launcher files and scheduled tasks are never silently overwritten. **Task registration has not been run on the live system.**

Staging acceptance was expanded to 26 checks: initial guardian/recovery and T-Line affinity, Core boot no-op on running owner, verified surviving-worker login recovery, and refusal to revive lost in-memory agent sessions when every worker is dead.

This is not unattended full OS reboot restoration, worker LLM-state checkpointing, MCP session migration or an installed Windows Service. After a machine reboot with a stale Core checkpoint, a human must review the previous session/side-effect status before a new cold start.

## Limits still pending

- OS service manager / reboot supervision of the **guardian itself** must be installed and reviewed independently; this command does not register a Windows Service.
- Existing production supervisors and already-open listeners are intentionally **not adopted**.
- Whole-machine restart, worker-side LLM state migration, cross-process tool-state replay, MCP OAuth session migration, and seamless SSE/WebSocket TCP continuity are NOT implemented.
- Never clear a stale lease or checkpoint solely because a PID seems absent; manually verify process ownership and side effects.

See the [rolling restart architecture](../plans/2026-10-25-superagent-core-rolling-restart.md) and [local recovery staging](muse-local-staging.md).
