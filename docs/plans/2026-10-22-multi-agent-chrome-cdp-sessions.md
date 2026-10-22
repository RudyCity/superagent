# Chrome CDP Multi-Agent Gateway — implementation and operations

## Status

P0 security, P1 recovery/observability and P2 queue coordination implemented in the SuperAgent Chrome CDP pathway.
Tests include mocked CDP, queue/capability regression, and independent Bun worker processes.
CLI/MCP callers must restart their existing long-running processes to use the new interface.

## Trust and concurrency model

- **Port + targetId** identify a Chrome/Electron target. Every active agent must use an explicit target ID from `list_targets`; do not infer the active browser tab.
- A caller uses `claim_target` with a stable `agentId`. The response contains a **secret `sessionToken` capability**. Persist it only in the owning agent's secret session state, never in logs, documentation, or public messages. The filesystem stores only a SHA-256 hash.
- Send the same `agentId`, `targetId` and `sessionToken` in **every** subsequent CDP and vision request, including reads and screenshots. Knowing `agentId` alone is insufficient. `list_sessions` and `coordinator_status` never return tokens or hashes.
- A claim expires after five minutes without owner activity. Authorized reads and writes renew it; `recover_session` renews it explicitly with the same token. Expired claims must be reclaimed and receive a **new** capability.
- A multi-process atomic directory lock prevents concurrent mutations to the same tab. Never steal a live process lock. After a dead process and stale heartbeat, a replacement can recover the abandoned lock. A priority-aware on-disk queue supports wait times up to 120 seconds; `priority=0` is highest and `9` lowest, default `5`. AbortSignal cancellation is supported by the coordinator API for internal callers.
- Legacy single-agent commands can operate on unclaimed tabs. If any agent has an active claim, legacy callers need an explicit target, and they cannot read/write claimed targets without the capability.
- Browser Extension and remote bridge actions are **fail-closed while any CDP claim exists** because extension active-tab identifiers are not cryptographically mapped to CDP target IDs. Release all claims to resume extension workflows; for multi-agent work prefer CDP.
- `get_cookies` is disallowed whenever any CDP session is active on that debugging port because Chrome Storage.getCookies is browser-context-wide, not limited to one tab. Use separate browser profiles/debugging ports for separate logins.
- Vision snapshots are scoped by agent+target; element-based action checks screenshot equivalence and fails if the page changed. Run `perceive_page` again when stale.
- Audit events are metadata-only at `~/.superagent-r/cdp-sessions/events.jsonl`. No cookies, screenshots, page HTML, or terminal transcripts are stored. For testing change root with `SUPERAGENT_CDP_SESSION_DIR`.

## MCP/CLI workflow

```json
{"command":"list_targets"}
```

Find an existing Chrome target or open a new one with `new_tab`. For an existing target, claim it:

```json
{"command":"claim_target","targetId":"TAB_ID","agentId":"laris-qa"}
```

Store the returned `sessionToken` secretly. Continue with:

```json
{"command":"navigate","targetId":"TAB_ID","agentId":"laris-qa","sessionToken":"RETURNED_TOKEN","url":"http://localhost:7002","queue_wait_ms":30000,"priority":5}
```

Vision operations use `superagent_chrome_vision` with the same three identity fields and optional JSON `payload`. Inspect ownership and queue status:

```json
{"command":"coordinator_status"}
```

To renew an active tab claim:

```json
{"command":"recover_session","targetId":"TAB_ID","agentId":"laris-qa","sessionToken":"RETURNED_TOKEN"}
```

To recover after Chrome closed/recreated a tab, first obtain a **new existing** target ID using `list_targets` or `new_tab` (without an `agentId` to avoid preclaiming the replacement), then:

```json
{"command":"recover_target","previousTargetId":"OLD_TAB_ID","targetId":"NEW_TAB_ID","agentId":"laris-qa","sessionToken":"OLD_TOKEN"}
```

This command requires an **unexpired** source claim and an unclaimed replacement, issues a fresh token, and releases the original claim. It does **not** guess the replacement from its URL or migrate the previous browser session's cookies.

When done:

```json
{"command":"release_target","targetId":"TAB_ID","agentId":"laris-qa","sessionToken":"RETURNED_TOKEN"}
```

Do not print token-bearing responses in shared log output. Do not rely on the lock for server-side transactions: multiple browser tabs can still concurrently modify the same application record.

## Verification

```bash
bun run build
bun --bun x vitest run tests/chromeCdpMultiAgent.test.ts tests/chromeCdpTools.test.ts tests/chromeCdpTerminalCommands.test.ts --maxWorkers=1
```

Focused tests verify denied unauthorized reads and writes, independent-process contention, different-target parallelism, credential-authenticated target rebinding, lease renewal, queue cancellation, and extension gateway fail-closed behavior.

## Operational limitations

- Chrome processes/profiles remain independently managed and must not be confused with tab ownership.
- If an agent terminates while holding a lock, other agents should retry after stale-lock recovery. A live stuck process's lock is not forcibly stolen.
- Browser identity credentials are capability tokens **within the local authorized SuperAgent runtime**; operating-system users with full access to the same home directory are not isolated security principals.
- Queue cancellation from external MCP clients depends on their transport cancel/abort support; there is no UI for editing running queues yet.
- The extension is not currently multiplexed with CDP: it is deliberately blocked during CDP claims rather than granted unsafe concurrent access.
- A real multi-agent browser UI E2E run on three account profiles is recommended before marking it production-ready. This file describes code/test validation, not a production deployment.

## Verification evidence (2026-10-22)

- `bun run build` (TypeScript compilation and MCP schema synchronization): passed.
- Browser regression suite: 26 test files / 264 tests passed after the priority queue and extension guard tests.
- Coordinator suite after adding those tests: 10/10 passed, including independent Bun worker processes, priority ordering and extension fail-closed guard.
- Live Google Chrome smoke: two new isolated `about:blank` tabs, two concurrent writes to distinct targets, unauthorized cross-agent write rejected, both test tabs closed successfully.
- A full real-world workflow with three authenticated application profiles remains a separate deployment acceptance step; this smoke did not log in to or modify user application tabs.
