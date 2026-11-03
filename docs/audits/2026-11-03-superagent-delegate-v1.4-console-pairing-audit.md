# SuperAgent Delegate v1.4.0 — console pairing & connection audit

Date: 2026-11-03 (Asia/Jakarta)
Workspace: `D:\backup from pc asus\Documents Development\superagent`
Branch: `main`
Scope: `src/core/delegate/` and `chrome-extension-delegate/` only, plus focused tests and release documentation.

## Operator workflow

1. Start a single SuperAgent server with `bun dist/cli.js --server 7888` after rebuilding. No manual secret file or token export is required.
2. The local Delegate listener at `127.0.0.1:17341` generates a 256-bit in-memory secret and prints an eight-character, one-time code to the **server console only**:
   `[Delegate][PAIR] Kode: XXXX-XXXX | berlaku 10 menit, sekali pakai | masukkan di popup Delegate`.
3. Install/reload the Delegate extension in Chrome, switch ON, paste the code into **Kode pairing dari terminal**, press **Pair**.
4. After a successful pairing, the server returns a unique random 256-bit token to that Chrome profile only. The extension stores it in trusted local Chrome storage. This profile can reconnect with the same token while the server process remains active.
5. A *new* code is printed immediately for the next Chrome profile. Codes expire after 10 minutes, and a new code is printed on expiry. Five failed attempts per minute trigger temporary lockout.
6. Restarting a server using fileless ephemeral credentials invalidates previously issued browser tokens. Each Chrome must pair again. Optional explicit env/file keys preserve the older manual static configuration, but are not required.

## Structured connection audit

Console events and daily JSONL under `~/.superagent-r/logs/delegate-connections-YYYY-MM-DD.jsonl` include:

- UTC timestamp, event name, unique `connectionId`, server PID, bound listener endpoint/port
- Remote loopback IP and remote port, browser extension ID and version, client ID, profile label, sanitized browser user agent
- Auth mode and verification outcome; handshake/connection duration
- Number of active profiles, sockets, pending RPCs, WebSocket close code and bounded failure reason
- Origin rejected, socket opened, pairing accepted, connected, renamed, rejected, disconnected, listener shutdown and transport errors

The submitted code, issued token, static master secret, headers, cookies, chat content and tool parameters are **never intentionally logged**. Audit appends are serialized to preserve order; normal bridge shutdown flushes pending writes. The code itself appears only in the private server console, not the structured audit file. Protect terminal access and any redirected stdout logs while the ten-minute code is valid.

## Verification

- Unit tests cover two Chrome profiles, exact target routing, token mismatch, one-time-code consumption, short-code form flow, per-profile token storage, reconnect, global failure limit, refusal of cross-origin client takeover, and absence of secrets in connection audit objects.
- TypeScript typecheck, syntax validation, full Delegate discovery regression and SuperAgent build must pass.
- Separate live local WebSocket smoke check confirms `NODE_ENV=production` startup with no manually managed secret, challenge/response pairing, connection/disconnection lifecycle written to JSONL, and no submitted code or issued token in the file.
- Versioned deterministic package `superagent-delegate-1.4.0.zip` and receipt are generated under `build/releases/`.

## Production boundaries

This release supports a **single local SuperAgent agent-host process** and up to eight Chrome profiles. The fixed loopback listener is not safe to expose on public networks. Cloud/horizontal multi-worker routing and end-to-end tests of browser `send_message` / `stop_generation` remain separate release gates, unchanged from v1.3.0. Do not call this a hosted public production deployment solely because the local pairing and logging smoke tests pass.

## Rollback

Stop SuperAgent cleanly, restore the previous matching server/extension bundle, restart and verify read-only `delegate.read_chat` before permitting new message mutations. A browser may need to pair again after rollback. Never resend an ambiguous send or expose a pairing code in issue trackers.
