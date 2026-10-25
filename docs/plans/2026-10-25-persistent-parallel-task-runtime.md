# Persistent Parallel Task Runtime — P0 Foundation (2026-10-25)

## Scope implemented

Core modules:
- `src/core/assistant/assistantTaskStore.ts`: per-owner/per-workspace durable task record and sequenced event journal in versioned JSON snapshots with atomic rename and an exclusive cross-process writer lock. Task creation is idempotent by supplied key, updates require expected revision, illegal/terminal transitions fail closed, and journal corruption is not overwritten.
- `src/core/assistant/assistantTaskDispatcher.ts`: bounded dispatcher (explicit concurrency 1–6, default 3) with read/write resource locks and optimistic claim transitions. Only a caller-supplied trusted worker callback can execute; task completion requires the worker callback to resolve; failures do not auto-retry side effects.
- `src/core/config/executionMode.ts`: explicit per-agent/session mode is authoritative over shared-process flags. `getModelConnectionDetailsForTier` now uses this resolver for tier selection.

## Important limitations

These are lower-level primitives, **not yet the desktop multi-goal execution API**. No new authenticated route, UI action, automatic agent spawning, replay of in-progress effects, user approval bypass, proactive automation or restart-safe worker adoption is enabled by this change. A task journal entry is not evidence that a worker was launched. The runtime worker callback must be bound by a future scoped service with explicit user/session/workspace authorization, tool permissions, quota, idempotency and conflict checks. The current owner/workspace ID values are validated identifiers, not credentials or authorization capabilities.

On crash, recorded `running` entries must be reconciled against verified worker/effect evidence before any new attempt; the dispatcher intentionally has no blind recovery/retry. Unknown writer locks are never stolen; operators must inspect before removal. Atomic JSON journal size and task counts are intentionally bounded; migrate to a transactional backend if multi-host claims or high volume is required. The per-task event feed is persisted as a bounded history, not an SSE host in this phase.

## Tests and acceptance

- `bun --bun x vitest run tests/assistantTaskStore.test.ts tests/assistantTaskDispatcher.test.ts tests/executionMode.test.ts`
- `bun run build`

Confirmed in development: 13 targeted tests pass, TypeScript build passes. Scenarios: idempotency, persisted status, illegal transition, revision conflict, owner/workspace separation, corruption fail-closed, unknown lock rejection, concurrent submissions, dispatcher concurrency cap, writer collisions, stale claim rejection, failure persistence and per-session model mode selection.

## Next tasks (unfinished)

1. Authenticated user/workspace/session-scoped orchestration API, persistent worker run IDs, durable event relay and reconciliation.
2. Integrate with the existing Brain, subagent and daemon registries instead of duplicating task ownership or status.
3. Explicit permission/capability snapshot per task, tool-side resource scopes and CDP tab leases.
4. T-Line task center orchestration UX, cancel/steer/approve and error/recovery states.
5. Real E2E with actual local model worker, two concurrent chat sessions, disconnect, supervised API restart, and packaged desktop acceptance.
6. Add monotonic journal integrity checks, backup/restore, observer cursor retention and reporting.
