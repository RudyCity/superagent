# 2026-11-06 — MCP → Core Delegate forwarded-principal attestation (Worker A)

## Scope and operational status

**PARTIAL / NO-GO for production.** Worker A implemented pure signing, verification, in-memory anti-replay and authenticated MCP dispatcher integration in the five assigned code files. The existing Core `/api/delegate/mcp-dispatch` route belongs to Worker C; its mandatory verifier integration is **not implemented by Worker A**. The lifecycle does not currently provide a verified private key bootstrap. **Do not attempt a Core/Tray restart to activate this code.**

The existing Core bearer gate authenticates a local API caller, **not** the originating OAuth/MCP client. The old route accepts `{name, arguments}` and does not prove MCP-origin principal identity. MCP now refuses to forward without a trusted identity *and* an explicit bridge signing key. The owner-side route must independently reject unsigned requests before dispatch; until Worker C changes that route, an authenticated old-format API caller may still reach the old handler.

## Protocol: v1 exact binding

The MCP sender calls `runWithTrustedDelegateForwardingConnection(identity, task)` from the verified server dispatcher, using only `getIdentity()` and `connectionBrainSessionId`. `signDelegateForwardedRequest(name, args)` is only usable inside that private async context.

It emits `{ name, arguments, attestation }`, where attestation is HMAC-SHA256 domain-separated under a randomly generated 256-bit channel key with a fresh 192-bit nonce. The MAC covers:

- Protocol version, audience, channel generation ID, issued time, nonce.
- Authenticated transport session ID, auth mode, keyed pseudonym of the authenticated subject, and the MCP principal computed from the session ID.
- Exact tool name, resolved command/client profile/tab/target ID/transport, and the SHA-256 of canonical JSON argument bytes.

The verifier rejects unrecognized fields, unbound/malformed targets, changed argument values, nested selector conflicts, changed tool/command/profile/tab/transport, stale (over 30s) and excessive future (over 10s) timestamps, invalid MACs, and replayed nonces. The owner replay cache holds at most 4096 outstanding nonces; when saturated it **rejects** new requests rather than evicting unexpired entries. The session principal is per authenticated MCP connection, not merely an OAuth username; reconnect does not inherit its previous ownership token.

No private key, bearer token, raw OAuth subject or chat message is included in error codes. The subject pseudonym is HMAC-keyed, avoiding easy dictionary reversal of email-like usernames.

## Required trusted lifecycle bootstrap (not implemented)

Only a verified owner/supervisor can provision bridge material. A safe design:

1. On each fresh **Core generation**, trusted lifecycle owner calls `generateDelegateForwardedChannelMaterial()`. Keep the 32-byte key and channel ID only in private process memory.
2. Deliver the *same material* to the authorized MCP process over verified, access-controlled **private supervisor IPC** (process identity, generation binding, and peer authentication are required). Do not distribute through a public/bearer-authenticated API endpoint, client headers, tool arguments, extension JS, env file, disk journal, or application logs.
3. In Core, call `installDelegateForwardedVerifier(material)` before opening the dispatch route. In the verified MCP process, call `installDelegateForwardedSigner(material)` before forwarding. These are one-shot process-local setters and reject silent replacement. If Core and MCP truly run in the same trusted process, the owner may call both directly.
4. A Core replacement, rollback, or MCP owner replacement **must mint a new channel generation and revoke the old one**. No fallback to a previous key, old bearer, or stale nonce cache.
5. If any stage is absent or the owner identity is uncertain, keep forwarding disabled. These functions deliberately do not self-provision and do not use `getServerAuthToken()` as the attestation key.

A loopback HTTP endpoint gated only by the existing Core bearer is **not** a verified key exchange. Adding such an endpoint would reintroduce caller spoofing.

## Mandatory Worker C integration: src/serverRoutes.ts (ownership respected)

Update only the existing `/api/delegate/mcp-dispatch` branch:

1. Keep local socket/Host/Origin/method checks and Core bearer gate; these are *additional* defenses.
2. Raise the wire body limit from 105,000 to about 112,000 bytes to accommodate the signed envelope while maintaining the canonical argument cap of 105,000 bytes.
3. Before **any** invocation of `handleControlChromeCdp`, `handleControlChromeVision`, or `delegate*Tool.execute`, call the exported `withVerifiedDelegateForwardedPrincipal(data, async verified => { ... })` from `core/browserTransport/delegateForwardedPrincipal.js`. Every branch must use `verified.name` and `verified.arguments`, not an alternative mutable parsed object. The verifier validates the exact `{name, arguments, attestation}` structure and consumes the nonce before tool execution. Preserve the authenticated principal scope across every awaited tool operation.
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
