# 2026-11-06 — MCP → Core Delegate forwarded-principal attestation (Worker A)

## Scope and operational status

**IMPLEMENTED / activation requires refreshed Core + MCP generations.** Signing, verification, in-memory anti-replay, authenticated MCP dispatcher integration, Core route verification, and private lifecycle bootstrap are now wired. The Core supervisor owns one in-memory forwarding channel for its lifetime, provisions each worker verifier over parent/child IPC before HTTP readiness, and exposes the same material to authenticated reloadable MCP backends only through a private local IPC socket. No forwarding key is persisted to disk, environment variables, HTTP headers, extension JavaScript, or logs.

The existing Core bearer gate authenticates a local API caller, **not** the originating OAuth/MCP client. The old route accepts `{name, arguments}` and does not prove MCP-origin principal identity. MCP now refuses to forward without a trusted identity *and* an explicit bridge signing key. The owner-side route must independently reject unsigned requests before dispatch; until Worker C changes that route, an authenticated old-format API caller may still reach the old handler.

## Protocol: v1 exact binding

The MCP sender calls `runWithTrustedDelegateForwardingConnection(identity, task)` from the verified server dispatcher, using only `getIdentity()` and `connectionBrainSessionId`. `signDelegateForwardedRequest(name, args)` is only usable inside that private async context.

It emits `{ name, arguments, attestation }`, where attestation is HMAC-SHA256 domain-separated under a randomly generated 256-bit channel key with a fresh 192-bit nonce. The MAC covers:

- Protocol version, audience, channel generation ID, issued time, nonce.
- Authenticated transport session ID, auth mode, keyed pseudonym of the authenticated subject, and the MCP principal computed from the session ID.
- Exact tool name, resolved command/client profile/tab/target ID/transport, and the SHA-256 of canonical JSON argument bytes.

The verifier rejects unrecognized fields, unbound/malformed targets, changed argument values, nested selector conflicts, changed tool/command/profile/tab/transport, stale (over 30s) and excessive future (over 10s) timestamps, invalid MACs, and replayed nonces. The owner replay cache holds at most 4096 outstanding nonces; when saturated it **rejects** new requests rather than evicting unexpired entries. The session principal is per authenticated MCP connection, not merely an OAuth username; reconnect does not inherit its previous ownership token.

No private key, bearer token, raw OAuth subject or chat message is included in error codes. The subject pseudonym is HMAC-keyed, avoiding easy dictionary reversal of email-like usernames.

## Trusted lifecycle bootstrap

The implemented bootstrap is intentionally separate from the public Core HTTP API:

1. A fresh Core supervisor creates one random 256-bit forwarding channel in memory for that supervisor lifetime.
2. Every supervisor-owned Core worker is created with a parent/child IPC channel. Before the worker opens its HTTP server, it announces its generation ID, receives the verifier material over that IPC channel, installs it once, and acknowledges the exact channel ID.
3. The Core supervisor exposes a private local IPC socket whose path is bound to the public Core port and supervisor PID. Reloadable MCP backends authenticate to that socket with the existing private supervisor control lease read from the mode-0600 discovery record. The forwarding key itself never enters that record.
4. The MCP backend installs or rotates its signer from the IPC-delivered material. Repeating the same channel is idempotent; reusing a channel ID with different key bytes is rejected.
5. The MCP backend keeps the socket open. If the supervisor is replaced, disconnect triggers bounded rediscovery/reconnect and signer rotation to the new supervisor channel.
6. Core worker blue-green restart/rollback under the same supervisor reuses the supervisor-lifetime channel, avoiding an unsafe signing/verifying cutover race while retained workers remain part of the same trusted supervisor domain.
7. If the private broker, verifier bootstrap, or authenticated MCP principal is unavailable, forwarding remains fail-closed with `DELEGATE_FORWARD_BRIDGE_NOT_PROVISIONED` or the sanitized host-route denial.

A loopback HTTP endpoint gated only by the normal Core bearer is still not used for key exchange.

## Core host-route integration

Update only the existing `/api/delegate/mcp-dispatch` branch:

1. Keep local socket/Host/Origin/method checks and Core bearer gate; these are *additional* defenses.
2. Raise the wire body limit from 105,000 to about 112,000 bytes to accommodate the signed envelope while maintaining the canonical argument cap of 105,000 bytes.
3. Before **any** invocation of `handleControlChromeCdp`, `handleControlChromeVision`, or `delegate*Tool.execute`, the route calls `withVerifiedDelegateForwardedPrincipal(data, async verified => { ... })`. Every branch uses `verified.name` and `verified.arguments`. The verifier validates the exact signed envelope and consumes the nonce before tool execution.
4. Reject missing/invalid/unprovisioned attestation with a generic `403 DELEGATE_FORWARD_ATTESTATION_REQUIRED` (or sanitized verifier error code); never enter the existing tool-selection logic on failure. **Do not** allow a legacy unsigned fallback for discovery/read-only tools.
5. Existing host argument validation and protected Delegate-CDP authorization still apply **inside** the authenticated callback. This attestation is identity transport, not blanket authorization. Vision mutation remains separately restricted by the existing policy.
6. Add route-level fake-host regression tests: old bearer + no attestation must not execute, different-session spoof, replay, changed tab/profile/command, and unprovisioned verifier must not call any host tool. Full end-to-end isolation can only be asserted after these and a verified bootstrap integration test pass.

Example callback contract (pseudocode only — do not paste without reorganizing the route's existing return structure):

```ts
const result = await withVerifiedDelegateForwardedPrincipal(data, async verified => {
  // Validate and dispatch using verified.name + verified.arguments only.
  // The MCP principal is active inside the callback and across awaits.
  return await dispatchExistingHostTool(verified.name, verified.arguments);
});
```

## Worker A changed paths

- `src/core/browserTransport/delegateForwardedPrincipal.ts` (new): canonical encoding, HMAC envelope, bounded replay cache, process-private install APIs, trusted forwarded-scope wrapper.
- `src/core/mcp/tools/delegateMcpTools.ts`: signed proxy body and fail-closed forwarding for MCP Delegate chat and browser/CDP.
- `src/core/mcp/tools/chromeMcpTools.ts`: transport-authenticated identity enters the private forwarding context.
- `src/core/mcp/superagentMcpServer.ts`: both Delegate and Chrome MCP dispatchers get the **same** verified connection identity; unrelated MCP tool routing preserved.
- `tests/delegateForwardedPrincipal.test.ts` (new): pure spoof/replay/tab/profile/transport/clock/reconnect/chain-generation tests, no live Core.

**Tests:** 16/16 isolated Vitest tests passed, 9/9 Bun principal-binding tests passed. Two pre-existing legacy-forwarding Vitest files yielded 7 passed / 6 failed because they expect unsigned or unprovisioned forwarding to succeed; these must be rewritten as authenticated bootstrap/attestation tests by the owning integration worker.  `bun --bun x tsc --noEmit` passed. No Core or Tray lifecycle action, no key provisioning, no live API calls, no browser tab changes, no commits/pushes. These tests verify the cryptographic/helper boundary only and **do not** constitute production-ready end-to-end security verification.


## 2026-11-06 lifecycle completion update

- Added `src/core/runtime/delegateForwardingLifecycle.ts` for the private supervisor broker, Core-worker verifier handshake, and MCP signer subscription/reconnect.
- Core workers now use a real IPC-capable child channel and cannot report HTTP readiness before verifier installation succeeds.
- Reloadable MCP backends subscribe without blocking unrelated MCP tools when Core is temporarily absent; Delegate operations remain fail-closed until the signer is provisioned.
- Signed host wire limit is 112,000 bytes while canonical tool arguments remain capped at 105,000 bytes.
- Verification after implementation: TypeScript `--noEmit` passed; 57 focused Vitest Delegate tests passed; 9 Bun principal-binding tests passed; Core supervisor safety tests and reloadable MCP owner tests passed.
- Existing recovered/adopted Core workers from a crashed prior supervisor cannot receive a new verifier through the lost parent IPC. A recovered supervisor publishes its fresh broker immediately, so Delegate forwarding remains fail-closed while an adopted worker is active and becomes usable after an explicit restart creates a worker provisioned by that recovered supervisor.


## 2026-11-06 bottleneck hardening update

The post-provisioning audit closed the remaining Delegate/Core lifecycle bottlenecks without weakening the authenticated principal boundary:

1. **Dynamic Core endpoint resolution.** MCP Delegate forwarding no longer embeds port 7888 at dispatch call sites. delegateCoreEndpoint.ts prefers explicit configuration, otherwise exactly one live authenticated supervisor discovery record, and fails closed on multi-Core ambiguity.
2. **Session-principal tab affinity.** Explicitly selected or newly created ChatGPT tabs can be reused within the same authenticated MCP transport session. Observed tabs never become write authorization, and affinity is intentionally not persisted across OAuth reconnects because multiple orchestrators can share the same OAuth subject.
3. **History recovery without browser-history permission.** If the inactive ChatGPT sidebar worker yields zero rows, Core falls back to existing Delegate-CDP target discovery for currently open /c/<chatId> tabs. Message indexing prefers side-effect-free peek_chat, then a guarded Delegate 1.9.0 doctor -> read_chat compatibility path only when no delivery-timeout/retry state is present, then an audited read-only CDP evaluation. No fallback navigates the user's active tab.
4. **Conservative generation retirement.** Normal workers still require two quiescence inspections. Pre-isolation retained generations have a separate narrow compatibility gate that only accepts the two historical helper blockers with every runtime metric at zero and a released Delegate listener. A dedicated core retire-legacy-retained command performs the same double proof before authenticated graceful shutdown; it never taskkills an arbitrary PID.
5. **Vision ownership separation.** New supervised Core workers are API-only and never own fixed-port Vision. Vision remains an independent lifecycle, preventing the first Core generation from becoming permanently undrainable.
6. **Recovered-worker cleanup.** Future recovered/adopted workers use authenticated graceful shutdown after the same double drain proof; the supervisor never signals an adopted PID directly.
7. **MCP backend recovery and runtime telemetry.** Reloadable MCP owner source now rate-limits automatic current-backend recovery while preserving owner and public URL. Core freshness reports source/dist drift as degraded instead of release-ready, and service diagnostics distinguish watchdog configuration from owner-managed recovery.
8. **Guardian coverage.** A managed Guardian is attached to the currently verified Core supervisor so a future supervisor loss uses authenticated checkpoint recovery rather than an unsupervised replacement.

### Verification

- verify:delegate: **152/152** tests passed across 15 files.
- MCP authenticated-principal boundary: **9/9** Bun tests passed.
- Core lifecycle and legacy-retirement regression set: **28/28** tests passed.
- Service manager/watchdog: **21/21** tests passed.
- Reloadable MCP owner crash-recovery suite: **4/4** tests passed.
- TypeScript --noEmit, production build, and git diff --check: passed.
- Final compiled Core build activated on the live worker: 5f901ad0bfbadfe9296a8eb3e658aa186ae12ed8d8929009aed7d6cacc2e94c2, source digest 6afe368651ef8734adb278ac7a9f9a98bb15ca49745d932546ba7ae2a6ed92ea, fresh=true.
- Reloadable MCP backend was updated in place while preserving the existing public URL https://arch-promo-jack-forgotten.trycloudflare.com/mcp.
- Managed Guardian is active and owner-verified against the live Core supervisor.

### Live Delegate/history evidence

The connected profile is Rudy Delegate CDP and currently advertises delegate-semantic-v1 plus delegate-cdp-v1. The loaded unpacked Chrome extension still reports **1.9.0**; no hot-reload is claimed.

Core-side compatibility is nevertheless live: a forced sync indexed **4 open chats / 16 messages / 0 unavailable**. search_index returned a real message match for the query dynamic tools, proving that message content, not only chat metadata, is indexed.

Delegate extension source/release is **1.9.2**. The deterministic release archive was regenerated with SHA-256 2f6a426eafc82a9a1f76c047d2904ad1e62dff9803f54770ea61dab5cf2c74b3. Chrome must explicitly reload the unpacked extension before its in-browser source changes report 1.9.2; the running Core compatibility path does not depend on that reload.

### Legacy retained-generation closure

The pre-hardening retained Core worker PID 12924 and its Vision child tree were retired through the guarded graceful-retirement path after two quiescence proofs and Delegate-listener verification. Subsequent OS process inspection confirmed PID 12924, its command-shell child, and the Python Vision child are all absent.

The still-running pre-upgrade supervisor keeps a **dead metadata tombstone** for PID 12924 in its in-memory retained list. This is not a live process/resource leak. Removing that tombstone would require replacing the supervisor process itself; forcing that replacement on Windows would violate the no-force lifecycle contract. The source now removes dead retained metadata, and the attached Guardian ensures the next legitimate supervisor recovery loads the corrected implementation and checkpoint logic.


## 2026-11-06 final live verification

The hardening changes were validated against the running Rudy Delegate CDP profile after Core and MCP backend activation.

- Core forwarding bootstrap is live and verified; the active compiled worker build is a177fbd9655a17afe15eb2ef529e5ba840927d6440ac446338a3ed98f5c50a43.
- The independent Core Guardian is active and ownership-verified.
- Rudy Delegate CDP remains connected with semantic and Delegate-CDP capabilities. The currently loaded extension is 1.9.0; Core compatibility fallbacks keep history discovery/indexing functional without forcing an extension reload.
- History synchronization now succeeds when the sidebar history worker is unavailable: open ChatGPT conversation targets are discovered through Delegate-CDP, read through a fenced audited read-only path, and indexed without navigation or send actions. Final live sample: 4 listed, 4 indexed, 0 unavailable, 24 messages in the local index.
- The public MCP URL remained unchanged while backend generations were reloaded.
- verify:delegate passes 152/152 tests; principal-boundary Bun tests pass 9/9; managed Guardian E2E passes; TypeScript, build, and git diff --check pass.

Two runtime artifacts are intentionally preserved rather than force-terminated:

1. The long-lived Core supervisor still reports one already-exited pre-hardening worker as retained metadata. The process itself is gone and has no pinned affinity sessions. A live supervisor owner hot-swap was experimentally evaluated but rejected because its E2E recovery path was not reliable enough; the experimental code was fully reverted. This tombstone is not used for request routing.
2. The reloadable MCP owner currently retains multiple backend generations because live MCP sessions remain pinned to their origin generations. Owner replacement was not forced because it would disrupt those sessions and could replace the Cloudflare Quick Tunnel URL. Current backend reload remains URL-stable.

These are deliberate safety holds, not Delegate forwarding blockers. No PID kill, session replay, browser-tab closure, or public-tunnel replacement was used to hide them.
