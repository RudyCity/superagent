#!/usr/bin/env bash
# Wakes an agent when the laptop user sends a chat message via /muse tunnel.
# Watches ~/workspace/ws-bridge/bridges/*/chat_inbox/*.json for new files.
# State: ~/hooks/state/ws-chat-inbox/seen (basenames already surfaced).
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

STATE_DIR="$HOME/hooks/state/ws-chat-inbox"
SEEN_FILE="$STATE_DIR/seen"
mkdir -p "$STATE_DIR"
touch "$SEEN_FILE"

newest=""
for inbox in "$HOME"/workspace/ws-bridge/bridges/*/chat_inbox; do
  [ -d "$inbox" ] || continue
  for f in "$inbox"/*.json; do
    [ -f "$f" ] || continue
    base=$(basename "$f")
    if ! grep -qxF "$base" "$SEEN_FILE" 2>/dev/null; then
      newest="$f"
      echo "$base" >> "$SEEN_FILE"
    fi
  done
done

if [ -n "$newest" ]; then
  payload=$(python3 - "$newest" <<'PYEOF'
import json, sys
p = sys.argv[1]
try:
    d = json.load(open(p))
except Exception:
    d = {}
bridge = p.split("/bridges/")[1].split("/")[0] if "/bridges/" in p else "?"
print(json.dumps({"file": p, "bridge": bridge, "text": str(d.get("text", ""))[:800]}))
PYEOF
)
  wake "tunnel chat message from laptop user" "$payload"
else
  silent "no new tunnel chat messages" '{}'
fi
