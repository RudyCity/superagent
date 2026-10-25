# Chat Process and Chat Session Remediation — 2026-10-25

Workspace: SuperAgent (`main`). Applies to the Side Panel, local HTTP API, backend Agent lifecycle and session-specific SSE events.

## Fixes implemented

### P0 — Chat/session isolation
- Side Panel now sends the selected `sessionId` and stable retryable `clientMessageId` with chat requests. Abort requests include the exact `sessionId`, not only a workspace.
- The main Side Panel send function delegates to the richer canonical sender in `sidepanel-input.js`; attachments, inspected elements and tab context use one submission path.
- The server rejects extension chat, abort and SSE without a valid session; rejects global abort from the extension. `x-session-id` provides request-local context for /api/status, history and other reads.
- Session-specific SSE never falls back to a workspace-only client, including when two chats share the same workspace.
- Restoring/switching an existing session and reading, editing or deleting persisted history verifies workspace ownership. Extension history listing cannot request cross-workspace listings.
- Session switching and new chat operations re-establish SSE with the selected session and preserve the explicitly chosen session during status refresh.
- Chrome Extension origins and the new x-session-id/x-client-mode headers are supported by the backend CORS preflight allowlist; actual API requests still require a valid server bearer token.

### P0 — Terminal command tool authorization
- The `!command` shortcut is now a prompt to the agent requesting its normal authorized shell tool. It no longer invokes `execa(..., shell: true)` directly inside the HTTP chat route or broadcasts unscoped terminal output.

### P1 — Turn queue / cancellation
- `Agent.sendMessage` reserves a turn synchronously, before asynchronous request classification, preventing concurrent model loops during preprocessing.
- The pending message queue is capped at 32 entries. `Agent.abort()` invalidates preprocessing via a generation counter and keeps running state until the current turn's cleanup.
- Abort of one chat no longer invokes globally scoped remote-agent or Muse batch cancellation (those require separate owner-aware controllers).
- POST /api/chat applies structured JSON validation and a 32-MiB request limit.
- In-memory, session-local `clientMessageId` receipts reject duplicate execution, detect conflicts, and return `turnId` plus accepted/queued state. Retained receipts are bounded to 128 per session.

### P1 — SSE reconnect and replay
- Small chat events include incrementing SSE IDs and are stored in a bounded in-process cache (128 events/session, 64 sessions, 16 KiB max buffered frame).
- Extension SSE client sends `lastEventId` on reconnect to receive only missed events of the selected session. On reconnect it reconciles status and persisted history in case of process restart, lost buffer or oversized events.
- SSE connection emits a connection comment promptly and handles invalid/missing session requests with structured HTTP errors.

### P2 — UI
- Draft, file attachments and tags are not discarded until the server accepts the request; on network failure user text is restored and an optimistic duplicate message is removed.
- While a submission is in flight, duplicate sends are suppressed.
- History labels and titles escape HTML correctly, including attribute values.

## Verification

- `bun run build` — passed.
- `bun run verify:extension-js` — passed (16 JavaScript files).
- `bun --bun x vitest run tests/server.test.ts tests/serverAuth.test.ts tests/sessionEventScope.test.ts tests/sessionEventReplay.test.ts tests/chromeExtensionHardening.test.ts tests/messageQueueing.test.ts tests/chromeExtensionIsolation.test.ts tests/chromeExtensionRemote.test.ts` — 95/95 tests passed.
- Added deterministic tests for preprocessing race, abort during preprocessing and abort of an in-flight hung agent loop; the related suite passed 4/4.
- Earlier `tests/agentAbortInterrupt.test.ts` streaming test remains unreliable: its mocked stream was not invoked within the test timeout. The deterministic abort test now exercises the cancellation race, but it does not prove every real provider's stream cancellation.

## Deployment and residual limits
- The active globally installed SuperAgent process and Chrome extensions were deliberately **not restarted or redeployed**. Source build/test success does not equal live browser deployment.
- Bounded replay and chat deduplication are memory-resident; they are lost on core process replacement. Persistent history reconciliation mitigates this, but durable turn-state storage across restarts is a separate upgrade.
- In-memory receipts represent accepted/queued/failed, not an end-to-end durable state machine. The actual finished response is represented by agent history and done events.
- Re-test with both unpacked extensions installed, two simultaneous chat sessions in one workspace, one chat in a different workspace, remote tunnel connected, abort, attachments, reload, and core hot restart before declaring production E2E complete.
