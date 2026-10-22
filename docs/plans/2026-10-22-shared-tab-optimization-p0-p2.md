# Shared Tab Optimizations P0–P2 — 22 October 2026

## Delivered

**P0 — Safety and consistency**
- Per-target persistent revision is incremented after serialized writes. Snapshots are revision-scoped and agent-scoped, invalidating old indexes when a different agent writes.
- `expectedRevision` is checked atomically under the target lock, rejecting stale optimistic writes. Shared snapshots include tabRevision in their heading.
- Observer and contributor reads/writes no longer prolong the owner claim. Membership carries a separate 2-minute time limit and `heartbeat_session` renews only the calling actor's lease, bounded by the owner expiration. Owner heartbeats renew owner TTL.
- Expired claimed tabs reject reads and writes, including legacy unnamed calls. Truly unclaimed tabs retain the legacy access path. Explicit new claims are required for agent-scoped mutations.
- `chromeCdpCommandPolicy.ts` uses explicit read and admin allowlists; other commands fail closed into serialized writes, including `clear_terminal_sessions` and `get_dialogs` with clear:true.

**P1 — Queue and recovery**
- The per-target cross-process file queue listens for filesystem wakeups, with bounded 200ms fallback polling, priority aging and a capacity guard of 128 requests.
- Session status counts all non-expired participants rather than only owners.
- `recover_target` accepts `recoverByUrl:true` with exact `expectedUrl`, and only rebinds when exactly one browser page matches. Otherwise it fails closed; an explicitly chosen targetId may also be checked against expectedUrl. No arbitrary ownership takeover or fuzzy title matching. After recovery, re-invite guests.
- MCP schema supports `heartbeat_session`, `expectedRevision`, `recoverByUrl`, `expectedUrl` (redacted from MCP argument logs).

**P2 — T-Line collaboration and testing**
- T-Line Browser Agent Sessions panel shows sharing mode, participant roles, revision, lease, queue status and audit activity.
- T-Line authenticated fixed-action POST `/api/superagent/browser/shared-control` forwards to authenticated SuperAgent POST `/api/browser/shared-control`; the latter validates the owner capability under the tab lock. Available actions: share, stop, invite, revoke, handover, participants. No arbitrary JS or CLI passthrough.
- UI asks for the owner token explicitly and holds it only in component memory, not persistent storage; invitations are one-time and copied explicitly. Destructive controls require confirmation. Closed controls clear token and invite state.
- The dashboard reads at most 64KB from the tail of audit events and projects only valid time/event/actor/key fields. No raw logs, secrets, URLs, cookies, or snapshot content reach the dashboard.
- `scripts/benchmark-shared-cdp.ts` creates 3–10 independent Bun worker processes; session capability is delivered by stdin, never command-line arguments, and all data is stored in a disposable temp directory.

## Measured synthetic coordinator benchmark

| Scenario | Operations | Failures | Throughput | p95 latency |
| --- | ---: | ---: | ---: | ---: |
| 3 contributors × 4 actions | 12 | 0 | 14.44/s | 279.7 ms |
| 10 contributors × 4 actions | 40 | 0 | 13.63/s | 1357.7 ms |

These timings measure filesystem queue coordination and synthetic 10ms work per operation on the tested Windows machine. They are **not Chrome UI performance measurements** and should not be interpreted as production browser end-to-end latency.

## Verification

SuperAgent Bun build, chrome/browser/MCP sanitizer regression: 29 files, 294 tests passed. T-Line backend TypeScript build, frontend TypeScript build, Browser Shared Controls and Browser Agent Sessions UI tests, backend metadata tests also passed.

## Activation & remaining production gates

- Restart SuperAgent HTTP/MCP server and T-Line backend/frontend to load new routes and components. Current connected sessions are not implicitly switched to shared mode.
- Do a real Chrome login/profile E2E test including multi-tab navigation, page refresh, unstable DOM, token expiry, and post-restart recovery before using collaborative writes on checkout/payment flows.
- Chrome Extension is still blocked while CDP owns any tab because target identity mapping remains unverified. This enhancement covers CDP and CDP-backed Vision only.
- The control UI does not automatically discover or persist an owner's secret token. The owner must supply their capability deliberately.

## Suggested commands

`bun run build`
`bun --bun x vitest run tests/chrome*.test.ts tests/browserControlWait.test.ts tests/browserMacros.test.ts tests/mcpLogSanitizer.test.ts --maxWorkers=1`
`bun scripts/benchmark-shared-cdp.ts --agents=3 --actions=4 --work-ms=10`
`bun scripts/benchmark-shared-cdp.ts --agents=10 --actions=4 --work-ms=10`