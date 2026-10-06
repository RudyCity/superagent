# Superagent WS Bridge Kit (Muse side)

Self-contained kit to connect Muse (remote AI assistant) to
[superagent](https://github.com/RudyCity/superagent) (terminal AI coding
assistant on your workstation) via Cloudflare Tunnel + WebSocket.

> For the Telegram transport, see `muse-bridge-kit/` instead.
> Full architecture guide: `docs/remote-agent-setup.md`.

## What's inside

| Path | Purpose |
|---|---|
| `listener.py` | Persistent WS client: Bearer auth, auto-reconnect, spools incoming envelopes, pumps queued outgoing batches |
| `bridge.sh` | Manager: `add` / `start` / `stop` / `status` / `send` / `log` |
| `bridges.json.example` | Registry template (copy to `bridges.json`, fill in your tunnel URL) |
| `hooks/ws_chat_inbox.sh` | Optional: hook script that wakes Muse when you send a chat message via `/muse tunnel` |

## Prerequisites

- Python 3.10+ with `websockets` (`pip install websockets`)
- `cloudflared` on the laptop/workstation
- superagent built from this repo (provides the `/muse tunnel` command)

## Setup — laptop side (superagent)

1. In superagent: `/muse tunnel start`
2. Copy the **endpoint** (`wss://<...>.trycloudflare.com/muse`) and the
   **Bearer token** it prints. The token is shown once — treat it like a
   password. The bridge never stores it.

## Setup — Muse side

1. Copy this `bridge/` dir somewhere, e.g. `~/workspace/ws-bridge/`.
2. `python3 -m venv venv && venv/bin/pip install websockets`
3. `cp bridges.json.example bridges.json` and put your tunnel URL in it,
   or: `./bridge.sh add superagent wss://<...>.trycloudflare.com/muse superagent`
4. Start the listener — token via env (transient, never written to disk):
   `BEARER='<paste-token>' ./bridge.sh start superagent`
5. `./bridge.sh log superagent` → expect `CONNECTED, listening for tasks`.

## Sending tasks

Drop a `task_batch` JSON envelope into the outbox:

```bash
./bridge.sh send superagent /path/to/batch.json
```

Results appear under `bridges/superagent/spool/`.

## Chat from the tunnel (v1.5.147+)

- In superagent, press **ESC** while a tunnel is active → menu:
  stop tunnel / send message to Muse / continue.
- Or type directly: `/muse tunnel msg <your message>`.
- Incoming `chat` envelopes land in `bridges/<name>/chat_inbox/`;
  the optional `hooks/ws_chat_inbox.sh` hook wakes an agent to reply.

## MCP via tunnel (v1.6.0+)

Expose Superagent's tools as an MCP server through the tunnel (MCP only — the WSS tunnel is not started):

1. Laptop: `/muse tunnel start --mcp` (options: `--mcp-port <n>`, `--allow-dangerous`).
2. Copy the **MCP endpoint** and **Bearer token** it prints (shown once,
   separate from the Muse bridge token).
3. Point your MCP client at the endpoint with
   `Authorization: Bearer <token>`.

- Default allowlist: 16 safe read-only tools. Destructive tools
  (exec, write, etc.) need `--allow-dangerous`.
- Every tool call is audit-logged (`~/.superagent-r/mcp-audit.log`
  on the laptop).
- Rotate the token: `/muse tunnel restart --mcp`.

### Multi-project (multi-port sessions)

Same pattern as the WS bridges — one superagent instance per project,
each with its own MCP port, tunnel URL, and bearer token:

```bash
# Project A (default port 9227)
/muse tunnel start --mcp
# Project B
/muse tunnel start --mcp --mcp-port 9228
# Project C
/muse tunnel start --mcp --mcp-port 9229
```

Each session prints its own endpoint + bearer. Revoking one project's
token does not affect the others.

## Security notes

- Bearer token: via env only, never committed, never logged.
- One Muse session per bridge (the server rejects a second with 4009).
- Tunnel URLs are ephemeral (quick tunnels rotate) — update `bridges.json`
  and restart the listener when it changes.
