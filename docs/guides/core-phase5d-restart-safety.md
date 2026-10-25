# Phase 5d — Core cold-boot audit and T-Line reconnect contract

**Status:** implemented and locally tested in isolated SuperAgent API Core/transport processes. This phase is deliberately fail-closed, not a promise of full OS-reboot Agent state restoration.

## 1. Read-only cold-boot audit

Run from SuperAgent CLI after building the project:

    superagent core boot-audit --port 7888

The command makes no filesystem writes, does not stop/restart any process, does not invoke tools/models and does not alter MCP, Muse or Telegram. It inspects only this user's configured root:

- Authenticated Core status and whether another TCP process occupies the requested loopback port.
- Existing Core checkpoint and its schema integrity, plus any discovery and guardian lease metadata.
- Count of persisted owner-scoped session receipts (bounded and rejecting symlinks/unexpected entries).
- SQLite history.db's chat_turns table using a separate **read-only connection**. Any accepted, running, queued, recoverable or interrupted turn is considered ambiguous. Database corruption or unreadable data means UNKNOWN, never zero.

The JSON result is sanitized: no bearer/token, prompt, tool payload, arbitrary workspace files or secret state are printed. It includes decision, reason codes, and hard guarantees automaticToolReplay=false and mayDeleteCheckpoint=false.

Decisions:
- already_running: authenticated Core is online. Do not create another owner.
- recover_verified_survivors: only authenticated worker recovery is a candidate; the existing core recover path must verify worker PID, nonce and private token.
- fresh_guard_allowed: only an empty verified owner namespace (no checkpoint/lease/discovery, no ambiguous work, no orphan receipt, no port listener) qualifies. This is the only situation where existing core boot could start a fresh guarded Core without operator handling.
- operator_review: worker identity is unknown/dead, a stale guardian lease, unresolved chat, prior session receipts, or unverified external effects. Existing core boot remains fail-closed.
- blocked: foreign listener, corrupt checkpoint, or unreadable/inconsistent evidence.

**A valid checkpoint with dead/unknown workers is NOT authorization to delete it.** Core boot still refuses to silently replace that state. The operator must inspect and reconcile old worker identities and external tool effects; there is no force-clean flag.

## 2. T-Line transport contract

When the separate T-Line front door cannot verify Core ownership, API requests receive HTTP 503:

    code: CORE_SUPERVISOR_UNAVAILABLE
    retryAfterMs: 1000
    safeReconnectMethod: GET
    automaticChatReplayAllowed: false

The response also sets Retry-After: 1 and Cache-Control: no-store. The transport's existing GET /_transport/health stays available while Core is down; no user session ID, prompt or bearer is leaked.

When an API session's original worker is dead, the Core supervisor returns HTTP 503 with:

    code: SESSION_WORKER_DEAD
    requiresExplicitResume: true
    automaticChatReplayAllowed: false

If ownership mapping is gone, the analogous code is SESSION_OWNER_UNAVAILABLE. These are distinct from a temporary backend outage. They are machine-readable for T-Line/other clients.

The reusable bounded reconnect state machine is in src/core/runtime/tlineReconnectPolicy.ts. It preserves the session ID, applies jittered exponential backoff with max 8 retries, and **only permits GET /_transport/health and GET /api/status** for automatic retries. A 401/403 requires reauthentication; a session-dead 503 requires explicit user-approved resume; a 409 requires history review. It never automatically replays POST /api/chat, POST /api/init, a tool call, or a pending approval. The explicit resume payload constructor enforces current user approval and freshness/ambiguity checks; the backend Phase 5c independently revalidates real SQLite history and receipts.

**Not yet wired into a separate installed T-Line desktop GUI:** this repository contains the Core/transport contract and reusable logic, not the full native T-Line UI runtime. Do not claim background reconnect from a packaged desktop without desktop integration and a real user-facing E2E test.

## 3. Validations

Run in the SuperAgent workspace:

    bun run build
    bun --bun x vitest run --maxWorkers=2 tests/corePhase5d.test.ts tests/coreBoot.test.ts tests/transportHost.test.ts
    bun scripts/verify-core-guardian.ts
    bun scripts/verify-core-session-resume.ts
    bun scripts/verify-core-supervisor.ts

The staging tests isolate HOME/USERPROFILE/SUPERAGENT_CONFIG_DIR, select loopback ports not used by production and kill **only exact test-owned PIDs**. The Guardian drill covers a hard supervisor crash, reattach with surviving worker, then all worker death; it checks that boot-audit refuses automatic replay and does not modify the checkpoint. The session drill checks dead-session 503 codes and safe explicit resume. No external alert is sent and no actual LLM/tool is invoked.

CI workflow: .github/workflows/core-guardian.yml, Linux/Windows matrix; remote CI run and deployment are NOT asserted.

## Pending work

1. Actual T-Line native desktop UI wiring: health probe + session GET, reconnect banners, explicit user action, SSE/WS resubscription and model-free replay-gap UI.
2. Deliberate operator cold-start reconciliation/archival workflow with transaction-safe backups and verified out-of-process ownership, while preserving external tool side effects and histories. **Never automatically erase a stale checkpoint simply because PID seems absent.**
3. Offline checkpoint/side-effect reconciliation per agent and subagent, plus watchdog/service installation after explicit operator review. Full in-flight LLM state migration and completely unbroken TCP streams remain impossible via this phase alone.

See [Phase 5c](core-agent-session-recovery.md) and [Core Guardian startup](core-guardian-recovery.md).
