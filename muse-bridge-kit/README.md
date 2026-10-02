# Superagent Bridge Kit (Muse side)

Self-contained kit to connect Muse (this VM) to [superagent](https://github.com/RudyCity/superagent)
(a terminal AI coding assistant) via a private Telegram group. Copy this kit to any
Muse account, run setup, and the bridge works.

## What's inside

| Path | Purpose |
|---|---|
| `setup.py` | Interactive setup — collects bot/group IDs, writes `bridge-config.json` |
| `bridge-config.example.json` | Template (no secrets) |
| `skills/superagent-bridge/SKILL.md` | The bridge skill: protocol, prompt caching, operating rules |
| `skills/telegram-bot/` | Telegram Bot API CLI (`bin/tg.py`) + skill doc |
| `tg-relay/watch_loop.py` | Long-poll watcher segment (chunk reassembly, sender validation) |
| `tg-relay/prompt_cache/` | Prompt cache dir (populated at runtime) |
| `docs/cron-template.md` | Watcher cron job template |
| `docs/superagent-setup.md` | Laptop-side setup guide for superagent |

## Setup (Muse side)

1. Copy this kit somewhere, e.g. `~/workspace/superagent-bridge-kit/`.
2. Run `python3 setup.py` and answer the prompts:
   - Bot A = Muse's bot (create via @BotFather). **Token goes in Muse's secure vault, never in a file.**
   - Bot B = superagent's bot (created on the laptop side).
   - Private group with both bots as admins + Bot-to-Bot Communication Mode enabled.
3. Copy `skills/superagent-bridge/` → `~/workspace/skills/superagent-bridge/`
4. Copy `skills/telegram-bot/` → `~/workspace/skills/telegram-bot/`
5. Copy `tg-relay/watch_loop.py` → `~/workspace/tg-relay/watch_loop.py`
   (and `bridge-config.json` → `~/workspace/tg-relay/bridge-config.json`)
6. Create the cron from `docs/cron-template.md` (fill in timezone + chat_id).
7. On the laptop, follow `docs/superagent-setup.md`.
8. Test: send `/muse hai` from superagent. Muse should reply via the bridge.

## How it works

```
laptop (superagent)                Telegram group               Muse (this VM)
     |                                  |                              |
     |-- task_request (Bot B) --------->|                              |
     |                                  |--(cron watcher polls)------->|
     |                                  |                              |-- reason
     |                                  |<-- task_batch (Bot A) -------|
     |<--(watcher polls, executes)------|                              |
     |-- task_result (Bot B) ---------->|                              |
     |                                  |--(cron watcher polls)------->|
     |                                  |                              |-- reason
     |                                  |<-- task_done (Bot A) --------|
```

- Long polling only, no public ports.
- Envelopes: plain JSON (≤3800 chars) or `MUSEBUS <id> <n>/<N>\n<chunk>`.
- Prompt caching: full `system_prompt` sent only when its hash changes.
- One poller per bot token (HTTP 409 otherwise).

## Files the bridge owns (don't touch manually)

- `~/workspace/tg-relay/bridge_offset.txt` — exactly one integer, written by watcher only
- `~/workspace/tg-relay/bridge_state.json` — task tracking
- `~/workspace/tg-relay/bridge.lock` — concurrency guard (directory)
- `~/workspace/tg-relay/prompt_cache/` — cached system prompts by hash
