# Phase 5c — Durable Core session receipts and explicit dead-worker resume

**Scope:** opt-in supervised API workers only. This adds durable session *metadata* and verified reuse of existing SQLite history, not serialization of Agent objects or in-flight LLM state.

## Execution and recovery

1. On successful /api/init and /api/switch-workspace, the supervised worker publishes a bounded receipt under ~/.superagent-r/core-session-receipts/<SHA256-prefix>/<SHA256-session-ID>.json. It binds exact session ID, trusted workspace, agent mode and client mode. New receipts publish atomically without overwriting an existing registration. No prompt, token, tool output, or user message is stored in these receipts.
2. Before an accepted /api/chat turn is started, its turn ID and acceptance timestamp are checkpointed. A failed write prevents execution; the existing durable chat-turn ledger retains the accepted turn for operator review.
3. HistoryDb/SQLite stays the authoritative conversation data source. A receipt by itself is **not** evidence that conversation history has been persisted.
4. If the session's original worker dies, normal chat/SSE/switch-workspace traffic is rejected with 503. No implicit reassignment and no automatic tool replay occurs.
5. For explicit resumption, a **different verified healthy Core worker** must already be active. Send POST /api/init through the existing authenticated Core API endpoint with a JSON object:

~~~json
{"sessionId":"existing_session_id","resume":"existing_session_id","workspace":"EXACT_PREVIOUS_TRUSTED_WORKSPACE","mode":"single"}
~~~

Keep the original client mode. No initialPrompt is permitted on resume. The new worker validates the previous registration receipt, workspace, mode, client mode, saved SQLite history, actual message count and save timestamp, and chat-turn state. Running, accepted, queued, recoverable, interrupted or unknown statuses block resume; completed/failed/cancelled turn metadata alone does not authorize an unsaved conversation. The original receipt's most recent accepted-turn timestamp must not be newer than saved history. Missing, stale, or mismatched state results in HTTP 409/503.
6. Only a successful verified 200 init response with the exact session ID allows supervisor session affinity to move. The new mapping is persisted to the supervisor checkpoint before the 200 is returned. On checkpoint write failure, affinity is rolled back.

## Verification

~~~powershell
bun run build
bun --bun x vitest run --maxWorkers=2 tests/coreAgentSessionCheckpoint.test.ts tests/coreSessionRouting.test.ts tests/coreSupervisor.test.ts
bun scripts/verify-core-session-resume.ts
bun scripts/verify-core-supervisor.ts
bun scripts/verify-core-guardian.ts
~~~

The end-to-end smoke uses random local ports and an isolated OS configuration home, initializes three sessions including switch-workspace, creates an alternate worker, kills only its *own* original verified test worker, verifies fail-closed behavior for ordinary requests, missing history, ambiguous turns even with saved history and wrong workspace, and accepts exact explicit safe resumption after saved history exists. Reports are saved in ~/.superagent-local-staging/core-session-*/report.json. No actual AI/model tools or external notifications are invoked.

## Limits

- This is *not* full machine reboot restoration. With all workers dead, safe Core boot still refuses to recreate in-memory agents automatically.
- A completed chat turn is not a guarantee that external side effects are atomic. Operator reconciliation may be required; incomplete tasks must not be automatically replayed.
- Existing WebSocket/SSE streams to a crashed worker break and require reconnect. The isolated smoke checks authenticated REST rerouting, not installed T-Line desktop GUI reconnect.
- Legacy sessions without receipts, CLI-only sessions, MCP OAuth sessions, and independent Muse/Telegram tunnels are not migrated automatically.
- Local owner permissions protect receipt files against other ordinary OS accounts, not against privileged local filesystem compromise. Receipts expose workspace metadata to their owner.
- No production process/tunnel was restarted. Windows Task Scheduler was not installed. Remote GitHub Actions result has not been verified; new workflow gates are defined but require a push/run.

See [Core Guardian and safe Windows startup](core-guardian-recovery.md) for Phase 5a/b.
