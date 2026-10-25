# Opt-in rolling restart for SuperAgent API Core (2026-10-25)

## Phase 5d — read-only cold-boot audit and reconnect safety contract

Core now exposes the read-only command superagent core boot-audit --port 7888. It checks authenticated supervisor status, an unexpected TCP listener, checkpoint/discovery/guardian lease, persisted session receipts, and the existing SQLite chat-turn table through a separate read-only connection. Unknown or corrupt state never becomes a zero count; valid checkpoint plus dead/unknown workers always requires operator review. The audit cannot remove any checkpoint or send signals, and always reports automaticToolReplay=false. Actual boot remains fail-closed after a full OS reboot until side effects and old owners can be reconciled.

The independent T-Line front door returns code CORE_SUPERVISOR_UNAVAILABLE, retryAfterMs and a no-replay flag for temporary 503; dead-worker sessions get SESSION_WORKER_DEAD / SESSION_OWNER_UNAVAILABLE, requiresExplicitResume=true, and no-replay. A bounded pure reconnect controller preserves the session ID and automatically permits only GET health/status probes; chat/tool POST is never retried. The safe resume payload requires explicit approval and durable history evidence. This provides a client integration contract, not an installed native T-Line UI implementation.

Isolated Windows acceptance exercises Core Guardian crash/recovery, total worker loss with read-only audit and unchanged checkpoint, and an explicit safe session resume, alongside transport error-code unit tests. GitHub workflow has both Ubuntu/Windows test gates but no remote status verified. See [Phase 5d runbook](../guides/core-phase5d-restart-safety.md). Production process restart, OS task installation, MCP tunnel restart, Muse/Telegram activation and outbound alert delivery were not performed.

## Phase 5c — durable supervised session receipts and explicit worker rebind

Supervised API workers now atomically record scoped session metadata on /api/init and /api/switch-workspace and checkpoint accepted chat turn IDs before execution. This reuses the existing SQLite history + chat-turn ledger rather than duplicating prompts or claiming Agent memory serialization. When a pinned worker dies, normal requests still return 503. A client must explicitly POST /api/init with matching sessionId and resume, the same workspace/mode/client mode and a saved history recent enough to cover the last accepted turn. Ambiguous running/queued/interrupted/accepted turn states, corrupt or missing receipts, missing/stale history, mismatched workspace, and wrong client mode block recovery. Only a verified success receipt from a different healthy worker permits durable supervisor affinity rebind; failure to persist it restores the previous mapping. No tool is replayed. New sessions that enter through /api/switch-workspace are included in the same receipt requirements.

The independent, isolated Windows stage creates three sessions, rolls the Core, hard-kills its own original worker and validates 19 fail-closed/explicit-resume checks without invoking any model, external tool or tunnel. Cross-platform CI includes the focused policy suite and real stage. Full OS-reboot LLM state recovery, arbitrary external side-effect transactions, and native desktop reconnect remain unimplemented. Read [Phase 5c operator guide](../guides/core-agent-session-recovery.md).

## Phase 5b — safe logon Core bootstrap and Windows task provisioning

Core boot inspects authenticated current Core owner, durable routing checkpoints, and guardian/discovery registration. It never resets stored sessions. It performs a no-op if Core is already verified; starts a new guardian only in a pristine namespace; or attempts authenticated worker recovery when the original worker survived supervisor crash. When no worker survived (including after a full Windows reboot), the Core checkpoint remains unchanged and boot fails closed until operator reconciliation.

The Windows Task Scheduler generator is preview-only by default and creates a current-user, at-logon task plan. Explicit --apply registers it without elevation, replacing existing scheduled tasks, or auto-starting live services. Task registration was NOT invoked. Existing MCP/Muse/Telegram tunnels remain outside the Core lifecycle. The isolated Windows staging smoke now validates 26 invariants including surviving-worker boot recovery and dead-worker refusal. The CI workflow adds policy tests and this staging test to Linux/Windows matrices. See [Core Guardian recovery and startup guide](../guides/core-guardian-recovery.md).

## Phase 5a — opt-in owner-scoped Core Guardian (2026-10-25)

An independent guardian process can start a *new*, unowned API Core supervisor only when both the Core discovery and checkpoint files are absent. It validates that the newly started supervisor PID matches its child and that a fresh durable checkpoint exists. If that same child crashes, and no other authenticated supervisor is online, it may invoke the existing Core recover path. Adoption still requires the original worker PID, generation identity, authenticated private inspection and readiness. The old worker, session affinity, public API bearer and separate T-Line transport remain intact when that worker survives. Crash-related SSE/WS disconnects still require reconnect. The guardian has a strict budget of 3 recoveries in 10 minutes and exponential backoff; it never restarts tools, takes over unsupervised servers or kills MCP/Muse/Telegram/tunnels.

    superagent core guard --port 7888 [--client-mode tline|chrome-extension]
    superagent core guard-status --port 7888
    superagent core guard --port 7888 --stop-on-stdin

Stdin STOP provides an explicit guardian-only shutdown that leaves Core/transport alive. The lease is an exclusive, operator-owned metadata file, not authenticated heartbeat, and cannot be force-adopted. An already existing Core checkpoint is intentionally incompatible with fresh guard startup. The operator must inspect old ownership and use manual Core recovery if required. Auto-relaunch guardian itself on OS restart, distributed failover, in-flight worker agent migration and full TCP stream continuity are NOT implemented.

Verification: build, core guardian Vitest suite, real Windows staging script with 21 validations (private profile, random loopback Core and T-Line front door, hard-kill only the verified test-owned supervisor, restore old session, guard clean shutdown) and pre-existing core supervisor acceptance. GitHub Actions workflow is configured for Ubuntu/Windows but remote status is not yet confirmed. See [Core Guardian runbook](../guides/core-guardian-recovery.md).

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

## Phase 4a: independent T-Line transport front door (opt-in)

A separate Bun process can own a stable loopback REST/SSE/WebSocket listener independently of the supervised API core. This affects the opt-in T-Line frontend only. It does NOT adopt MCP, Muse, Telegram, cloudflared or connected external services. Existing MCP tunnel servers already have their own processes.

To enable on unoccupied ports in separate terminals:
- bun src/cli.tsx core start --port 7888
- bun src/cli.tsx transport start --port 7891 --core-port 7888
- bun src/cli.tsx transport status --port 7891

Point T-Line to http://127.0.0.1:7891 instead of port 7888 when opting in. API bearer authorization remains enforced by the core API. Core restart/rollback still address backend port 7888, not frontend port 7891.

Before forwarding credentials or upgraded sockets, the transport host verifies the authenticated supervisor control endpoint. If the backend is missing or occupied by an unknown process, forwarding fails closed with HTTP 503. REST request/response bodies and SSE events are streamed, and raw WebSocket upgrades are proxied. Private /_core/ and /_transport/ routes are blocked except read-only GET /_transport/health which shows frontend status, backend readiness, and open request/socket counters without bearer secrets.

When the API supervisor crashes, the separate transport PID and listener remain up, but backend requests receive HTTP 503. Explicit core recover can restore the supervised backend behind the SAME T-Line listener. New client requests then succeed, and previously initialized sessions stay pinned to original workers via recovered affinity mappings.

Limits: existing SSE/WebSocket TCP streams still depend on their upstream supervisor connection; those streams break on supervisor crash and must reconnect using sessionId. This host does not automatically restart the supervisor, resume agent objects, own MCP OAuth sessions, run Muse/Telegram watchers or manage cloudflared. Host and supervisor are separate long-running processes; an external Windows Service/systemd-style manager is still needed for unattended process restarts. Both listeners bind loopback only. Production deployments must ensure port access and credentials are protected.

Verification:
- bun run build
- bun --bun x vitest run tests/transportHost.test.ts tests/coreSupervisorCheckpoint.test.ts tests/coreDrainInspection.test.ts tests/coreGenerationPolicy.test.ts tests/coreSessionRouting.test.ts tests/coreSupervisor.test.ts
- bun scripts/verify-core-supervisor.ts

Unit coverage includes REST, SSE, WebSocket upgrade handshake, backend outage, private route shielding and safe rejection of unverifiable upstreams. The isolated end-to-end scenario launches an independent transport host process, crashes only its own test supervisor, then recovers the backend while the transport PID persists. No live MCP tunnel is altered.

## Phase 4b: dedicated opt-in Muse/Telegram channel host

An additional Bun process now owns an optional Muse WebSocket watcher or Telegram fallback watcher independently from the supervised API core. The host has no external listeners by default; its default mode is idle. This does not reparent any previously running watcher, live tunnel or OAuth session. Both existing MCP tunnel servers remain completely outside its lifecycle.

Examples (choose free ports and run each intended process in a separate terminal):
- bun src/cli.tsx channel-host serve --port 7892 --mode idle
- bun src/cli.tsx channel-host status --port 7892
- bun src/cli.tsx channel-host serve --port 7892 --mode muse-ws --ws-port 9225
- bun src/cli.tsx channel-host serve --port 7893 --mode telegram-fallback

Before enabling Muse or Telegram modes, configure their token/IDs and make sure no other CLI/TUI watcher or poller already owns the same bot or socket. Muse-ws mode launches the existing local Muse WebSocket watcher without starting a Cloudflare tunnel. External WSS exposure is managed separately and is NOT established by channel-host. Telegram-fallback mode uses the existing Muse Telegram fallback adapter with stored Telegram credentials; it is not a generic Telegram gateway host. Neither mode attaches to an existing external transport process or upgrades an already running watcher.

Each host has a distinct loopback control port; Phase 4b initially exposed only GET /_channel/health. Phase 4c additionally introduces an explicitly authorized POST IPC endpoint (see below). Health still reveals no secrets, prompts, workspace paths or bot/group IDs. A random per-instance identity is stored in an owner-only discovery record. Status across processes checks identity/PID correspondence, so stale or unrelated PID records cannot be presented as active. /status all lists verified channel hosts in a separate section; mere host presence is never treated as proof of an authenticated Muse session or successful Telegram delivery.

Each non-idle mode uses an exclusive on-disk lease to prevent duplicate channel-host owners of Muse WS or the Telegram fallback even on different control ports. Stale registrations/leases fail closed. After a forced crash, verify that the original PID, listener and watcher are no longer running before any MANUAL state cleanup; the implementation never force-kills or adopts an unknown process. It also cannot prevent duplicate legacy watchers that were started outside this host: operators must stop/migrate those explicitly and separately.

The acceptance smoke launches its OWN channel host in idle mode at a random loopback port, crashes/restarts only the test-owned API supervisor, verifies the channel PID/listener remains active, then cleans all test-owned processes. No test connects to a real Muse endpoint, Telegram bot, Cloudflare tunnel or MCP OAuth service. A separate configured live end-to-end Muse/Telegram handover, agent task checkpoint migration, connection replay, and external service-manager auto-recovery remain future work.

Validation: bun run build; bun --bun x vitest run tests/channelHost.test.ts tests/remoteStatusService.test.ts tests/transportHost.test.ts tests/coreSupervisorCheckpoint.test.ts tests/coreDrainInspection.test.ts tests/coreGenerationPolicy.test.ts tests/coreSessionRouting.test.ts tests/coreSupervisor.test.ts; bun scripts/verify-core-supervisor.ts.

## Phase 4c: authenticated owner IPC, explicit Muse host controls

- The channel host now creates a separate random 256-bit IPC bearer capability, retained ONLY in the owner-only ~/.superagent-r/channel-host-PORT.json discovery record. The non-idle mode lease and unauthenticated GET /_channel/health never include this capability.
- Only loopback POST /_channel/ipc accepts mutations. Constant-time bearer verification runs before parsing an 8 KiB maximum JSON body; only steer, task and abort operations are supported, with a valid random request ID and a bounded text payload. No arbitrary command or workspace path is accepted.
- IPC is allowed only when an explicitly selected Muse WebSocket or Telegram fallback host has an active watcher. Idle and unavailable hosts reject. The client verifies the saved PID and random instance ID against live health before sending a message. No fallback to legacy in-process watcher is automatic.
- Each request ID is deduplicated across concurrent retries within the surviving channel-host process for up to 10 minutes (up to 256 entries). Requests with conflicting payloads under the same ID are rejected; a separate concurrent mutation also rejects rather than interleaving operations. Client retries must reuse the SAME request ID to benefit from this guarantee; the convenience slash command creates a new ID on each invocation.
- Explicit TUI commands: /muse host status, /muse host steer <message> --port 7892, /muse host task <message> --port 7892, /muse host abort [reason] --port 7892. These communicate with the channel owner process, not a separate local watcher. Traditional /muse watch and /muse steer keep their existing in-process behavior for compatibility.
- The acknowledgment indicates that the owner accepted/dispatched the operation; it is not a guarantee that remote Muse executed the task or that Telegram delivered it.
- Tests use a synthetic watcher/IPC executor with no external network connection, verifying bearer rejection, redaction, deduplication, command conflicts, inactive-host rejection and the actual /muse host route. The isolated crash-recovery acceptance already verifies that the dedicated channel-host process survives a supervised core outage.

Limits: no live external Muse/Telegram credential handover was attempted, no durable in-flight LLM execution checkpoint is written, and there is no automatic replay or failover if the CHANNEL HOST itself crashes. Dedupe exists only in the still-running channel-host process. Automatic service-manager recovery and full zero-downtime external transport remain future work.

## Phase 4d: conservative durable Muse batch checkpoints (opt-in)

The independent Muse WebSocket and Telegram-fallback channel hosts now create an owner-only on-disk batch journal at ~/.superagent-r/muse-batches-PORT.json. The integration is intentionally restricted to watchers started by the independent channel host. Legacy in-process watchers behave as before.

- Before executing even the first tool in a Muse task_batch, the watcher durably records batchId, taskId, number of tool calls, timestamps and the stage started. There is NO persisted tool call argument, model prompt, chat transcript, command output, bearer token, access grant or workspace path in the journal.
- After tool execution returns, the watcher records result_pending BEFORE trying to deliver the result. Only a successful local transport send acknowledgment advances the stage to delivered. Abort and some known errors mark uncertain. This is NOT an end-to-end Muse processing receipt.
- After process restart, any previously observed batch ID — started, result_pending, uncertain or even delivered — will NOT re-execute tools automatically. This conservative behavior prevents duplicate destructive side effects. Since outputs are intentionally not persisted, a lost result cannot yet be automatically reconstructed or resent. Review and reconcile the remote task before manually authorizing any replacement batch with a different ID.
- The channel health/status exposes only an aggregate reconciliationPending count, not task IDs, paths, or private content. Operator-only local CLI command: superagent channel-host checkpoint --port 7892. It works offline after a host crash and prints the pending batch/task IDs and stages for manual review. It never starts an external connector or retries work.
- The journal is atomic-replaced, validates version/owner port/schema/size, enforces bounded storage (1000 records, 750 KB), fails closed on damaged metadata and refuses silently reusing IDs. It is append-in-effect: delivered records remain tombstones. Storage maintenance / archiving and explicit audited reconciliation are not implemented; when limits are reached, execution fails closed. Files must remain private to the OS user; filesystem durability through power loss is not guaranteed without a separate fsync discipline.
- Tests cover round-trip reload, conflicting/corrupt checkpoint refusal, a pending batch after simulated process-memory loss, successful completion stages, and a real MuseWatcher instantiated again with the same journal to confirm that a redelivered batch does NOT execute tools twice. Isolated core/transport/channel crash-recovery smoke is unchanged and still must pass without affecting live MCP tunnels.

Boundaries: This is batch-level execution-safety metadata, NOT a full serialized agent/context checkpoint, transactionally exactly-once tool guarantee, uninterrupted streamed output, automatic tool rollback, or automatic continuation of an interrupted LLM. A crash DURING a side-effecting tool can leave uncertain external effects; operator reconciliation is required. Do not automatically create a fresh batch ID to bypass the tombstone. Existing Muse/Telegram production connections have not been live-migrated by these tests.

## Phase 4e: task recovery facts and offline evidence reconciliation

The opt-in independent Muse/Telegram channel host now records two additional metadata-only task signals in its existing per-port journal (backwards-compatible version 1): accepted means the watcher observed an inbound request or recorded an outbound dispatch intention, **not** that a remote brain accepted it; done_seen means the watcher received a task_done envelope, **not** that all external tool effects were confirmed. No task prompt, result summary, path, tool payload or chat transcript is checkpointed.

superagent channel-host checkpoint --port 7892 now displays a grouped task projection from durable facts: number of known batches, local delivery acknowledgments, evidence-reviewed batches and batches still requiring external review. Statuses are needs_review, reviewed_no_replay, delivery_recorded and metadata_only. This is a read-only inspection and works offline after a crash; **none** of these states is a serialized agent/LLM checkpoint or authorization to resume side-effecting tools.

When independent evidence of external tool effects has been checked, an **offline-only** operator action can append an immutable SHA-256 evidence reference to one existing unresolved batch:

    superagent channel-host reconcile --port 7892 --batch-id BATCH_ID --decision effect_verified --evidence-sha256 64_LOWERCASE_HEX --confirm BATCH_ID

Alternative decision no_effect_verified means the operator claims independent evidence that the effects did not happen. The runtime validates the digest's shape, not the underlying external evidence; it does not automatically authenticate the claim. The exact batch ID confirmation is required. The original execution stage is preserved, and review does **not** mark transport delivery, grant any tool execution, discard deduplication tombstones, or automatically retry the batch. A matching repeated review is idempotent; a conflicting review is refused.

Safety rules: the command rejects a registered live or stale channel owner. Both channel host and offline review use the **same exclusive per-port checkpoint lock** (muse-batches-PORT.json.review.lock); a hard crash intentionally leaves it in place. Never delete a stale registration or lock without independently verifying the old PID/listener/watcher is gone and that no other instance owns this journal. A damaged lock or checkpoint fails closed, not force-recovered. Only the controlling OS user should have access to journal files.

Test coverage: backwards compatibility with prior task-batch journals, monotonic task lifecycle state, reload after memory loss, immutable/idempotent review, bad evidence and corrupt-metadata rejection, real MuseWatcher observation with synthetic transport, offline CLI verification, exclusive-lock refusal during channel startup, and isolated supervisor crash/recover acceptance. No live Telegram/Muse bots or MCP OAuth tunnels are touched.

Remaining gap: full LLM context serialization, durable output outbox and remotely acknowledged result replay, transactionally exactly-once side effects, safe distributed task resume, automated recovery after a channel-host hard crash and live transport handover are **not implemented**. This phase provides a conservative task-reconciliation view, not automatic autonomous task continuation.

## Phase 4f: encrypted result outbox and explicit application-level receipts

An explicitly managed independent Muse/Telegram channel host now pairs its conservative batch journal with a bounded AES-256-GCM encrypted result outbox. The outbox index is stored at ~/.superagent-r/muse-results-PORT.json and a private 32-byte encryption key at the corresponding .json.key file. Plaintext tool results, model prompts, or credentials are NOT persisted to the previous checkpoint journal. The encrypted outbox does persist tool-result data; secure the host user's filesystem and protect both files. The storage is capped at 64 encrypted results and 96 KB serialized result bytes per item; exhaustion fails closed. File writes use exclusive temporary files, fsync and atomic rename where available. A missing/corrupt index or key fails closed; key rotation/secure archive lifecycle is not yet implemented.

Before sending each managed task_result, the host durably encrypts the complete result envelope, writes a stable SHA-256 digest into the outgoing task_result.result_sha256 field, and transitions the journal to result_pending. A successful local send changes the earlier journal stage to delivered; **this alone is not a remote delivery receipt**. To confirm application receipt, the authenticated Muse peer must return:

    {"v":1,"kind":"result_ack","id":"<batch ID>","task_id":"<task ID>","result_sha256":"<received 64-char lowercase sha256>"}

The host only accepts this from its existing authenticated transport, and verifies the saved batch ID, task ID and encrypted-outbox digest before appending a durable receipt to the journal. Telegram ingress must match the configured Muse bot; ordinary Telegram users cannot send result_ack. Legacy clients do not have to send result_ack to remain compatible, but will remain unacknowledged.

**No automatic replay:** a repeated task_batch never re-runs side-effecting tools and never automatically resends results. To deliberately resend the exact result ciphertext after reconnect, use /muse host replay-result BATCH_ID --port 7892, only while its channel owner and transport are active. IPC requires its existing private bearer credential; replay is rejected if an ACK, external evidence review, stored result or appropriate checkpoint stage is missing. The original result ID/digest are reused. This is AT-LEAST-ONCE result delivery, not exactly-once application processing; the remote receiver must deduplicate stable result IDs. If the full result cannot be encrypted within limits, no result is sent and the already-executed batch remains subject to manual reconciliation.

The owner status now reports encrypted result count, pending reconciliations, and application-level ACK count without output text. Offline checkpoint CLI shows ACK count. Tests cover encryption and tamper detection, oversized-result rejection, process-memory restart and exact result-only replay, spoofed and mismatched ACK rejection, remote receipt persistence, and the explicit authenticated /muse host IPC path. No external Muse or Telegram provider was contacted. Full LLM context resumption, remote execution control-plane handover, end-to-end production acknowledgment validation, automated retry schedules, and durable outbox retention/pruning remain outside scope.

## Phase 4g: encrypted execution intent and one-shot controlled resume

Managed independent Muse/Telegram channel hosts now persist a separate AES-256-GCM encrypted execution-intent checkpoint at ~/.superagent-r/muse-execution-PORT.json, with a private per-port .json.key file. The encrypted payload contains the original task_batch call arguments, declared dependencies, task/batch IDs, selected workspace, and per-call progress; all may be sensitive. Public status and offline checkpoint commands print ONLY counts, IDs and attempt progress—not the plaintext calls or full prompts. The sealed intent store has bounded size (64 batches, 512 KB decrypted), private file permissions, authenticated encryption, atomically replaced snapshots and filesystem sync for temporary-file contents. Corrupt/missing key or corrupted ciphertext fails closed, not reconstructed from an untrusted client.

Before invoking ANY tool—including read-only tools—the batch executor synchronously records a per-call STARTED boundary. It persists FINISHED progress after the call returns but never assumes that FINISHED alone proves external side effects were transactionally committed. A checkpoint write failure stops batch progression instead of silently continuing tool execution. Parallel calls have individual start records. Prior completion/error results remain handled by the Phase 4f encrypted result outbox when the whole batch completes; per-call outputs are not checkpointed.

The only supported controlled resume is an **explicit, one-shot resume of an untouched batch**. After verifying that the original channel host process is gone and the persisted owner registration/lock are safely reconciled, restart the independent channel host with the same checkpoint files and issue:

    /muse host resume-untouched BATCH_ID --port 7892

Requirements: the batch was already claimed in the durable Phase 4d journal; a sealed execution intent exists with matching task/batch ID and call count; its target workspace is still explicitly watched; original batch remains in started state; there is no stored result or external evidence review; the original transport is connected; no other batch is active; and **ZERO calls have ever reached the durable STARTED boundary**. The command uses the existing authenticated, loopback-only channel-host IPC and reserves the recovery attempt DURABLY BEFORE enqueuing. A retry or new host cannot bypass the one-shot reservation. Authenticated IPC acceptance only confirms it was queued, not that tools succeeded or Muse received the result. The same tool permissions apply when the sealed call manifest runs.

If ANY tool had already started, even if it finished, failed, or was read-only, resume is refused. Also refused: missing/corrupt ciphertext, changed workspace, a queued/running batch, previous recovery reservation, existing output or evidence review. These cases require the external-effect reconciliation workflow; the runtime never automatically skips or reruns individual calls. Repeated inbound task_batch envelopes remain refused. No provider login, MCP OAuth tunnel, T-Line listener or existing session is taken over during tests.

This implements encrypted command-intent preservation, durable per-call attempt metadata and a narrowly scoped safe one-shot **pre-execution** recovery—not full LLM memory serialization, continuation midway through multi-tool work, live channel-host auto-restoration, uninterrupted streams, exactly-once side effects, or automatic replay of tool outputs. Manual workspace and effect verification still matter. Tested using a simulated process-memory restart, tampered ciphertext, interrupted tool checkpoint, invalid workspace and fail-closed checkpoint write; the isolated core crash/recover smoke remains required.

## Phase 4h: unified recovery policy and safe reconciliation gates

The opt-in independent channel host now uses MuseRecoveryOrchestrator to classify every known batch ID from three private, owner-port-scoped stores: the Phase 4d/4e journal, Phase 4f encrypted result outbox, and Phase 4g encrypted tool execution checkpoint. It is a read-only **decision engine**, not a background recovery daemon and not a serialized LLM state. It checks agreement of task identity and call count, stage versus result presence, receipt hash versus saved result digest, integrity of encrypted stores, and whether any tool has started. Orphaned execution/output artifacts or contradictory states are classified integrity_blocked rather than guessed or replayed.

To inspect after a crash, without starting a watcher or modifying state, use:

    superagent channel-host recovery --port 7892 [--batch-id BATCH_ID]

This offline command does not read active workspace authorization, so untouched batches are classified workspace_unverified, never unconditionally safe. An active host computes workspace-authorized counts from its configured watch list. Decisions are acknowledged, externally_reviewed, manual_result_replay, manual_untouched_resume, workspace_unverified, reservation_spent, manual_reconciliation and integrity_blocked. The CLI exposes only batch/task IDs, counts and reason codes; it does NOT print ciphertext, source tool arguments, command text, workspace paths, secrets, or full LLM prompts. The health endpoint reports aggregate integrity-blocked and manual-reconciliation counts. A corrupt/missing encryption key fails closed on load.

Both existing guarded operator actions now consult this same policy: /muse host replay-result requires manual_result_replay and /muse host resume-untouched requires manual_untouched_resume **plus** their existing authenticated IPC, transport connection, idle checks, original workspace constraints and one-shot durable reservation. Offline --decision evidence reconciliation is restricted to manual_reconciliation or an idempotently externally_reviewed batch. None of these checks bypasses the Phase 4d replay tombstone or permits an uncertain, partially executed tool to run again. A result that was already ACKed cannot be replayed. Phase 4h also wires the encrypted execution checkpoint into the independent Telegram fallback owner (previously missing), and uses exact watcher-registry ownership introduced in Phase 4g.

Acceptance tests: classifier matrix for fresh/partially attempted/reserved/reviewed/ACKed batches, missing outbox, mismatch/orphan/invalid receipt, offline CLI with no plaintext disclosure or write, Phase 4d-4g regression, isolated WebSocket/Telegram tests, build, and owned-process core crash/recovery. No live OAuth/MCP tunnels or remote Muse/Telegram sessions are contacted. Provider-confirmed receipts, automatic external repair, distributed transaction atomicity, active LLM context serialization and zero-downtime provider socket handover remain unimplemented.

## Phase 4i: safe recovery-storage lifecycle (ACK-only offline payload pruning)

Phase 4i adds an **explicit offline storage lifecycle**, without automatic deletion or weakening Phase 4d deduplication. The private journal retains its complete batch ID, task identity, stage, evidence review, ACK digest, timestamps and permanent replay-blocking tombstone. The journal now fsyncs temporary snapshot content before atomic rename when the filesystem supports it. No journal tombstones or task signals are ever pruned; the earlier 1,000-record/750 KB journal limit remains a deliberate fail-closed limit until separately engineered immutable tombstone archival.

Encrypted result outbox and encrypted execution-intent payloads can be removed ONLY after a valid application-level Muse result_ack has been durably recorded, its SHA-256 matches the stored result, and a minimum receipt-retention period has elapsed. **Default: 7 days from ACK**. Never prune an unacknowledged, inconsistent, externally reviewed, or still-uncertain batch. Use these two CLI commands:

    superagent channel-host retention --port 7892 [--batch-id BATCH_ID] [--min-age-days 7]
    superagent channel-host prune --port 7892 --batch-id BATCH_ID --confirm BATCH_ID [--min-age-days 7]

The retention command is a read-only dry run and prints only identifiers and metadata, never encrypted tool arguments or raw results. Prune requires exact repeated batch-ID confirmation, a valid receipt, age eligibility, no registered owner (even if stale), and the same exclusive .review.lock as live channel-host/reconciliation. The operator can explicitly override the default retention with --min-age-days 0; this bypasses the age wait, not the ACK/identity/owner checks. It must be used deliberately, not scheduled as an automatic background task.

**Crash ordering:** Phase 4i first persists payloadReleasedAt to the existing journal record, bound to its immutable result ACK digest. Only after that write succeeds may it remove the encrypted result, followed by the encrypted execution intent. A crash between any two steps leaves cleanup_incomplete; rerunning the same confirmed prune safely completes the remaining deletions. Phase 4h recovery now accepts a missing result payload only if that journal cleanup marker and prior result ACK exist. Every other missing result/digest mismatch still fails closed. Old process memories, filesystem backups, swap data and encryption keys are not securely erased; pruning limits current checkpoint payload retention, not all historical copies.

Storage remains bounded (outbox: 64 records; encrypted execution intents: 64 batches); pruning acknowledged records frees those two payload capacities for the next authorized channel-host startup (pruning requires the current host to be offline). The key files remain available for encrypted-store validation; a missing store plus orphaned key still fails closed. ACK is proof of result receipt only, NOT independent confirmation of external side effects or serialized LLM restoration. Journals remain bounded and can eventually refuse new batch IDs; safe long-term tombstone compaction/archive and unattended cleanup are separate future work.

Verification includes ACK age rules, explicit zero-day override, refusal of mismatched ACKs/unacknowledged work, fail-closed live/stale owner and shared-lock exclusion, no-plaintext dry runs, reload after cleanup, and simulated crashes after the journal tombstone and after the outbox deletion. Existing WebSocket, Telegram, core-supervisor, T-Line isolation and crash/restart suites must also pass. No running MCP tunnel, Muse/Telegram production bot or external service is restarted during validation.

## Phase 4j: authenticated, segmented tombstone archive and offline journal compaction

Phase 4j adds an application-immutable archive for finalized batch replay tombstones. A batch may leave the active journal only when its local stage is delivered, a valid application-level Muse result ACK was previously persisted, an ACK-bound Phase 4i payloadReleasedAt marker exists, and BOTH encrypted payload stores have already released their entries. Active/uncertain/unacknowledged/reviewed records are NOT archivable. No AI/tool operation is replayed or automatically resumed. The journal retains all original task recovery signals; archived terminal records are excluded from active recovery counts, but are available by exact batch ID for deduplication and inspection.

Two operator commands are available:

    superagent channel-host archive --port 7892 [--max-batches 64]  # read-only preview
    superagent channel-host compact --port 7892 --confirm-port 7892 [--max-batches 64]

Compaction is OFFLINE only and refuses a registered owner (including stale state); it must acquire the same per-port exclusive journal review lock used by channel host, offline prune and reconcile. The CLI checks the actual per-port outbox and execution checkpoint again UNDER that lock. It writes a new private, randomized, no-overwrite archive segment with a SHA-256 content digest and HMAC-SHA256 using a private per-port 32-byte key. Only AFTER fsync/rename of this segment succeeds does it atomically rewrite the journal with an authenticated-segment descriptor and remove those IDs from its active list. A process crash before the journal commit leaves all selected records in the active journal and any unreferenced archive file is never considered authorization to drop an ID. A crash after the journal commit leaves an archive reference which is validated before accepting new tasks. If an archive file or key is missing or modified, or a duplicate/overlap exists across active and archived IDs, loading the journal fails closed.

At startup the journal reads and validates all manifest-referenced archive segments. Every later claim checks BOTH active and archived IDs; archived IDs stay blocked across process restarts, rather than being treated as unknown new batches. Existing transition/reconciliation operations cannot mutate archived terminal records. Recovery on an explicit archived batch ID can classify its ACK-bound cleanup tombstone; aggregate active statistics remain bounded. Health and offline checkpoint report the separate number of archived tombstones.

Capacity limits: active journal remains 1,000 records (plus retained task signals) and 750 KB. Archive segments contain at most 64 tombstones; up to 256 referenced segments are accepted per owner (16,384 archived records). Thus compaction is bounded, not infinite, and stops when its archive manifest/disk quota is full. The HMAC protects against accidental modification or alteration by processes without the private key, but these files are NOT filesystem-level write-once media; anyone with unrestricted local filesystem AND key access can alter/delete both journal and archive. Back up the active journal, private archive key and referenced segments together. Unreferenced segment files left by a hard crash are not automatically deleted. A fully malicious local administrator, destructive restore of old snapshots, loss of the full storage tree, and cross-machine exactly-once effects remain outside this guarantee.

Verification includes 1,000-entry active journal exhaustion and recovery, restart duplicate blocking, tampered/missing segment and key rejection, wrong-owner/missing ACK/payload-not-yet-pruned refusal, simulated crash in the segment-then-journal commit gap, and offline CLI stale owner/lock enforcement. All tests use isolated temporary files, not production tunnels or live channel sessions.

## Phase 4k: verified recovery storage inspection, backups and guarded empty-target restore

Phase 4k introduces full-file recovery integrity inspection and an offline, per-port backup/restore workflow. The authoritative state is the ENTIRE set of Muse batch journal metadata, every journal-referenced authenticated tombstone archive segment and its private HMAC key, encrypted result outbox and private key, and encrypted execution intent and private key. A journal-only or archive-only copy is insufficient for correct deduplication. The command suite is:

    superagent channel-host verify-store --port 7892
    superagent channel-host backup --port 7892 --destination ABSOLUTE_NEW_DIRECTORY
    superagent channel-host verify-backup --port 7892 --source ABSOLUTE_BUNDLE_DIRECTORY
    superagent channel-host restore-backup --port 7892 --source ABSOLUTE_BUNDLE_DIRECTORY --confirm-port 7892

The verify-store and verify-backup commands are read-only. The first checks journal and all authenticated archive segments, decrypts each result with its original private per-port AES key, checks execution checkpoint GCM authentication, evaluates cross-store consistency, and reports redacted counts (never result text, tool arguments or key contents). Running it on a live host is an inspection only; repeat offline if concurrent updates cause inconsistent observations. verify-backup checks each file's size and SHA-256 against the bundle manifest, requires every expected source file, then loads and checks the FULL bundle using existing journal/outbox/checkpoint logic, including the archive signature chain. Hashes protect against accidental corruption, but a malicious party who can change the manifest and contents together can forge a consistent-looking package. Do not treat this as remote attestation or anti-rollback assurance.

Backup and restore require the SAME per-port offline exclusive review lock used for journal reconciliation, pruning and compaction; they refuse ANY registered channel host, even stale metadata. Backup writes a private staged directory on the destination volume, copies only recognized per-port files into it without overwriting, fsyncs each copy, validates the entire staged bundle, then atomically renames the directory into the caller's NEW absolute destination. Backup targets cannot be under (or contain) the live recovery directory. A crash before the rename can leave a staging directory with **private secrets**; secure cleanup remains the operator's responsibility.

Restore checks and validates the entire bundle BEFORE writing to disk. It requires an exact matching owner port, an outside absolute source path, explicit --confirm-port, the exclusive offline owner lock, and a target with NO prior journal, result, execution, archive, or archive key artifacts; it NEVER overwrites an existing history, so an older backup cannot silently roll back a newer active owner. Before any file is copied, an exclusive per-port 'muse-restore-PORT.incomplete' guard is written and fsynced. The Muse journal loader refuses ALL claims while that marker exists, even if the journal is missing. Private keys, ciphertext and tombstone segments are copied before the journal; SHA-256 checks are repeated after copying. Only after every file was copied and verified is the guard removed and normal journal/archive/outbox validation repeated. If a crash or I/O error interrupts any step, the guard and any partial files remain as evidence for human investigation; never delete this guard until a trustworthy recovery has been assessed. This is a **restore into genuinely empty storage on the SAME owner port**, not a merge, in-place overwrite, cross-port migration, automatic failover or a restore of the LLM model's active reasoning state.

IMPORTANT: This bundle includes private AES and HMAC keys, so protect access and store it encrypted in an independent trusted backup vault. Restore safety assumes the recovered bundle represents a sufficiently recent, trusted backup; a malicious administrator who destroys the current state and restores an old snapshot can evade the local deduplication history. Use independent off-machine version/age protection to prevent this. Neither filesystem permissions nor checksum-only manifests make recovery backups tamper-proof or rollback-proof. No running MCP tunnels, remote Muse provider or Telegram bot is contacted in the isolated validation.

Tests cover full source-to-bundle-to-new-owner namespace round trip preserving all replay tombstones and keys, digest tampering, absent archive or signing key, port mismatch, backup symlink/path fencing, registered owner and lock refusal, incomplete-restoration startup fence, simulated mid-copy crash, failed overwrite/rollback into occupied storage, and authenticated CLI end-to-end operations.

## Phase 4o local-only staging acceptance

The `bun scripts/verify-muse-local-staging.ts` harness runs a real independent channel-host process in idle mode on a random loopback port with a fresh HOME/USERPROFILE and SUPERAGENT_CONFIG_DIR under `~/.superagent-local-staging/<run>`. It creates a metadata-only journal without executing tools, explicitly disables provider alerts, authenticates host PID and instance identity, rejects unauthenticated IPC, verifies watchdog online/offline/online transitions and alert deduplication, rejects backup during an active owner, gracefully stops and restarts host, then creates and verifies an offline backup and restores it into a separate empty staging home. It retains a local report and private staging artifacts. No external notification delivery or production channel takeover occurs. The local 22-check gate PASS does not make production readiness PASS; see [local-only staging guide](../guides/muse-local-staging.md). A cross-platform CI job invokes this same script after building.

## Phase 4o: isolated disaster recovery, alert delivery proof and production release gate

The independent channel-host can now run an opt-in isolated unclean child-process crash drill with durable checkpointing, anti-replay, encrypted intent preservation, backup validation, tamper rejection and safe restore. All test state is stored in an OS temporary directory and never contacts a Muse watcher, Telegram, MCP tunnel, model, or production workspace. Successful tests record only sanitized local per-port drill evidence; this is not a cryptographic external audit.

Read-only readiness reports PASS/WARN/FAIL and a heuristic 0-100 score across host identity, recovery storage, incident queue, provider configuration, approved alert delivery proof, watchdog heartbeat, drill evidence and optionally supplied verified backup age/integrity. Strict readiness fails on any WARN/FAIL, and the operator wizard prints safe steps without repairing a journal. Real HTTP alert tests require explicit --confirm-send and a trusted configured target, and do not prove human receipt. A standalone watchdog-supervise parent may restart only its own watchdog child up to five times per ten minutes; supervising that parent across OS reboot remains an operator responsibility.

    superagent channel-host dr-drill --port 7892
    superagent channel-host readiness --port 7892 --backup ABSOLUTE_BUNDLE [--json] [--strict]
    superagent channel-host recovery-wizard --port 7892 [--backup ABSOLUTE_BUNDLE]
    superagent channel-host alert-test --port 7892 --confirm-send
    superagent channel-host watchdog-supervise --port 7892 --interval-seconds 30

Cross-platform GitHub workflow: .github/workflows/muse-disaster-recovery.yml (Linux/Windows build, tests, isolated drill, supervisor smoke). Live production failover and external delivery are not claimed without staging/real provider verification. See the [Phase 4o operator runbook](../guides/muse-disaster-recovery-readiness.md).

## Phase 4n follow-up: configure alert provider through commands (no .env required)

For operator-oriented setup and troubleshooting, see the [dedicated Muse recovery alert configuration guide](../guides/muse-recovery-alert-configuration.md).

Configure alert delivery per owner port using the same CLI/T-Line command domain as the independent channel host. The config is stored encrypted (AES-256-GCM), using a separate private local encryption-key file under ~/.superagent-r; both files have restrictive local permissions where supported. The CLI and T-Line status deliberately show only mode, port and whether credentials are configured, never the URL, Telegram chat ID or bot token. The per-port config and local key are included in the verified Phase 4k recovery backup. Protect that backup like all other Muse encryption keys: the local key is NOT an OS hardware-backed secret or protection from a privileged filesystem reader.

    superagent channel-host config status --port 7892
    superagent channel-host config set-webhook https://your-trusted-receiver.example/alerts --port 7892
    superagent channel-host config set-telegram --chat-id -123456789 --token-stdin --port 7892
    superagent channel-host config disable --port 7892

Send the Telegram bot token only through piped stdin (for example, from your trusted OS secret manager or a temporary input pipe), not as an argument, shell command-history literal or chat message. For a no-secret webhook, the interactive commands are /muse host config status --port 7892, /muse host config set-webhook HTTPS_URL --port 7892, and /muse host config disable --port 7892. The T-Line slash command refuses a raw Telegram token to avoid persisting it in conversations and logs.

The dispatcher re-reads config on each send attempt; changes to provider or disable are effective immediately without restarting the channel-host or external watchdog. An explicit disabled config always overrides previously set environment variables, and missing saved config alone allows the Phase 4n environment fallback for backward compatibility. If the encrypted config fails authentication or its key is missing, delivery is *blocked* with the queue intact; there is no unsafe fallback to the old environment. Configured Telegram tokens and URLs never appear in the incident payload, logs or status. The key file and ciphertext are kept separate from incident history so alert delivery cannot gain tool-execution privileges.

## Phase 4n: opt-in remote alerting, durable incident outbox, external watchdog and incident dashboard

The independent channel-host recovery owner now has a *separate* bounded operational incident center. On startup it reconciles the Phase 4m sanitized integrity transition ledger into the per-port file 'muse-incidents-PORT.json', tracking every integrity event by monotonic sequence so a restart does not duplicate alert creation. Incident types are 'integrity' and 'host_unavailable'. The workflow is OPEN -> ACKNOWLEDGED (explicit operator confirmation) -> RESOLVED (only after verified healthy/online observation). ACK does NOT remove a recovery gate, restart a failed owner, or prove that a tool's side effect was reversed. Recovery transitions also produce notifications. The incident file and integrity ledger are included in complete Phase 4k backup/restore and verified before safe recovery; replay protection and incident delivery state therefore survive the same-port restore.

**P0 — Delivery:** Alerts are disabled by default. The legacy environment fallback (used only when no saved config exists) supports one of:

    SUPERAGENT_MUSE_ALERT_WEBHOOK_URL=https://your-alert-receiver.example/hooks/superagent

or BOTH of the following, without a webhook configured:

    SUPERAGENT_MUSE_ALERT_TELEGRAM_BOT_TOKEN=<bot-token>
    SUPERAGENT_MUSE_ALERT_TELEGRAM_CHAT_ID=<numeric-chat-id>

For legacy deployment compatibility, set them only in the environment of the independently running channel host and, if needed, its separate watchdog process. The config-command-based method above is the preferred user workflow. No token, URL, workspace path, task ID, prompt, agent output or encrypted result is persisted in an incident or delivery file. Webhook validation requires HTTPS with a DNS hostname rather than a literal IP, no URL credentials, custom port or redirects; hostname DNS resolution is not pinned to a verified public IP, so configure only a trusted destination; Telegram targets the official HTTPS Bot API. Outgoing messages contain ONLY a generated event ID, owner port, fixed incident kind/condition and observation timestamp. The webhook 'Idempotency-Key' header lets cooperating receivers suppress re-delivery, while Telegram has no exactly-once guarantee. Avoid granting the bot administrative controls. Network traffic is never attempted during the tests and only starts after valid opt-in configuration.

Durable delivery uses a per-port file and an exclusive create lock for mutations. Messages are queued before any network request, claimed via a 30-second lease, then marked sent on HTTP success or retried after bounded exponential backoff (2 seconds to 30 minutes plus deterministic jitter). On a crash after remote acceptance but before local ACK, the lease expires and the same event may be sent again: **at-least-once**, not exactly-once. The store holds at most 250 incidents and 512 notifications and refuses silent truncation when full. Corruption or a stale lock does not trigger deletion or automatic remote operations; review the local incident file and process ownership. The dispatcher stops with the channel host. Offline retry can be attempted explicitly with 'deliver-alerts' when its environment includes the selected delivery target.

**P1 — Incidents and external health watchdog:** The watchdog must run in a SEPARATE process so it can detect a completely stopped/hung channel host. It verifies the discovered owner PID and instance ID against its loopback health endpoint; missing/mismatched/error/unresponsive owners are offline. It does not take over the channel socket, leases, watchers or MCP tunnels. Run it under your own process/service supervisor for continuity:

    superagent channel-host watchdog --port 7892 --interval-seconds 30
    superagent channel-host watchdog-once --port 7892
    superagent channel-host acknowledge --port 7892 --incident INCIDENT_ID --confirm INCIDENT_ID

It writes one incident per offline episode and resolves only after a verified online observation; it does not spam duplicate alarms on each poll. Running 'watchdog-once' is an explicit state-changing observation, not a read-only check. If the separate process itself crashes, there is no remote monitor or OS auto-restart unless configured independently. A manual 'acknowledge' changes only incident status, not checkpoint state.

**P2 — Incident dashboard and operator views:**

    superagent channel-host incidents --port 7892 [--limit 20]
    superagent channel-host alerts --port 7892 [--limit 20]
    superagent channel-host deliver-alerts --port 7892
    superagent channel-host status --port 7892

The running owner also exposes only on loopback 'http://127.0.0.1:7892/_channel/incidents/dashboard' (read-only HTML, auto-refresh 15 seconds, no active client scripts) and '/_channel/incidents' (read-only redacted JSON). Both contain incident IDs and fixed status enums but NEVER raw errors, external alert credentials, tool inputs or filesystem paths. The HTML includes a restrictive Content Security Policy. No remote dashboard, public endpoint or API for mutating incidents is created. Operator ACK is available only through the guarded CLI.

Limitations: this is local per-port incident management, not a distributed queue, enterprise secret manager or verified on-call delivery service. A privileged local filesystem attacker can rewrite the incident JSON; receipt and delivery status are not cryptographic proof of remote receipt. Webhook hostname validation does not make an arbitrary administrator-supplied endpoint intrinsically trusted; configure only your own alert receiver. The 250/512 record limit requires operator-led archival and a future safe retention phase. Recovery checks remain authoritative independently of notification delivery (alert network failures must never cause duplicate tool execution). Tests exercise deduplication across restarts, explicit ACK, offline/online host transitions, outbound opt-in, payload redaction, retry/lease expiration, authenticated same-port backup/restore, browser/JSON read-only dashboard and absent external provider interactions.

## Phase 4m: enforced integrity gates, durable local alert history and safe recovery

Phase 4m connects the Phase 4l disk integrity monitor to actual side-effect boundaries for the independent managed channel hosts. Before accepting a new Muse tool batch for execution, reserving an untouched batch for explicit resumption or replaying a previously encrypted result, the watcher invokes an optional synchronous integrityGuard injected ONLY by the independently managed owner. The channel-host authenticated IPC also performs a fresh on-disk scan immediately before accepting replay_result/resume_untouched, even for injected executor paths. A stale cached healthy response is NEVER authority to replay. The initial first new batch is allowed to create its journal only when the per-port storage is completely empty, state is not_initialized, and no prior integrity event exists; existing/orphaned journal, archive, key, restore marker or alert file forces a fresh verification or denial. Failed, degraded, stale, uninitialized (for replay/resume) and unreadable integrity assessments deny the operation without running tools or mutating recovery reservations. The abort/stop control remains operable during recovery failures. Direct watchers not using the managed owner retain their previous behavior unless an integrityGuard is explicitly supplied.

A durable per-port sanitized health-transition ledger at muse-integrity-PORT.jsonl records only sequence, timestamp, state (degraded/failed/healthy), code (STORAGE_CHECK_FAILED/VALIDATED), previous digest and current SHA-256 digest, with fsync per transition. No raw exceptions, workspace paths, prompts, tool arguments, batch IDs, ciphertext or credentials are logged. The reader checks the entire hash chain; truncated, malformed, symlinked or over-limit journals fail closed. Both first warning and subsequent failure are recorded, and confirmed failed severity persists across restarts until an actual successful scan appends a recovery event. The history is capped at 2,048 events / 500 KB without automatic loss-inducing truncation. A full/unwriteable/corrupt ledger makes recovery execution fail closed (ALERT_LEDGER_INVALID) until manually investigated. This is a local crash-durable operational history with SHA-256 consistency checks, NOT a trusted remote append-only log, HMAC authenticated WORM device, external alert delivery, or rollback protection against full filesystem compromise.

Operator commands:

    superagent channel-host integrity --port 7892
    superagent channel-host alerts --port 7892 [--limit 20]
    superagent channel-host status --port 7892

The host prints a generic event notice on validated health transitions and exposes the durable transition count in loopback health/status. CLI alerts returns the most recent sanitized records, offline/read-only, and never starts channels. Phase 4k backups now include the optional per-port integrity event history and validate it before creating/restoring the complete encrypted recovery bundle; restores continue to refuse occupied port histories. These notifications are local status/events only: no Telegram/webhook/email delivery, scheduled external monitoring while the host is stopped, or automatic repair is introduced.

Safety scope: protection applies at the start of each guarded operation, not atomic cancellation of tools already running at the instant corruption appears or protection against an administrator who destroys and replaces every state, key, backup and log. Run offline verify-store and reconcile independently verified effects after incidents; never automatically clear a broken ledger or replay an uncertain tool. Tests exercise disk corruption after cached healthy state, direct watcher and host IPC denial, an allowed abort, sanitized redacted events and CLI, chain corruption/symlink/partial writes, severity across restarts, successful recovery notifications, and backup/restore preserving event history.

## Phase 4l: continuous read-only recovery integrity health & observability

Independent Muse/Telegram channel hosts now run MuseRecoveryIntegrityMonitor at startup and every 60 seconds for the lifetime of their server. The monitor reopens the on-disk, owner-port-specific journal, verifies every referenced SHA-256/HMAC tombstone segment, authenticates/decrypts sealed outbox and execution checkpoint files, and checks cross-store identity and receipt consistency through the Phase 4k inspector. It never contacts Muse, Telegram or a model, never retries tools or mutates checkpoint storage, and never starts/stops a watcher based on inspection results. The timer is unreferenced and canceled on host close; if the process is down, no background monitoring exists.

The loopback GET /_channel/health includes a cached recoveryIntegrity object with redacted fields: state, reason, lastCheckAt, lastHealthyAt, nextCheckAt, totalChecks, totalFailures, consecutiveFailures and previous successful active/archive/outbox/intent counts. All raw exceptions and private paths are discarded. A new, empty per-port storage without any checkpoint artifacts is not_initialized (not an integrity failure). A fully verified scan is healthy. The first consecutive failed scan is degraded; second and later failed scans are failed. A successful scan resets consecutiveFailures. If the last check is older than 3 configured intervals, the snapshot is stale with CHECK_OVERDUE, not an outdated healthy claim. No check writes an external alert or logs secrets. Transient concurrent writes in a live host can produce degraded status: repeat the full inspection while offline for definitive diagnosis.

Operator views:

    superagent channel-host status --port 7892
    superagent channel-host integrity --port 7892
    superagent channel-host verify-store --port 7892

status displays the last cached verification with its age and failure count. integrity is read-only and uses the authenticated live-owner health endpoint (without triggering a new scan), or performs a full offline inspection if no owner is registered. verify-store remains the explicit synchronous integrity check and refuses invalid stores. A failed/degraded report is an *alert for human inspection*, not a promise that arbitrary already-running remote tool operations are atomically halted. Direct agent/tool processing, distributed durable alarms, off-host alert delivery, automatic failover and scheduled backup creation are not added in this phase.

Tests cover pristine storage, valid journals, tampered archived content, detection after startup, missing journal with orphaned encrypted key, transitions from degraded to failed to healthy, stale monitoring timestamps, timer start/stop, health redaction and read-only CLI inspection. No existing two MCP tunnels, external Muse watcher or real Telegram bot is modified or restarted.

## Future phase: independent transport host

Move persistent MCP OAuth/session transport, Muse/T-Line sockets and gateway into a dedicated host; build durable agent checkpoints and session ownership with verified reconnect, PID fingerprints, idle draining and rollback tests. Full zero-downtime runtime restart is not guaranteed yet.
