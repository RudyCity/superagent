# Chat Runtime v3 — Phase 1–3 hardening (2026-10-25)

## Delivery scope

1. **Runtime activation gate:** `scripts/verify-chat-runtime-cutover.ts [port]` performs a read-only, fail-closed inspection. It verifies an authenticated Core Supervisor, an active worker and retained generation limits. It never spawns, stops, adopts, or reloads any process.
2. **Supervisor routing:** `coreSessionRouting` recognizes `x-session-id` (Chrome Side Panel), `x-superagent-session-id`, JSON `sessionId` in abort/recover, history session delete/export, and registered init/resume. Inheriting the old Side Panel header cannot redirect a new `/api/init` onto the old session worker. Invalid percent-encoded history IDs are ignored safely. When authenticated session identity is already in the header/query, large chat bodies are forwarded by streaming instead of buffered under the 1 MiB session-inspection limit.
3. **Session ownership:** cancel one session by exact root-agent/parent-agent graph or explicit matching session identity, never by a shared working directory alone. Abort matching child agents and resolve matching owned prompts; peer chats in the same workspace are not interrupted.
4. **Turn supervision:** a stale worker generation following abort must finish settling before a new accepted turn runs. Its finalizer resumes the accepted-turn queue even after generation changes. Mark an incomplete model outcome `interrupted`, never `completed`. Handle missing SQLite storage during shutdown without an unhandled finalizer failure.

## Tests completed

Command:
```powershell
bun --bun x vitest run tests/coreSessionRouting.test.ts tests/coreSupervisor.test.ts tests/coreSupervisorCheckpoint.test.ts tests/coreGenerationPolicy.test.ts tests/chatRuntimeCutover.test.ts tests/sessionAgentOwnership.test.ts tests/chatRuntimeLedger.test.ts tests/chatRuntimePersistence.test.ts tests/server.test.ts tests/serverAuth.test.ts tests/sessionEventScope.test.ts tests/sessionEventReplay.test.ts tests/chromeExtensionHardening.test.ts tests/messageQueueing.test.ts tests/agentAbortInterrupt.test.ts tests/chromeExtensionIsolation.test.ts tests/chromeExtensionRemote.test.ts
bun run build
bun run verify:extension-js
bun scripts/verify-chat-runtime-cutover.ts 7888
```

- 123/123 test cases across 17 Vitest files passed.
- TypeScript build passed.
- Unpacked extension syntax verification passed (16 JS files).
- Preflight on port **7888** intentionally returned exit 2 (BLOCKED): public port occupied, no verified Core Supervisor registered.

## Operational constraint & Phase 2 remainder

At audit time the listener `127.0.0.1:7888` was owned by globally installed SuperAgent `bun.exe` (PID 26972). The same PID was reported as the owner of an active MCP endpoint on port 9864. A verified Muse watcher was inactive. **Do not kill/restart this process as a shortcut to activating source changes**; its MCP client/tunnel continuity cannot be guaranteed. The core supervisor is an **opt-in API-only** runtime; it cannot transparently migrate an unsupervised interactive CLI, MCP tunnel, Telegram or other process.

Code/API/database/regression and supervisor-routing tests passed; actual Chrome unpacked-extension E2E, provider streaming, secondary supervised deployment with clean rollback, and live tunnel continuity need controlled staging/maintenance. Do not treat 123 passing tests as proof of those live integrations. When operationally safe, first start an isolated supervised API port, verify auth/session affinity/SSE and rollback, then plan migration of the public endpoint only after confirming that the shared MCP process will remain unaffected.

Concurrent Senopati, Muse and Studio worktree changes are not part of this change set.
