# Hermes Phase 5 — Workspace-Scoped Muse/T-Line Live Task Status

Date: 2026-10-20
Status: Bounded local implementation; NOT the full Phase 5 exit gate.
Parent: docs/plans/2026-10-20-superagent-hermes-phase-5-channel-contract-first-increment.md
Master: docs/plans/2026-10-18-superagent-hermes-like-implementation-master-reference.md

## Contract

- The existing Muse remote task runner now tracks volatile task identity, session ID, workspace and start timestamp. `getActiveRemoteTaskSnapshot()` returns those fields only, no prompts, transcript, tool arguments, tokens or messages.
- `projectMuseRemoteTask()` provides a conservative Phase-5 `UnifiedChannelTask` view for local CLI and T-Line. It always reports `running` and `unverified` for in-flight work; transport observation never implies a grant or proof of success.
- Local `/muse status` (T-Line) and `superagent muse status` (CLI) display active task ID, session and normalized status **only when the requested local workspace equals the active task workspace**. Foreign workspaces receive a generic no-active-task message. This is a local inspection convenience, not cross-project authorization.
- Existing Telegram/MCP/tunnel status endpoints do not expose these private per-task records. No new remote mutation or cross-project enumeration route is added.
- When a task finishes or is aborted, the in-memory handle is cleared. No new session or transcript store is created; current task history remains with existing owners.

## Tests

- Pure adapter tests assert `transport_not_authorization`, `unverified` evidence and no conversation data.
- Muse runtime session/cancellation tests assert bounded in-memory snapshot, cleanup after cancellation, and local T-Line status denial from a different workspace.
- Existing remote service status tests confirm tunnel/MCP/Telegram status continues to behave without per-task identity leakage.

## Remaining

- Channel-specific verified owner authorization and risk classes on every mutation entry-point are not universally integrated.
- Muse watcher mode has its own task lifecycle and still needs a separate normalized projection without conflating CLI taskRunner state.
- MCP/OAuth remote grants, token scope, revocation, real SSH and E2E staging checks are not proven by this local test.
- Phase 5 memory bootstrap and cross-channel durable status delivery remain open. Do not mark this phase production-ready from this increment.

## Verified local acceptance — 2026-10-20

- bun run build: passed.
- bun run verify:extension-js: passed (8 files).
- bun run wiki:validate: passed (9 documents, 24 links).
- Focused remote Agent / Muse CLI / T-Line / shared contract suites: 79/79 tests passed across 3 suites.
- Full bunx vitest run --reporter=default --maxWorkers=3: **exit 0; 378 suites passed, 1 skipped; 3,600 tests passed, 5 skipped; 0 failed**.
- Focused and full totals overlap, so they must not be added together.
- Assertions cover active task snapshot cleanup and denial of T-Line cross-workspace task/session identity.
- No live MCP OAuth, SSH, tunnel or gateway end-to-end proof is claimed from these local tests.
