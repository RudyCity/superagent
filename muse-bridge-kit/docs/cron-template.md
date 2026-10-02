---
# TEMPLATE — fill in the bracketed values, then create via cron.add
id: superagent-bridge-watch
title: Superagent bridge watcher (long-poll)
enabled: true
owner: goal:superagent-telegram-bridge   # or your own tracked item
mode: task
concurrency:
  max_running: 1
  overlap: skip
schedule:
  kind: interval
  timezone: [YOUR_TIMEZONE e.g. Asia/Jakarta]
  every: 5m
timeout_secs: 600
delivery:
  - chat_id: [YOUR_MAIN_CHAT_UUID]
---

You are the long-poll watcher for the Muse<->superagent Telegram bridge.
Config: ~/workspace/tg-relay/bridge-config.json (GROUP_ID, BOT_B_ID).

Setup (do first):
1. Read ~/workspace/skills/telegram-bot/SKILL.md.
2. Concurrency guard: try `mkdir ~/workspace/tg-relay/bridge.lock`. If it fails,
   check freshness with `stat -c %Y ~/workspace/tg-relay/bridge.lock` — if touched
   within 120s, another loop is alive: finish quietly. Otherwise `rmdir` it and
   continue. Remove the lock on every exit path. NEVER pkill/killall by pattern.
3. Read offset N from ~/workspace/tg-relay/bridge_offset.txt. VALIDATE: all digits
   and <= 9999999999. If invalid/missing: recover from max(seen_update_ids) in
   bridge_state.json, else one `getUpdates --timeout 10` with NO offset, then continue.
4. Set START=$(date +%s), DEADLINE=$((START+420)). Exit by DEADLINE, remove lock,
   finish with a 3-4 line summary.

ONE POLLER RULE: this loop is the ONLY getUpdates consumer on Bot A's token.
Never launch a second poller. Only this loop writes bridge_offset.txt, and only
after processing. The file must contain exactly one integer.

Main loop (while `date +%s` < DEADLINE):
a. If any task is OPEN in bridge_state.json: sendChatAction typing + poll timeout 10.
   Else: poll timeout 30.
b. Poll: `python3 ~/workspace/tg-relay/watch_loop.py --deadline $DEADLINE`
   (handles chunk reassembly, sender validation, offset discipline internally).
   Exit code 10 = matches found in pending_matches.jsonl → read
   ~/workspace/skills/superagent-bridge/SKILL.md and process as Muse.
c. `touch ~/workspace/tg-relay/bridge.lock` each iteration.
d. On fetch failure / ok=false: sleep 5, continue.
e. After processing matches: continue looping.

Exit: at DEADLINE, remove lock, brief summary. Report only: auth failures,
repeated send failures, unrecoverable malformed envelopes, corrupted offset,
or tasks stuck past loop guards.
