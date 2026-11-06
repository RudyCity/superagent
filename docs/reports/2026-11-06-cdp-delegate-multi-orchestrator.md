# CDP Delegate multi-orchestrator session hardening — 2026-11-06

## Scope / safety

Implemented in the existing SuperAgent `main` checkout, without creating a worktree or branch. No service restart, browser-tab mutation, deployment, commit, or push was performed. A separate Claude CLI attempt failed before editing because of a self-signed certificate; implementation proceeded via project MCP file tools. The repo has many unrelated uncommitted edits by other delegates; do not discard them.

## Changes

- `src/core/browserTransport/sessionCoordinator.ts`: isolated per-`clientId`/`tabId` FIFO serialization with bounded queue length (32). Sessions support owner-only administration and opt-in sharing with `observer` (read only) or `contributor` (read/write). Owner and member capability hashes remain private. Each invite is bound to a named agent, expires after 60 s, can be redeemed only once. Member and owner inactivity TTL is 90 s. Revoking a participant or stopping sharing invalidates its capability; handover promotes an existing contributor's capability without revealing it to the previous owner. Participant writes require `expectedRevision`.
- `src/core/browserTransport/commandCapabilities.ts`: makes Delegate transport advertise the sharing commands actually routed in source.
- `src/core/delegate/cdpTransport.ts`: routes `heartbeat_session`, `share_target`, `stop_sharing`, `invite_agent`, `join_target`, `leave_target`, `revoke_agent`, `handover_target`, `session_participants`, and `shared_snapshot`. All administrative operations are protected by the same target lock. For browser mutations, validates capability and expected revision **inside** the FIFO lock, immediately before issuing the CDP request, and increments revision before releasing that lock. Observer may not activate/close a claimed tab. Multi-tab task reservations block conflicting CDP administration.
- `tests/delegateCdpMultiAgentSessions.test.ts`: 7 isolated tests covering two profiles, three claims, one-time invites, observer/contributor permissions, revocation, handover, concurrent stale-write rejection, shared snapshots, and owner-only actions. Mocks the bridge; no live browser interaction.

## API workflow

1. Discover profile and tab via `superagent_delegate_read_chat({connections:true})` and `superagent_chrome_cdp({command:"list_targets", transport:"delegate"})`.
2. Orchestrator A claims a specific qualified `delegate:<clientId>:<tabId>` target with its stable `agentId`; secure the returned `sessionToken`.
3. Owner calls `share_target` with its owner token, then `invite_agent` using `memberId` and `role: "observer" | "contributor"`.
4. Owner passes `inviteId` and `invitationToken` through an appropriately protected channel to the named recipient. Recipient calls `join_target` with its own `agentId`; it receives its own `sessionToken`. Do not print/share these secrets in logs.
5. Contributors read the current `revision` via `session_participants`, then pass it as `expectedRevision` for every mutating action. A stale revision is a terminal conflict for that attempt; inspect and retry explicitly rather than silently replaying the browser action.
6. Owner may `revoke_agent`, `stop_sharing`, or `handover_target` to an existing contributor. `release_target` is owner-only. Admin actions and browser writes serialize per tab.

An explicit `agentId` plus secret capability is currently used by this transport; it is not yet a cryptographically bound MCP-connection identity. `superagent_browser_gateway` has a separate connection-derived identity design. Avoid giving capabilities to untrusted orchestrators.

## Verification

- `bun --bun x vitest run tests/browserTransportSession.test.ts tests/delegateCdpTransport.test.ts tests/delegateCdpMultiAgentSessions.test.ts` — **13/13 PASS**.
- `bun --bun x tsc --noEmit` — **PASS**.
- Broader browser test selection (`delegateCdpExtension`, `chromeCdpTools`, `chromeCdpOptimizations`, `delegateMultiTabOrchestrator`) — **91 PASS, 1 FAIL**. The failure is an unrelated pre-existing version expectation: `tests/delegateCdpExtension.test.ts` expects `1.8.x` but current shared-checkout extension manifest advertises `1.9.0`. Its test and manifest are owned by parallel extension work and were not modified here.
- `git diff --check` for the three modified source files — **PASS** (line-ending conversion warning only).

## Remaining release gates

No production/live multi-orchestrator test was performed and no running Core or extension was reloaded. Run a safe supervised build and a controlled E2E against disposable browser tabs only when lifecycle owner gates allow it. Specifically validate two separately authenticated orchestrator connections and replay/stop/timeout cases. This change alone does not prevent other programs from using raw Chrome debugging interfaces outside SuperAgent or bypassing this CDP coordination through other Delegate APIs. Treat source change as implementation/test-ready, not as proof the live installed service already has these commands.
