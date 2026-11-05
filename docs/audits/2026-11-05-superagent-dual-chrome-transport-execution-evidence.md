# SuperAgent Dual Chrome Transport — Execution Evidence

**Date:** 2026-11-05
**Plan:** `docs/plans/2026-11-05-superagent-dual-chrome-transport-delegate-cdp-master-plan.md`
**Workspace:** `D:\\backup from pc asus\\Documents Development\\superagent`
**Branch:** `main`
**Worktree:** existing worktree only; no feature worktree created.

## Implemented

- Backend-qualified managed/Delegate target identities, including structured `transport:auto` discovery output with qualified IDs for both backends.
- Concrete `ManagedCdpTransport` and `DelegateCdpHostTransport` implementations behind the browser-transport router; the legacy managed command surface remains backward compatible.
- Deterministic `managed` / `delegate` / `auto` routing; omitted transport remains managed.
- Delegate extension 1.8.0 `debugger` permission, default-off user toggle, service-worker CDP bridge, and popup telemetry for current debugger attachment count/tab IDs.
- Host + extension CDP allowlists, privileged-URL denial, cookie/storage denial, debugger-conflict preservation, and no mutation replay.
- Delegate capability/version handshake with explicit old-extension error.
- Delegate target discovery, attach/detach, health, attachment metadata, tab actions, and bounded dialog event metadata.
- Delegate claim/lease capability tokens, optimistic `expectedRevision` validation, revision increments only after successful writes, explicit claim requirement when `agentId` is supplied, and per-target serialization so concurrent legacy/unclaimed operations cannot interleave on the same tab.
- High-level Delegate navigate/read/snapshot/links/evaluate/click/type/wait/screenshot/dialog operations.
- Framework-generated reader `Runtime.evaluate` calls are read-classified; generated click/type mutations are write/dangerous-classified.
- Delegate cursor movement, coordinate drag-and-drop, and device/viewport emulation.
- Vision/Set-of-Mark routing over Delegate screenshots/Input/Runtime with transport-qualified cache identity.
- MCP schemas for CDP and Vision expose `transport`, `delegateClientId`, `delegateTabId`, and `connectionId`.
- Existing semantic ChatGPT Delegate tools remain intact.

## Verification

Final verification commands executed from the repository:

- `bun --bun x tsc --noEmit` — PASS, exit 0.
- `bun run verify:extension-js` — PASS, exit 0; 22 extension JavaScript files verified.
- Dual-transport focused suites — PASS after concurrency/adapter hardening; latest touched regression batch: 4 files / 79 tests, including managed adapter routing, qualified auto-discovery, and popup attachment telemetry.
- Earlier full dual-transport batch — PASS: 6 files / 82 tests after the adapter/telemetry additions.
- `bun run verify:delegate` — PASS: 8 files / 105 tests plus extension syntax and Delegate discovery verification.
- Managed CDP regression `tests/chromeCdpTools.test.ts` — PASS: 64 tests.
- MCP host/exposure + managed CDP focused batch — PASS: 3 files / 77 tests.
- `bun scripts/verify-delegate-discovery.ts` — PASS, exit 0.
- `bun run build` — PASS, exit 0.
- Final reported Core build SHA-256: `12fc9eb90c8147b0fe943d508cca8e48ce9c76b1c94c4b43aedee70b14bdac5f`.
- Final source digest reported by the build: `65618d2bd9062270ff61e10ce3ed7c5c549d5db4675c55a0ed765fa585168fa2`.
- Low-level managed adapter health probe correctly returned `ECONNREFUSED 127.0.0.1:9222` because no default-port managed endpoint was running during the final adapter-specific probe; no live command success is claimed for that probe.

## Live evidence

### Managed CDP

A live harmless E2E was completed against the currently running Chrome endpoint:

1. Opened a temporary `https://example.com/` tab.
2. Claimed the exact target using an isolated agent lease.
3. `read_page` returned verified visible DOM for “Example Domain”.
4. `screenshot` captured a 49,640-byte PNG.
5. Released the target lease.
6. Closed the temporary tab.

This demonstrates that the pre-existing managed path still works after the dual-transport refactor.

### Delegate-CDP

The final Delegate connection roster returned zero connected profiles. Therefore a real `chrome.debugger` attach/navigate/read/click/type/screenshot sequence cannot be truthfully claimed in this run.

Live Delegate E2E requires a Chrome profile to reload/accept Delegate 1.8.0's new `debugger` permission, connect to the authenticated loopback bridge, and explicitly enable Delegate-CDP in the popup. The implementation deliberately does not silently install/reload the extension or take over another debugger owner.

### Live MCP/Core activation

The source and generated build contain the new CDP/Vision transport schema, but the MCP connection used during this run still reports the pre-v1.8 live schema. Runtime service inspection reports the Core process as legacy/unverified and no registered MCP owner. No restart/reload was forced because SuperAgent's lifecycle policy forbids adopting or killing an unverified owner. Activate the new live schema through a controlled, ownership-verified Core/MCP start or reload.
