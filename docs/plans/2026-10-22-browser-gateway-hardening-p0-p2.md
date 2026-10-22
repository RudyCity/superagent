# Browser Gateway Hardening P0–P2 — 22 October 2026

## Implemented

**P0:** Chrome process and window shutdown check CDP leases; a shared lifecycle lock prevents races with new CDP claims. Handler source identity survives the safety wrapper for accurate Sidepanel/Remote mode detection. MCP logs redact nested sessionToken/password values, even in JSON-string tool payloads.

**P1:** Chrome Extension and direct Remote Bridge commands now share the lifecycle gate with CDP claims. Extension actions are intentionally fail-closed while any CDP lease is active; there is no unsafe assumption that extension tab IDs map to CDP target IDs. AsyncLocalStorage prevents nested wrapper/bridge deadlocks. Vision clicks/type tolerate small visual differences only when a unique DOM selector identifies the same element within 24 CSS pixels; otherwise a new perception is required. Token-authenticated recover_session/recover_target remain explicit.

**P2:** Cross-process priority queue uses 12-second priority aging and bounded waits. coordinator_status now reports agent counts, active tabs, queue depth, busy targets and oldest queue wait. T-Line includes an authenticated read-only /api/superagent/browser/sessions endpoint and an expandable Browser Agent Sessions panel with owner, tab ID, CDP port, lease countdown, extension policy and waiting queue.

T-Line projects allowlisted metadata only: no sessionToken, tokenHash, cookies, screenshots or page text. The status panel polls only when its browser tab is active.

## Validation commands

SuperAgent: bun run build && bun --bun x vitest run tests/chrome*.test.ts tests/browserControlWait.test.ts tests/browserMacros.test.ts tests/mcpLogSanitizer.test.ts --maxWorkers=1
T-Line: bun run build:backend; cd frontend && bun --bun x tsc --noEmit; bun --bun x vitest run src/components/BrowserAgentSessions.test.tsx src/components/BrowserTab.lifecycle.test.tsx; cd .. && bun --bun x vitest run tests/browserSessions.test.ts

## Release limits

This is a safety-first unified gate, not cross-adapter concurrent tab multiplexing. Chrome Extension commands remain blocked while a CDP agent lease exists. Authenticated multi-profile Chrome + desktop E2E acceptance has not been run. Restart running SuperAgent and T-Line processes to activate changes.