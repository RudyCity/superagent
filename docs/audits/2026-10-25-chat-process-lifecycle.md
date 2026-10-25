# Audit Chat Process SuperAgent — 2026-10-25

Scope: Chrome Side Panel chat input; HTTP /api/init, /api/chat, /api/abort, /api/events; Agent.sendMessage queue and abort; request classification; history and SSE reconnect. **Audit only:** no runtime processes restarted and no chat prompts sent to a live agent.

## Architecture
Side Panel input + attachments -> /api/chat -> resolveSession() -> Agent.sendMessage() -> RequestProcessor.processRequest() -> agent loop -> Agent.onEvent() -> SSE /api/events -> sidepanel UI; Agent history saved via HistoryManager. Separate ! terminal-command shortcut invokes execa directly from the /api/chat handler.

## Findings

### P0 — Direct shell execution outside the agent tool safety path
Evidence: src/serverRoutes.ts:1090-1117. A chat message starting with ! directly launches `execa(command, { shell: true })` from the authenticated HTTP route, rather than the standard tool authorization path. It has no per-action approval, command policy gate, or task/request ID. Model/tool allowlists and policy for ordinary shell tools are not applied to this shortcut. Recommendation: route through audited shell tools and the same permission/YOLO security policy; make direct shell opt-in and prohibit remote clients by default.

### P0 — Terminal output silently suppressed by newly hardened SSE
Evidence: src/serverRoutes.ts:1097-1112 emits agent_event without sessionId/workspace for command start, stdout, exit, and done; src/server.ts:412-420 discards unscoped agent_event. The command can execute and return HTTP 200 but its stream is not rendered. Recommendation: attach exact session/workspace to every command event; ensure terminal commands have independent task IDs, cancellation, and test stdout/stderr/done.

### P0 — Main input omits sessionId; wrong conversation possible
Evidence: chrome-extension/sidepanel-input.js:503-509 posts {message} while chrome-extension/sidepanel.js:1318-1327 posts {message, sessionId}. `sidepanel-input.js` overrides the global sendChatMessage (line 366), creating divergent implementations. `src/server.ts:221-227` resolves a request without sessionId to the first matching session for that workspace and clientMode. Sending chat with two sessions in one workspace can target the wrong agent and display no response in the selected panel. Recommendation: consolidate to one sender, require explicit `sessionId` for /api/chat and /api/abort, and reject ambiguous requests rather than fallback.

### P0/P1 — SSE fallback can mix sessions within a workspace
Evidence: src/serverRoutes.ts:241-249; src/core/utils/sessionEventScope.ts:23-26. If an SSE request's supplied sessionId does not resolve, but it includes a workspace, `shouldDeliverEventToClient` accepts all session events sharing that workspace. Recommendation: require a valid sessionId for sensitive chat streams, never fallback to workspace for session-identified events, test two sessions in one workspace and invalid-session stream requests.

### P1 — Preprocessing concurrency gap
Evidence: src/core/agent.ts:603-623. isRunning is checked before `await RequestProcessor.processRequest(...)` and set only afterward. Concurrent calls can both pass the check and run classification/loop concurrently. Recommendation: reserve a turn/mutex before any await; serialize pre-processing, enqueue or return conflict; verify deterministically with a delayed classifier mock.

### P1 — Unbounded queue and ambiguous API acceptance
Evidence: src/core/agent.ts:138,603-608,780-785; src/serverRoutes.ts:1120-1129. Messages queued while running have no quantity/bytes/age bounds, and /api/chat sends HTTP 200 before the agent finishes, without client messageId/turnId or deduplication. Recommendation: bounded durable queue; return 202 with turn ID/state (accepted/queued/running/completed/failed/cancelled); idempotent clientMessageId; enforce queue budget and backpressure.

### P1 — Abort not fully session-local and abort/preprocessing race
Evidence: src/core/agent.ts:1026-1049. Agent.abort() sets isRunning=false immediately and globally invokes abortActiveRemoteTask()/abortActiveMuseBatch(), with no owner identifier in these calls. A new send can start while old finalization is pending. Recommendation: central session-scoped cancellation and join semantics; do not mark idle until cleanup and tool cancellation settle; isolate remote task ownership; test two running sessions. /api/abort additionally accepts all=true for global abort (src/serverRoutes.ts:1418-1435), which must remain explicit and protected.

### P1 — Missing SSE replay/reconciliation
Evidence: chrome-extension/sidepanel-sse.js:18-67 implements reconnect with exponential backoff but no Last-Event-ID, replay cursor or /status reconciliation; src/serverRoutes.ts:232-284 sends live events only. If disconnect spans completion, the UI can stay spinning or miss the final result. Recommendation: monotonic session-scoped event IDs, bounded replay from cursor, on reconnect fetch running state and history, and reconcile queued/completed turns.

### P1 — Unbounded chat request body
Evidence: src/server.ts:464-470 concatenates all incoming chunks without cap; src/serverRoutes.ts:1056-1059 JSON.parse for chat. Multimodal image attachments may be large. Recommendation: explicit body size, content type, JSON schema validation, timeout, and structured HTTP 413/400 responses.

### P2 — UI optimistic loss of attachments and duplicate sender logic
Evidence: chrome-extension/sidepanel-input.js:491-523 clears attachments/tags and chat input before /api/chat acknowledges; on network failure only generic error is appended. Different implementation in sidepanel.js:1296-1343 makes context attachment/behavior inconsistent. Recommendation: keep draft until 202 accepted, retry with same idempotency key, disable repeated submissions, and unify state machine. UI sets `isWaitingForAgentStart=false` on any SSE event at sidepanel.js:940, not only its turn's response.

### P2 — Logging user content
Evidence: src/core/agent.ts:603-608 and :630-654 logs/records summaries of user message. Recommendation: redact sensitive data, bound log retention, do not persist attachments or raw credential-like content.

## Validation (current workspace source)
- `bun --bun x vitest run tests/server.test.ts tests/serverAuth.test.ts tests/sessionEventScope.test.ts tests/chromeExtensionHardening.test.ts`: **78/78 passed**.
- `bun --bun x vitest run tests/messageQueueing.test.ts tests/agentAbortInterrupt.test.ts`: **2 passed / 1 failed**. Message queue scenario passes, retry-delay abort scenario passes; streaming-abort test fails after 10s because its mocked model stream is never entered (abortSignalPassed undefined). Reproduced failure in a second standalone run. This is an unresolved test/runtime entry failure, not definitive proof that abort itself does not work.
- Read-only live process inspection showed two other project-scoped CLI sessions as IDLE, but did not establish Chrome Side Panel E2E on this source tree. Do not confuse success of isolated API tests with production-live chat correctness.
- No live agent prompt, global abort, restart or user-file modification was sent by this audit.

## Remediation order
1. One safe API chat path; remove/barricade raw shell shortcut; scope shell events.
2. SessionId mandatory for chat, abort, SSE; enforce per-session event isolation.
3. Single sender + clientMessageId/turnId + queue mutex/state machine, bounded queue.
4. Session-scoped abort and fast crash recovery, durable turn progress/events.
5. SSE event replay and reconnect/history reconciliation.
6. Input/body limits, UI draft retention, comprehensive two-sessions-one-workspace and multi-browser E2E tests.

Deployment caution: source workspace and globally installed running SuperAgent are distinct; apply changes through controlled deployment and reload extensions; do not force-stop tunnels or unrelated tasks.
