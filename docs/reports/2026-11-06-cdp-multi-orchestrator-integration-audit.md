# SuperAgent CDP Delegate — multi-orchestrator integration audit
Date: 2026-11-06 (Asia/Jakarta)
Repository: D:\backup from pc asus\Documents Development\superagent
Branch: main, shared checkout (no worktrees or branches created)

## Delivered in source (not deployed to live Core)

**Agent A / authenticated MCP identity**
- New `src/core/browserTransport/delegatePrincipalPolicy.ts`; explicit authenticated MCP transport boundary, per-session derived actor, denial of spoofed agentId and cross-target capability reuse, filtering of session inventory, fail-closed unknown identity.
- Updated `src/core/delegate/cdpTransport.ts`, `src/core/tools/chromeCdpTools.ts`, `src/core/mcp/tools/chromeMcpTools.ts`.
- Orchestrator integration: `src/core/mcp/superagentMcpServer.ts` now passes the server-derived `connectionBrainSessionId`, verified `getIdentity()?.mode`, and verified subject to `dispatchChromeMcpTool`; tool args and client labels are not trusted sources.
- **Remaining security limitation:** MCP-to-Core browser dispatch forwards through an independently authenticated Core bearer route. This does not cryptographically attest which originating MCP transport supplied the actor and cannot yet securely convey the principal to the Core owner process. Do not assert end-to-end principal binding or enable claimed Core-backed multi-orchestrator operations without an authenticated, replay-safe forwarder context and tests. Per-MCP-transport derived identities rotate across new connections and require an explicit reconnect/handover design.

**Agent B / durable leases**
- New `src/core/browserTransport/delegateLeaseJournal.ts` with opt-in integrity-protected, bounded, atomic journal; digest-only capabilities; corruption/expiry checks and owner-token recovery contract.
- Updated `src/core/browserTransport/sessionCoordinator.ts`; owner/member permissions, FIFO, per-tab revisions, lease recovery with explicit fencing conditions.
- Journal is intentionally opt-in. A stable protected journal HMAC key, authoritative Core process epoch, old-owner retirement proof, and cross-process fencing are not configured/verified. No live journal file or secret was created for this task.

**Agent C / cross-API coordination**
- Updated `src/core/tools/delegateTools.ts`, `src/core/mcp/tools/delegateMcpTools.ts`, and `src/core/delegate/bridge.ts` so semantic Delegate mutations share CDP tab-level locks and reservation checks, demand explicit profile/tab selection except deliberate new-tab creation, and use optional requestId with durable hashed receipts. Timeouts are unknown outcomes, not automatic reasons to resend.
- `src/core/delegate/multiTabOrchestrator.ts` was inspected and preserved, avoiding nested-lock deadlocks.

**Agent D / dashboard**
- Updated `apps/superagent-tray/ui/delegate-multitab.js` and `.css`, showing grounded owners/queue/roles/lease/revision/recovery, escape/redaction and unknown status when data unavailable.
- Dashboard cannot display actual CDP participants/revisions until a trusted backend endpoint exposes `listDelegateSessions()` (without secrets). No live Tray restart.

**Orchestrator compatibility integration**
- Updated legacy regression fixtures `tests/delegate.test.ts`, `tests/delegateMultiClient.test.ts`, `tests/delegateCdpMcpHostRoute.test.ts`, and `tests/delegateCdpExtension.test.ts` to test explicit targets, authenticated dispatch, and the actual 1.9 extension manifest, without weakening runtime guards.

## Final validation — actual host commands
- `bun --bun x vitest run $(find tests -maxdepth 1 -name 'delegate*.test.ts' ! -name 'delegateMcpPrincipalBinding.test.ts' | sort)` — **193/193 PASS** (24 suites).
- `bun test tests/delegateMcpPrincipalBinding.test.ts` — **9/9 PASS**.
- Earlier additional scenario/UI suite verification: `tests/cdpMultiOrchestratorScenario.test.ts` (3 PASS), `tests/desktopDelegateMultiTabUi.test.ts` (4 PASS), plus Chrome tool regressions (64 PASS within the 157-test selected broader browser run).
- `bun --bun x tsc --noEmit` — **PASS** after integrated changes.
- `git diff --check` across modified security/compatibility files — **PASS**, Git reported CRLF normalization warnings only.

All tests were isolated and mock-backed or used temporary localhost fixtures, not live ChatGPT/browser mutations.

## CDP worker browser tab cleanup
New worker tabs created solely for this request: 1472031143 (A), 1472031144 (B), 1472031145 (C), 1472031146 (D).
Each returned a completion marker, and each tab was explicitly closed via Delegate-CDP with a confirmed `closed: true` result. Subsequent Delegate target discovery found **none** of these IDs. Existing unrelated tabs were not closed.

## Live runtime / NO-GO for automatic activation
Read-only Core status showed a supervised Core worker whose running build digest differed from the current compiled digest, and reported current build not fresh. Another read-only unified service-status view reported the Core owner as unverified/inactive, while MCP and Tray owners were independently verified. These are inconsistent safety signals; do not assume restart is safe.
No restart, deployment, PID kill, tunnel change, service mutation, commit or push was performed.

Release gates: (1) verified origin-bound MCP-to-Core principal forwarding and authenticated event replay protection; (2) trustworthy stable recovery identity and Core-epoch fencing; (3) opt-in durable lease key provisioning and process lifecycle integration; (4) trusted read-only CDP status endpoint for Tray; (5) disposable-tab E2E from two distinct real authenticated MCP sessions; (6) supervised lifecycle preflight must agree on owner/build/session state before any activation.
