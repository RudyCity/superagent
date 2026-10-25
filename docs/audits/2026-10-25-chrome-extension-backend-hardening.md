# Chrome Extension ↔ SuperAgent backend hardening (2026-10-25)

## Scope
Reviewed and modified the sidepanel HTTP/SSE transport, the separate Remote Chrome Bridge, browser-control callback routing, subagent event isolation, CDP launch flags, and Manifest V3 debugger monitoring.

## P0 fixed
- Sidepanel uses header-authenticated streaming fetch instead of putting the backend bearer in an EventSource query. The generic sidepanel fetch wrapper only appends privileged headers to the configured backend origin.
- Server request logs omit query strings and workspace paths; broadcast logs no longer persist raw streamed events or browser-control credentials.
- Browser-control requests use cryptographically random IDs plus one-time 256-bit response capabilities. Results require the matching capability (constant-time comparison).
- The server no longer broadcasts browser execution commands when a selected extension is missing. Without an explicit instance ID it dispatches only if exactly one live sidepanel connection exists; otherwise it fails closed.
- Sidepanel SSE instance teardown is tied to response closure and cannot remove a newer instance that reused the same key.
- Agent event, question, approval, subagent log/prompt/result, and other sensitive event types require a matching session or workspace. Legacy unscoped tool-progress broadcasting was disabled rather than revealing process-wide tool output.
- Subagent/superagent completion notifications now carry owning session/workspace metadata.

## P1 fixed
- Remote Bridge token is stored in Chrome session-only storage to survive MV3 worker suspension. On token mismatch it is purged and fetched again.
- The loopback token endpoint is paired to a Chrome extension origin and supports reconnects; other extension origins are rejected. Optionally set `SUPERAGENT_REMOTE_EXTENSION_ID` to pin a specific installed extension ID.
- Multiple authenticated Remote Bridge clients require exact `profileId` selection; ambiguous client dispatch fails closed. Each Remote extension persists a stable random client ID.
- Remote WebSocket limits incoming payloads to 16 MiB, and unknown actions throw instead of reporting fake success.
- Chrome launches no longer include `--remote-allow-origins=*`. Unattended media capture is disabled unless explicitly opted in (`SUPERAGENT_UNATTENDED_SCREEN_CAPTURE=1` for the shared CDP launcher, or explicit tool argument for the profile launcher).

## P2 fixed
- Remote Chrome debugger monitoring is off by default and may be enabled explicitly in the extension popup. Instrumentation is restricted to the active tab and previously monitored tabs are detached on tab changes / disable.
- Extension syntax verification dynamically covers all JavaScript files in both unpacked extension directories instead of eight hardcoded files.
- Added `tests/chromeExtensionHardening.test.ts`; updated `tests/remoteChromeBridgeAuth.test.ts` for paired-origin reconnect.

## Compatibility and remaining limitations
- The Remote Bridge token endpoint's Origin header check guards browser-based cross-origin requests; a privileged or malicious local process can forge an Origin header. Stronger protection against hostile *same-machine* processes requires an out-of-band pairing secret or Native Messaging, not just loopback networking. Pin `SUPERAGENT_REMOTE_EXTENSION_ID` where possible.
- Both extensions deliberately retain broad host/API permissions needed for cross-tab browser automation. Removing them wholesale would break advertised tools. Future optional per-site permission grants can reduce exposure further.
- Native Chrome-extension E2E (unpacked extension loaded, profile-specific reconnect, browser restart) was not verified during this run. The inspected CDP profile did not expose an installed extension service worker.
- The live port 7888/9223 process was running from globally installed `superagent/dist/cli.js`, not the workspace source. Source build does not deploy it. An orderly deployment + extension reload is required; the active Chrome/CDP and tunnels were not restarted or force-closed.
- Existing historic logs might contain older SSE bearer URLs; do not copy them into issue trackers. Rotate affected credentials when deploying. The fix prevents future logging from the updated runtime.

## Verification
- `bun run build`
- `bun run verify:extension-js` (16 JS files across two extensions)
- `bun --bun x vitest run tests/server.test.ts tests/serverAuth.test.ts tests/chromeExtensionHardening.test.ts tests/remoteChromeBridgeAuth.test.ts tests/remoteChromeBridge.test.ts tests/sessionEventScope.test.ts tests/chromeCdpMultiAgent.test.ts tests/chromeCdpSharedTab.test.ts`: 111/111 passed at initial hardening validation.
- `git diff --check` (no whitespace errors; existing CRLF warnings on Windows).
