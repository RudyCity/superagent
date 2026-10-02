---
name: "telegram_bot"
description: "Use Telegram Bot when the user asks for Telegram Bot or this provider's API."
---

# Telegram Bot

## Purpose
Use Telegram Bot with the user-connected `custom.telegram-bot` credential.

## Tooling
CLIs live under `~/workspace/skills/telegram-bot/bin/`:
- `tg.py getMe` — verify the bot identity.
- `tg.py getUpdates [--offset N] [--timeout 30]` — poll incoming messages.
- `tg.py sendMessage <chat_id> <text>` — send a text message.
- `tg.py sendDocument <chat_id> <file_path> [caption]` — send a file.

Python CLIs must import `/opt/hatch/skills/skill-creator/bin/dynamic_credentials.py`
and build the API URL with the **raw (not URL-encoded) surrogate** in the path:
`https://api.telegram.org/bot{surr}/METHOD`. The helper
`url_with_surrogate_path_segment` URL-encodes the surrogate, which breaks the
egress proxy's literal `hsurr:*` replacement (Telegram then 404s). Use
`read_json_response(resp)` from the same helper to parse responses. Send only
`hsurr:*` values, and only to `api.telegram.org`.

## Auth
The credential is already stored; nothing here collects one. Never ask the user to paste a raw key in chat, set a secret environment variable, pass a secret flag, or write an auth file.

A 401 or 403 is a question about the request before it is a question about the key. Check that the credential was attached at all: a request built without the helpers named under Tooling carries nothing, and that looks exactly like a wrong or under-scoped token. Only once a request that did carry the credential is still rejected, call `credentials.request_api_access` with `reconnect` to replace it. The connector is stored as `custom.telegram-bot`.

## Operating Rules
1. Use this skill when the user asks for Telegram Bot or this provider's API.
2. Restrict authenticated requests to: api.telegram.org.
3. Do not print, log, or persist raw credentials.
4. If auth is missing or rejected, follow the Auth section rather than asking for a key.
