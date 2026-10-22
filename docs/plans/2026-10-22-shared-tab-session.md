# Shared Tab Session — Implementation & Usage

Shared Chrome CDP tabs are opt-in. Every new claim uses isolated mode by default.

## Roles

| Role | Live DOM/snapshot/vision reads | Serialized actions | Tab lifecycle & permission management |
|---|---|---|---|
| Owner | Yes | Yes | Yes |
| Observer | Yes | No | No |
| Contributor | Yes | Yes | No |

## Commands

Use control_chrome_cdp (CLI) or superagent_chrome_cdp (MCP), with the indicated targetId and agentId.

1. Owner claims the selected tab using claim_target, which returns a private sessionToken.
2. Owner opts in using share_target and their owner token.
3. Owner runs invite_agent with memberId and role (observer or contributor). The result contains inviteId and invitationToken. Invitations are single-use, bound to a named agent and expire after at most two minutes.
4. Invited agent runs join_target with the same tab, own agentId, inviteId and invitationToken. The result contains their separate private sessionToken.
5. Every agent passes its own agentId and sessionToken on subsequent commands for that tab. shared_snapshot reads the live DOM; cached element selectors remain agent-scoped. Contributor actions run one-at-a-time under the existing cross-process target lock.
6. Agent may leave_target. Owner may revoke_agent using memberId, or handover_target to a joined contributor. That contributor retains their original private member token as the new owner token; the old owner token is invalid immediately.
7. Owner calls stop_sharing to revoke all guests and invitations, or release_target to end ownership of the tab.

session_participants shows agent IDs and roles without secrets. list_sessions and coordinator_status remain metadata only.

## Safety

All role and token checks execute inside the per-tab lock. Revoked queued actions cannot write if revocation completes first. Observer writes and contributor close_tab/activate are rejected. Owner-only controls include share, invite, revoke, handover, release and target recovery. Invitations and session tokens are never stored in plaintext inside the coordinator; only cryptographic hashes are persisted. Never expose invitationToken/sessionToken in reports or logs.

Chrome Extension controls remain blocked during CDP claims because Extension tab IDs are not reliably mapped to CDP target IDs. The shared mode is for CDP-backed commands and Vision, not cross-adapter concurrent mutation.

T-Line read-only Browser Agent Sessions dashboard displays Shared/Isolated, owner and participant roles, queue status and leases through an authenticated backend endpoint with fixed allowlisted fields. No token or tokenHash fields reach the frontend.

Live Chrome multi-profile E2E beyond mocked CDP and separate Bun worker tests remains an additional production release gate. Restart SuperAgent MCP and T-Line processes to pick up the changes.

## Verification

SuperAgent: bun run build; bun --bun x vitest run tests/chromeCdpSharedTab.test.ts tests/chromeCdpTools.test.ts tests/chromeCdpMultiAgent.test.ts --maxWorkers=1
T-Line: bun run build:backend; cd frontend && bun --bun x tsc --noEmit && bun --bun x vitest run src/components/BrowserAgentSessions.test.tsx; bun --bun x vitest run tests/browserSessions.test.ts