# Muse MCP Workflows

## 1. Check whether two-way chat is ready

Use this when you want to know if SuperAgent can currently hold a back-and-forth conversation with Muse over the authenticated WebSocket tunnel.

```json
{
  "name": "superagent_muse_chat_status",
  "arguments": {
    "port": 9225
  }
}
```

The result reports whether a Muse watcher is active, whether the transport is WebSocket, whether the client is connected, and whether direct chat is available.

## 2. Restart the Muse tunnel

Use this only when the Muse WebSocket tunnel needs a clean restart.

```json
{
  "name": "superagent_muse_tunnel_restart",
  "arguments": {
    "port": 9225
  }
}
```

This only touches the verified Muse tunnel, not the MCP HTTP server.

## 3. Send a Telegram message to Muse

Use this when you need the Telegram transport, not a live WebSocket conversation.

```json
{
  "name": "superagent_telegram_send_to_muse",
  "arguments": {
    "text": "Please check the current tunnel status."
  }
}
```

## 4. Talk to Muse over MCP and wait for a reply

Use this for actual two-way conversation when the Muse WebSocket transport is connected.

```json
{
  "name": "superagent_muse_chat",
  "arguments": {
    "text": "What is the current state of the remote agent?",
    "port": 9225,
    "timeoutMs": 30000
  }
}
```

This sends a single chat envelope and waits for a correlated reply using `reply_to`. If Muse does not answer in time, the tool returns a timeout instead of pretending the conversation succeeded.

## What to use when

- Use `superagent_muse_chat_status` to check readiness.
- Use `superagent_muse_tunnel_restart` to repair the tunnel.
- Use `superagent_telegram_send_to_muse` for Telegram delivery.
- Use `superagent_muse_chat` for direct back-and-forth conversation over WebSocket.
