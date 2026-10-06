#!/usr/bin/env bash
# Multi-bridge manager for WS superagent bridges.
# Usage:
#   bridge.sh add <name> <ws_url> [project]  - register a bridge
#   BEARER=<token> bridge.sh start <name>    - start listener (BEARER via env only, never stored)
#   bridge.sh stop <name>                    - stop listener
#   bridge.sh status                         - list bridges + running listeners
#   bridge.sh send <name> <file>             - queue a batch JSON into the bridge outbox
#   bridge.sh log <name>                     - tail the bridge log
set -euo pipefail
BASE="$HOME/workspace/ws-bridge"
REG="$BASE/bridges.json"
VENV="$BASE/venv/bin/python"

cmd="${1:-}"; shift || true

reg_get() { python3 -c "
import json
d = json.load(open('$REG'))
for b in d.get('bridges', []):
    if b['name'] == '$1': print(b['$2']); break
"; }

case "$cmd" in
  add)
    name="$1"; url="$2"; project="${3:-$name}"
    python3 - "$name" "$url" "$project" "$REG" <<'EOF'
import json, sys
reg = sys.argv[4]
d = json.load(open(reg))
d.setdefault('bridges', [])
d['bridges'] = [b for b in d['bridges'] if b['name'] != sys.argv[1]]
d['bridges'].append({'name': sys.argv[1], 'ws_url': sys.argv[2], 'project': sys.argv[3]})
json.dump(d, open(reg, 'w'), indent=2)
print('registered', sys.argv[1])
EOF
    ;;
  start)
    name="$1"
    url="$(reg_get "$name" ws_url)"
    [ -z "$url" ] && { echo "unknown bridge: $name"; exit 1; }
    [ -z "${BEARER:-}" ] && { echo "BEARER env required"; exit 1; }
    # stop existing first
    "$0" stop "$name" 2>/dev/null || true
    mkdir -p "$BASE/bridges/$name"
    cd "$BASE"
    BEARER="$BEARER" WS_URL="$url" BRIDGE="$name" nohup "$VENV" listener.py > "bridges/$name/stdout.log" 2>&1 &
    echo "started $name (pid $!)"
    ;;
  stop)
    name="$1"
    pids=$(pgrep -f "listener.py" || true)
    stopped=0
    for p in $pids; do
      if tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -q "^BRIDGE=$name$"; then
        kill "$p" && echo "stopped $name (pid $p)" && stopped=1
      fi
    done
    [ "$stopped" = 0 ] && echo "no running listener for $name"
    ;;
  status)
    python3 -c "
import json
d = json.load(open('$REG'))
for b in d.get('bridges', []):
    print(f\"{b['name']}: {b.get('project','')} {b['ws_url'][:50]}...\")
"
    echo "--- running ---"
    for p in $(pgrep -f "listener.py" 2>/dev/null || true); do
      bname=$(tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep '^BRIDGE=' | cut -d= -f2 || true)
      url=$(tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep '^WS_URL=' | cut -d= -f2- || true)
      echo "pid $p bridge=${bname:-(legacy)} url=${url:0:60}"
    done
    true
    ;;
  send)
    name="$1"; file="$2"
    dest="$BASE/bridges/$name/outbox/"
    mkdir -p "$dest"
    cp "$file" "$dest"
    echo "queued -> $dest"
    ;;
  log)
    name="$1"
    tail -30 "$BASE/bridges/$name/listener.log" 2>/dev/null || tail -30 "$BASE/listener.log"
    ;;
  *)
    echo "usage: bridge.sh {add|start|stop|status|send|log} ..."; exit 1
    ;;
esac
