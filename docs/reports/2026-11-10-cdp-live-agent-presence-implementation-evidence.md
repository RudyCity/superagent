# CDP Live Agent Presence — 2026-11-10 Implementation Evidence and Blockers

**Status: PARTIAL / NOT READY TO ACTIVATE PRIMARY RUNTIME.**
**Branch:** main, starting HEAD 61867ada.
**Planned version:** 1.14.67, local working tree only; not committed, pushed, packaged or deployed.
**Owner's instruction:** all eight features, ideally executed by GPT-5.6 High through CDP Delegate.

## Delegation blocker (verified)

- Authorized Delegate read/profiles call failed with `DELEGATE_FORWARD_BRIDGE_NOT_PROVISIONED`.
- Core supervisor status: unreachable/stale at port 7888; Core HTTP process responded but process ownership was unverified.
- MCP owner is running and has active sessions; restarting/killing it or spoofing the trusted forwarding principal would breach repository's fail-closed ownership rules.
- **No CDP Delegate ChatGPT 5.6 High session was started, no tasks sent to GPT-5.6, no live Delegate feature test was performed.** Direct authorized SuperAgent repository tools were used instead.
- Explicit next gate: authorized operator must restore/verify Core owner and MCP↔Core Delegate forwarding verifier, inspect active sessions and use the documented safe lifecycle process. Only then re-test `delegate_read_chat({connections:true})` and dispatch real 5.6 High delegation.

## F1–F8 implementation ledger

| Feature | Current evidence | Remaining to qualify DONE |
| --- | --- | --- |
| F1 Multi-Agent Cursor Identity | Per-agent named noninteractive overlay from baseline; stable distinct palette added; sanitization tests PASS | Avatar/status design, session-generation lifecycle cleanup, wider 5-agent headful validation |
| F2 Live Cursor Tracking | Actual CDP mouseMoved/mousePressed/mouseReleased/drag baseline and new `scroll_cursor` real mouseWheel; headful wheel advanced scrollY by 580 | Status indicators for typing/hover, streaming transport, performance throttling and latency evidence |
| F3 Agent Activity Monitor | Read-only Managed CDP presence projection + existing authenticated Tray orchestrator GET + new panel and Follow Agent filter. Verified no token/URL leakage; real headed browser renders two agents and filter (fixture-backed data) | Production Core integration smoke after owner recovery, true streaming events, per-tab screen follow, responsive/keyboard installed app gates |
| F4 Persistent Cursor Across Navigation | Managed `Page.addScriptToEvaluateOnNewDocument`, actor-scoped update/removal, top-frame only, headful cross-document persistence and hide smoke PASS; release-target best-effort cleanup added | Delegate capability parity, crash/reconnect/expired lease cleanup, iframe/OOPIF and multi-process script ownership |
| F5 Collision Protection | Existing cross-process `withCdpTargetWrite` locks/claims/revisions and managed human hold remain authoritative; multi-agent concurrency and revoke tests PASS | Pause/cancel fencing at gesture boundary, crash during pressed state, 5-agent same-tab stress E2E |
| F6 Element Target Highlight | New `highlight_target`/`clear_highlight` uses visible+hit-test gating; real headed browser click-through/occlusion and scoped-clear PASS | Shadow DOM, frames, dynamic DOM mutation/selector snapshot expectedRevision integration, accessibility refinements |
| F7 Recording & Safe Replay | New 10-minute TTL, max 128 event, opt-in in-memory journal; authorized per-actor/target generation; redact all content/secret/selector/URL; `record_start|stop|status|export`, `replay_preview`, `replay_cursor` with confirm and expectedRevision. Integration tests PASS. | Operator consent/retention UI, durable encrypted storage as approved, full safe locator re-resolution, human approval for high-impact actions. No click/type/navigation/submit auto-replay |
| F8 Watch Mode & Human Takeover | Existing managed native human-hold API and tests PASS; read-only presence monitor/filter now exists | New operator UI for verified pause/quiesce/takeover/handoff, end-to-end active Core and Delegate ownership parity; no unverified takeover |

## Source/code changes in this execution

- src/core/tools/chromeCdpCursor.ts — color, persisted top-frame overlay, true CDP wheel, release lifecycle helpers
- src/core/tools/chromeCdpTools.ts — command surface, identity-scoped recording, highlight, release cleanup
- src/core/tools/chromeCdpCommandPolicy.ts — recorder read-only command policy
- src/core/tools/chromeCdpTargetHighlight.ts — new scoped highlight executor
- src/core/tools/chromeCdpPresenceProjection.ts — new explicit private-data allowlist
- src/core/tools/chromeCdpActionRecorder.ts — new bounded ephemeral recording and safe replay projection
- src/serverRoutes.ts — read-only Managed-CDP status added to authenticated loopback Tray route
- apps/superagent-tray/ui/index.html, delegate-multitab.js, delegate-multitab.css — existing Delegate page activity panel
- tests/chromeCdpCursor.test.ts, tests/chromeCdpTools.test.ts, tests/chromeCdpTargetHighlight.test.ts, tests/chromeCdpPresenceProjection.test.ts, tests/chromeCdpActionRecorder.test.ts, tests/delegateCdpTrayStatusEndpoint.test.ts
- CHANGELOG.md, package.json, Tray Cargo.toml, Cargo.lock and tauri.conf.json version 1.14.67

## Verified

- `bun --bun x vitest run` targeted matrix (11 named suites) → **145/145 PASS** before final release-target cursor cleanup addition.
- Post-cleanup focused cursor, Chrome tool, multi-agent, shared-tab and managed human-control tests → **114/114 PASS**.
- `bun run build` at version **1.14.67** → TypeScript + MCP schema sync + build manifest PASS.
- Headed Chrome isolated Playwright/CDP:
  - cursor persists across full document navigation, correct viewport position and safe hide → PASS;
  - element highlight rect, mouse click through noninteractive overlay, occlusion rejection → PASS;
  - genuine `Input.dispatchMouseEvent({type:"mouseWheel"})` advanced `scrollY=580` → PASS;
  - Tray page loads real Chrome headed and displays mocked authenticated agent presence/Follow Agent filter → PASS. This is a UI smoke **with mock data**, NOT live Core/Delegate.
- All test-owned Chrome sessions were closed; no user Chrome process was stopped.
- No unsafe shared Core/MCP restart, no git branch/worktree, no blanket stage, commit or push. Unrelated dirty files remain untouched.

## Remaining release gates

1. Authorize and recover Core/MCP forwarding signer and verify live Delegate transport, then launch requested GPT-5.6 High delegate.
2. Implement the remaining F1–F8 acceptance items, with full 5-agent concurrent/headful and end-to-end operator handoff E2E.
3. Check capability matrix and protect privacy in production routes/packaging; run full regression, native desktop tests and perf/leak checks.
4. Review changes from this shared dirty tree, stage only scoped files, commit and push only after required approval and verification.
5. Verify primary OS owner identity/active sessions before any activation; do not auto-restart unverified process.

**Honest completion rule:** the successful unit tests and headful fixtures demonstrate incremental real behavior; they do not establish full feature completion, safe primary production cutover, or successful GPT-5.6 High delegation.
