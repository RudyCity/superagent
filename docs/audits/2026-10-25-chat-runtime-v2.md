# SuperAgent Chat Runtime v2 — Durable Turns, Session Recovery and SSE Journal

Date: 2026-10-25
Workspace: `D:\\backup from pc asus\\Documents Development\\superagent`

## Shipped in workspace source

- Durable SQLite `chat_turns` ledger and indexed `chat_event_journal`, colocated with SuperAgent's history database. Turns store `turnId`, exact `sessionId`, workspace, client mode, message digest/payload, `accepted / queued / running / recoverable / completed / failed / cancelled / interrupted`, timestamps and abbreviated errors.
- Transactional idempotency: identical retried `clientMessageId` returns original receipt; the same ID with different payload, workspace, client mode or session is rejected.
- Dedicated in-process worker per chat session dispatches queued turns sequentially and records terminal status. Preserves existing T-Line trusted creator context. SQL cap: 32 pending/running turns per session; request content cap remains 32 MiB.
- Stop for a session cancels only that session's chat ledger/worker and agent. Crashed or restarted `running/accepted` turns become `interrupted` (never re-execute non-idempotent tools automatically). Previously queued, not-started turns become `recoverable`; a user explicitly restores them with `/recover`.
- Long-running chat loop cancellation, including cancellation before request classification completes, produces a terminal `done` event. Prevents queued messages from becoming stuck following preprocessing exceptions.
- SQLite-backed, session-filtered SSE journal with monotonically increasing IDs across core restarts. Bounded replay, gap signaling and history/status reconciliation. Large unjournaled frames are reconstructed through history; permission/approval workflow must be rechecked after a core restart.
- Side Panel navigation generation counters prevent stale asynchronous chat-history/switch responses from overwriting a newer selected session. SSE reconnect avoids unnecessarily reloading history on first connection. Turn state notifications update the selected message's spinner.
- CORS/authorization remain scoped to trusted extension origin/server bearer token and an exact session. Workspace ownership guards still cover history, resume and delete.
- Local observability: `GET /api/chat/turns?sessionId=...` lists metadata without message payloads; `GET /api/status` includes `chatTurnMetrics` for the selected chat.
- Retention: journal events older than 24h and completed turn receipts older than 30 days are pruned at backend startup. Full chat history is independent and is not deleted by this cleanup.

## Safe user operations

In the Chrome Side Panel:
- `/turns` — inspect current session's count of completed, interrupted, queued and recoverable turns.
- `/recover` — explicitly resume only previously queued and recoverable turns for this session, without automatically repeating possibly side-effecting interrupted tasks.
- Stop — abort just the selected session.

Backend:
- `POST /api/chat/turns/recover` with JSON `{"sessionId":"..."}` and authenticated session context, returns count resumed.
- `GET /api/chat/turns?sessionId=...` returns session-scoped metadata without raw messages.

## Regression & deployment

Run:
```powershell
bun run build
bun run verify:extension-js
bun --bun x vitest run tests/chatRuntimeLedger.test.ts tests/chatRuntimePersistence.test.ts tests/server.test.ts tests/serverAuth.test.ts tests/sessionEventScope.test.ts tests/sessionEventReplay.test.ts tests/chromeExtensionHardening.test.ts tests/messageQueueing.test.ts tests/agentAbortInterrupt.test.ts tests/chromeExtensionIsolation.test.ts tests/chromeExtensionRemote.test.ts
```

The active server on port 7888 was previously confirmed to be a globally installed `superagent/dist/cli.js` running in `bun.exe`, **not** the local workspace source. Compilation of local source does NOT activate it in that active process. Deploy only through a proven supervisor/hot-core update path, reload the unpacked extension, then test live multi-session workflows and active tunnels. Do not blindly terminate PID or recycle port 7888: it also hosts in-use connection endpoints. Any actual production runtime rollover should verify token/session preservation, tunnel continuity and rollback.

## Remaining external validation / intentional limits

- Full live Chrome unpacked-extension E2E and globally installed SuperAgent rollout were not performed here; tests are isolated code/API/database tests.
- The test of stalled streaming abort injects at the agent-loop boundary rather than making a real external model provider call; provider-specific streaming cancellation still needs staging.
- SQLite journal may store streamed chat content locally for up to 24h; protect the SuperAgent config directory and do not include these DB files in diagnostics or shared bundles.
- Restart recovery deliberately requires confirmation for queued messages and does not restart partially executed tools automatically. This is an intentional safety guarantee, not silent message loss.
