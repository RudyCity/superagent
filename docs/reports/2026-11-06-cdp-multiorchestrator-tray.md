# Worker D — Multi-Orchestrator Tray Dashboard & Safe Diagnostic Contract

Date: 2026-11-06. Scope: dashboard JS/CSS and isolated new tests only. No Core, Tray, MCP, browser, config or process mutations.

## Verified interface at time of change

GET \`/api/desktop/delegate/orchestrator\` returns \`{success,maxConcurrent,activeCount,queuedCount,counts,owners,tasks,profiles}\` via \`delegateMultiTabOrchestrator.snapshot()\` and \`tabs()\`. \`owners\` is the **orchestrator's task worker claim**, not the independent Delegate-CDP owner. Backend \`listDelegateSessions()\` publishes an allowlisted public structure with \`clientId,tabId,agentId,claimedAt,expiresAt,revision,sharing,participants[{agentId,role,joinedAt,expiresAt}],pendingInvitations\`; this public list is **not included** in the current Tray orchestrator GET. No session capability tokens are published by that public structure.

Thus the Tray currently displays real per-tab orchestrator owner, queue/active task counts and task-based review state, while CDP owner/participants/lease/revision remain **unknown** until the backend opts to include public \`sessions\`. The UI can render the documented public \`sessions\` shape if supplied later, without rendering sessionToken, invitationToken, token hashes or arbitrary object keys. It does **not** infer a heartbeat time from lease expiry. Neither the endpoint nor the public session shape exposes a last heartbeat timestamp, lock queue depth, or a deterministic stale-lock/recovery verdict, so those values remain **unknown**.

## Safety contract

- GET status and the 10-second visible-page poll never trigger browser writes; they never call new-tab, claim, release, replay, restart, stop or reclaim. Core may separately perform its documented read-only task reconciliation and update its own metadata.
- Status failure clears live-looking owner/tab state, displays unknown counters and an error. Recovery requires a fresh successful read.
- DOM uses element.textContent instead of innerHTML. Only allowlisted public session fields are rendered; task snippets redact common sessionToken, inviteToken and authorization patterns.
- Existing explicit command buttons remain user-initiated; cancellation and manual reconciliation semantics are not changed by this worker. The current ambiguous enqueue guard remains in place.
- Test fixtures simulate multiple profiles, observers vs contributors, stale revision denial, unauthorized writes, handover, a disconnected reader, and safe status recovery **without talking to a real Chrome or Core process**.

## Integration gap for core owners

Authenticated local GET must add the **public** \`listDelegateSessions()\` output as a \`sessions\` array to enable real CDP session visibility; never include token-bearing claim/join/handshake results. A safe backend diagnostic contract for lock queue depth and heartbeat timestamps would require additional allowlisted read-only fields. This worker cannot change \`src/serverRoutes.ts\`, \`src/core/browserTransport/sessionCoordinator.ts\` or Rust command routing under assigned ownership. Do not advertise a complete live CDP dashboard until that integration is confirmed.

## Verification

- \`bun --bun x vitest run tests/delegateMultiOrchestratorTrayDashboard.test.ts tests/cdpMultiOrchestratorScenario.test.ts tests/desktopDelegateMultiTabUi.test.ts tests/delegateMultiTabHostRoute.test.ts\`: **PASS**, 14 tests across 4 suites.
- \`node --check apps/superagent-tray/ui/delegate-multitab.js\`: **PASS**.
- \`bun --bun x tsc --noEmit\`: **BLOCKED by 11 existing/concurrent type errors outside Worker D**: 10 in \`src/core/browserTransport/delegateLeaseJournal.ts\` and 1 in \`src/core/delegate/cdpTransport.ts\`. Worker D did not edit these files. No Worker D file is in the reported TypeScript errors.
- No live browser or process test was performed. No commit, push, restart, PID kill or tab close was attempted.
