# Phase 5e — Verified offline recovery evidence and read-only T-Line reconnect checks

**Implementation status:** integrated into SuperAgent Core CLI and isolated Windows staging. Neither command restarts any running production process, resets session checkpoints, retries chat/tool calls, or transmits data to external providers.

## 1. Private offline recovery snapshot

Start with the nondestructive audit:

~~~powershell
superagent core boot-audit --port 7888
~~~

After verifying that the relevant Core **really is offline**, take a local forensic backup:

~~~powershell
superagent core evidence-snapshot --port 7888
~~~

The snapshot command **refuses** to proceed when an authenticated Core is still online, an unknown listener occupies the requested Core port, or chat-turn/receipt evidence cannot be inspected.

It creates a unique private directory under the current SuperAgent configuration root:

~~~text
~/.superagent-r/recovery-evidence/core-PORT-TIMESTAMP-NONCE-*/
~~~

This includes unchanged copies, when present, of the Core supervisor checkpoint, discovery information, guardian registration and receipt metadata, a consistent SQLite history snapshot created with VACUUM INTO using a read-only source database connection, and a JSON manifest with SHA-256 digests. The SQLite copy is checked with PRAGMA integrity_check; checkpoint source digests are checked again after copying. An incomplete copy is removed, and no manifest is published as complete.

**Security:** this directory contains bearer tokens, local access capabilities, workspace metadata, conversation data and potentially sensitive chat content. Never paste its contents into chat, publish it, commit it to Git, sync it to a public cloud or email it as an attachment. The CLI prints only the snapshot manifest and its local path, never the credentials or conversation content. Protect these files with OS account permissions and an appropriate local retention policy.

The snapshot is evidence and backup, **not permission to cold-start a replacement Core**. If a worker is dead or external side effects remain uncertain, the audit continues to block automatic restoration. Neither snapshot nor audit deletes, renames or resets originals. The commands are independent of MCP, Telegram, Muse and Cloudflare lifecycle.

## 2. One-shot local T-Line reconnect check

With the separate front door and Core configured, use:

~~~powershell
superagent core reconnect-check --front-port 7891 --core-port 7888 --session-id YOUR_SESSION_ID
~~~

The command loads the private Core bearer locally, sends one GET to the transport health endpoint, and if Core is ready sends one authenticated GET to /api/status?sessionId=... . It only accepts an HTTP loopback endpoint. CLI output reports whether the front door, Core and exact session are verified. It intentionally does not reveal the bearer or echo the session ID.

The adapter module src/core/runtime/tlineReconnectProbe.ts has no timers or background execution and can be reused by T-Line clients that implement their own UI reconnect scheduling. The Phase 5d policy still applies: at most 8 bounded health retries with exponential backoff, GET-only, no POST /api/chat, POST /api/init or tool replay. A dead worker must return explicit_resume_required and require the existing user-approved Phase 5c resume workflow.

**Desktop status:** The current SuperAgent repository provides a T-Line terminal/transport implementation, not the complete separate native desktop UI. This phase offers runnable CLI diagnostics and the reusable client function, not a claim that the packaged desktop T-Line has native banners or automatic SSE/WebSocket resubscription.

## 3. Test evidence

Run from the SuperAgent repository:

~~~powershell
bun run build
bun --bun x vitest run --maxWorkers=2 tests/corePhase5e.test.ts tests/corePhase5d.test.ts tests/coreBoot.test.ts tests/coreGuardian.test.ts tests/transportHost.test.ts
bun scripts/verify-core-guardian.ts
bun scripts/verify-core-session-resume.ts
bun scripts/verify-core-supervisor.ts
~~~

The Phase 5e local unit tests verify a consistent SQLite snapshot and unchanged original DB/checkpoint, private secret backup without leaking tokens into the manifest, refused foreign port owners and symlink files, and strictly GET-only T-Line session probes. The staging test also verifies the new commands with a real isolated T-Line listener and hard-killed test-owned Core supervisor/worker. It compares original checkpoint bytes before and after cold evidence collection. No model call, tool execution, external notification, production process restart or automatic replay is performed.

The Linux/Windows GitHub Actions workflow is updated; remote CI success is not claimed until a run is inspected.

## What remains

- A human-authorized operator reconciliation workflow to review unresolved tool effects and session history, choose a new workspace/profile, and explicitly start a clean Core *without destroying historical evidence*. No checkpoint clearing or force-adoption is implemented.
- Native T-Line desktop event-stream reconnection UI and user-visible approval flow, where that separate desktop application lives.
- Cross-process long-lived agent state migration, durable resume for in-flight tool execution and external MCP OAuth session continuity.

See [Phase 5d](core-phase5d-restart-safety.md), [Phase 5c](core-agent-session-recovery.md), and [Guardian runbook](core-guardian-recovery.md).
