# SuperAgent M4-C — Native Linux RFB Input and Authenticated WebSocket Takeover Audit
Date: 2026-11-02

## Scope and source of truth

- Repository `RudyCity/superagent`, branch `main`.
- Starting base `be0c7021` (M4-B2 lock recovery and local Linux transport smoke).
- **No new worktree, no Git branch.** Pre-existing untracked `artifacts/` preserved.
- Goal: validate interactive RFB input on a real Linux Chrome GUI, and independently verify SuperAgent's operator-gated takeover WebSocket proxy under failures.

## Fixes

1. `src/core/browserTakeover/takeoverWebsocketProxy.ts`:
   - Cleanup callbacks now compare the exact active tunnel record before shutting it down. A delayed close/error event from an old tunnel cannot close a newly connected operator tunnel under the same session ID.
   - Incoming client-to-VNC frames are placed on an ordered, awaited authorization-and-send chain. Each frame is checked against the current operator capability and session state, then forwarded in receipt order. This prevents asynchronous file-backed authorization checks from reordering RFB pointer, keyboard and handshake frames.
   - On unauthorized input or unavailable authorization, input is revoked and the tunnel closes; no browser human hold is released by the proxy.

2. `tests/browserTakeoverWebsocketM4C.test.ts`:
   - Real HTTP upgrade + WebSocket proxy, mock loopback RFB backend, ephemeral ports and isolated persistent session state.
   - Rejects invalid operator capability (401) and cross-origin WebSocket (403).
   - Validates RFB frame forwarding, 20-frame input ordering, only one connection per human session (409), immediate disconnect/reconnect and delayed stale cleanup callbacks.
   - Verifies missing owning Chrome/display fails closed (503).
   - Tests backend failure, transport cleanup, continuing `HUMAN_ACTIVE` session, and authorized reconnect.
   - Tests authentic Return-to-Agent state transition `HUMAN_ACTIVE → VERIFYING`, immediate tunnel revocation and denial of reconnect (401). A separate browser verification must complete before agent control resumes.

3. `scripts/linux-takeover-input-smoke.mjs` and `scripts/linux-takeover-smoke.sh`:
   - Native Ubuntu 24.04 WSL2 Linux Chrome 156 + Xvfb GUI + x11vnc + websockify/noVNC on loopback with ephemeral ports and isolated temporary browser profile.
   - Implements raw RFB 3.8 handshake, security negotiation, ClientInit/ServerInit, one pointer click and one keyboard key event delivered over the WebSocket-to-VNC backend.
   - Chrome DevTools Protocol separately evaluates the local HTML test page and confirms the actual DOM received both pointerdown and keydown; not merely a WS/VNC handshake.
   - Uses Node 22's native WebSocket, auto-cleanup via shell traps, and never contacts public sites. The loopback `-nopw` VNC flag is TEST ONLY and must not be copied to production.

## Verified evidence

- `M4C_LINUX_LOCAL_SMOKE_PASS`: native Linux Chrome/CDP/virtual display/VNC handshake RFB `003.008`.
- `M4C_LINUX_INPUT_PASS`: framebuffer `1280×720`, pointer event count >=1 and observed `a` keypress confirmed by CDP in the actual Chrome page.
- `tests/browserTakeoverWebsocketM4C.test.ts`: **5 passing tests**.
- Final Windows targeted regression: **18 suites, 133 tests passed**, zero failures, after the WebSocket serialization and late-close fixes.
- `bun run build`, `bun run runtime:acceptance`, `bun run security:bun`, `bun run verify:extension-js` (16 extension JS files), `git diff --check`: PASS.
- Repeated Linux WSL native smoke after code changes: `M4C_LINUX_LOCAL_SMOKE_PASS` and `M4C_LINUX_INPUT_PASS`, confirming RFB `003.008`, 1280×720 framebuffer, real pointerdown and `a` keydown in Chrome's DOM via CDP.

## Residual gaps / production verdict

- The Linux GUI input test targets the local websockify endpoint directly; it does NOT bootstrap a production Linux SuperAgent server, does NOT use real operator UI in a browser, and does NOT connect that Linux backend through the complete SuperAgent HTTP/OIDC gateway. The proxy/WebSocket authorization tests use an isolated RFB backend. They validate complementary layers, **not** one fully integrated deployed path.
- Mobile device touch, mobile page reflow, responsive resize, real TLS/OIDC gateway, remote session federation, and multi-host operator isolation are not certified.
- Browser crash/restart mid-input and network partition under a Linux Core process require additional chaos exercises.
- Existing local smoke is intentionally loopback-only, never remotely accessible and never production-grade VNC authentication.

**Verdict: M4-C local Linux interactive input and secured proxy targeted tests PASS; comprehensive Linux Human Takeover E2E / production release remains NO-GO.**
