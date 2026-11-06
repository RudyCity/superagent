# Delegate semantic/CDP cross-API locking — Worker C (2026-11-06)

## Scope and safety
Only `src/core/tools/delegateTools.ts`, `src/core/mcp/tools/delegateMcpTools.ts`, `src/core/delegate/bridge.ts`, `src/core/delegate/multiTabOrchestrator.ts` and new Worker C tests are in scope. No services, browser tabs, extensions, credentials or process owners are changed as part of this implementation.

## Contract
Dangerous semantic operations (create existing chat, send, stop, run_until_done) require **clientId** and exact **tabId**; `create_chat({ clientId, newTab:true })` may explicitly open a new tab without an existing tabId. The semantic tools share the same FIFO tab mutex as Delegate-CDP. CDP claims and multi-tab orchestrator reservations are checked **inside** the lock before a semantic mutation. Read-only history/peek/doctor remain independent. The bridge routes `delegate.read_chat` on a CDP-claimed tab to the non-mutating `delegate.peek_chat` method; an implicit read in a profile containing CDP claims is rejected. Outside claimed tabs, legacy `delegate.read_chat` may still trigger extension timeout follow-up, so prefer `peek_chat` for strict reconciliation.

`delegate.run_until_done` holds the target lock over its monitoring lifecycle; its existing internal sends must **not** acquire that lock again. MultiTabOrchestrator already acquires the target lock around Send/Stop; the bridge does not acquire a second lock, preventing self-deadlock. The core bridge independently denies semantic mutations to a CDP-claimed tab.

## Exactly-once receipt
A caller may supply `requestId` (8–80 alphanumeric, dash or underscore). The host writes a SHA-256 request fingerprint and a `pending` receipt *before* invoking the browser. On confirmation it changes to `confirmed`; on ambiguous failure to `uncertain`. The durable journal lives under the host configuration directory at runtime, and never stores the message body, original request ID or secret token. Reusing a key never re-dispatches; a changed payload returns a conflict. The journal is fail-closed if malformed, unsafe or at capacity (4096 records). Do not delete a receipt to force a resend.

No `requestId` means one RPC per invocation and no automatic retry, but callers should supply a stable ID for replay protection. Exactly-once here means **at-most-one dispatch per request ID**, not guaranteed end-user message delivery: extension may acknowledge a click without verifying server delivery. After timeout use read-only chat/status to investigate. The single host-owned bridge and journal are necessary: running two independent Core writers against the same journal is unsupported.

## Verification (isolated, no live browser operations)
- `bun --bun x vitest run tests/delegateCrossApiTabLock.test.ts tests/delegateMultiTabOrchestrator.test.ts tests/delegateMcpExposure.test.ts`: PASS, 36/36 tests in three files (9 new Worker C tests).
- `bun --bun x tsc --noEmit`: PASS on final execution.
- `git diff --check` for Worker C tracked files: PASS.
- The broader `tests/delegate*.test.ts` run is NOT green: legacy `delegate.test.ts` and `delegateMultiClient.test.ts` expect mutation without explicit profile/tab, conflicting with the new intentional fail-closed contract. Other concurrently edited tests `delegateCdpExtension.test.ts` (1.8 version assertion vs 1.9 manifest), `delegateCdpMcpHostRoute.test.ts` (MCP principal error assertion), and `delegateMcpPrincipalBinding.test.ts` (Bun-test runner mixed into Vitest) also fail. Do not consider the full Delegate suite certified until owners update those tests/contracts; no other worker files were edited here.

## Integration caveats
The Core must be rebuilt/restarted separately by the orchestrator after tests/reviews; the currently running Core is not modified. Existing `delegate.read_chat` extension timeout recovery can emit a separate follow-up on unclaimed tabs; use `delegate.peek_chat` for strict read-only reconciliation (the host forces this behavior for claimed tabs). Existing unkeyed `multiTabOrchestrator.newTab` remains non-idempotent if its RPC result is lost; its caller/route does not currently provide a requestId. Host-side MCP policy gates remain necessary and are not replaced by these locks.
