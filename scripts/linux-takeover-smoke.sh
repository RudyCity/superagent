#!/usr/bin/env bash
# Reproducible localhost-only Linux browser/Xvfb/VNC/noVNC handshake smoke.
# Does not contact any production site or change a user's browser profile.
set -euo pipefail

for name in Xvfb google-chrome-stable x11vnc websockify node python3; do
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "M4C_MISSING_DEPENDENCY=$name" >&2
    exit 2
  fi
done

smoke_dir="$(mktemp -d /tmp/sa-linux-takeover-XXXXXX)"
chmod 700 "$smoke_dir"
xvfb_pid="" chrome_pid="" vnc_pid="" web_pid=""
cleanup() {
  result=$?
  if [[ "$result" -ne 0 ]]; then
    for log in "$smoke_dir/xvfb.log" "$smoke_dir/chrome.log" "$smoke_dir/x11vnc.log" "$smoke_dir/websockify.log"; do
      if [[ -e "$log" ]]; then
        printf '\n--- %s (last 14 lines) ---\n' "$log" >&2
        tail -14 "$log" >&2
      fi
    done
  fi
  for pid in "$web_pid" "$vnc_pid" "$chrome_pid" "$xvfb_pid"; do
    if [[ "$pid" =~ ^[0-9]+$ ]]; then kill "$pid" 2>/dev/null || true; fi
  done
  for pid in "$web_pid" "$vnc_pid" "$chrome_pid" "$xvfb_pid"; do
    if [[ "$pid" =~ ^[0-9]+$ ]]; then wait "$pid" 2>/dev/null || true; fi
  done
  rm -rf -- "$smoke_dir"
}
trap cleanup EXIT INT TERM

display_number=121
while [[ -e "/tmp/.X${display_number}-lock" || -S "/tmp/.X11-unix/X${display_number}" ]]; do
  display_number=$((display_number + 1))
  [[ "$display_number" -lt 160 ]] || { echo "M4C_NO_FREE_DISPLAY" >&2; exit 2; }
done
export DISPLAY=":${display_number}"

# Choose three ephemeral listening ports on local loopback only.
read -r cdp_port rfb_port ws_port < <(python3 -c '
import socket
ports=[]
for _ in range(3):
 s=socket.socket()
 s.bind(("127.0.0.1",0))
 ports.append(str(s.getsockname()[1]))
 s.close()
print(*ports)
')

Xvfb "$DISPLAY" -screen 0 1280x720x24 -nolisten tcp >"$smoke_dir/xvfb.log" 2>&1 &
xvfb_pid=$!
sleep 1
kill -0 "$xvfb_pid"

# A GUI browser rendered into Xvfb, not Chrome's headless renderer.
google-chrome-stable --no-sandbox --disable-dev-shm-usage --disable-gpu \
  --no-first-run --no-default-browser-check \
  --user-data-dir="$smoke_dir/chrome" \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port="$cdp_port" \
  --window-size=1280,720 about:blank >"$smoke_dir/chrome.log" 2>&1 &
chrome_pid=$!

env -u WAYLAND_DISPLAY XDG_SESSION_TYPE=x11 x11vnc -display "$DISPLAY" -localhost -rfbport "$rfb_port" \
  -forever -shared -nopw -noxdamage >"$smoke_dir/x11vnc.log" 2>&1 &
vnc_pid=$!

websockify --web=/usr/share/novnc "127.0.0.1:$ws_port" "127.0.0.1:$rfb_port" \
  >"$smoke_dir/websockify.log" 2>&1 &
web_pid=$!

export M4C_CDP_PORT="$cdp_port" M4C_WS_PORT="$ws_port"
# Ubuntu's novnc dependencies may change /usr/bin/node to Node 18, which lacks
# the native WebSocket client. Prefer the user's preinstalled Node 22 when so.
node_bin="$(command -v node)"
if ! "$node_bin" -e 'if (typeof globalThis.WebSocket !== "function") process.exit(1)' >/dev/null 2>&1; then
  if [[ -x "$HOME/.local/bin/node" ]] && \
      "$HOME/.local/bin/node" -e 'if (typeof globalThis.WebSocket !== "function") process.exit(1)' >/dev/null 2>&1; then
    node_bin="$HOME/.local/bin/node"
  else
    echo "M4C_MISSING_NODE_WEBSOCKET_CLIENT: Node 22 or newer required" >&2
    exit 2
  fi
fi
"$node_bin" --input-type=module <<'EOF'
const cdpPort = process.env.M4C_CDP_PORT;
const wsPort = process.env.M4C_WS_PORT;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function waitForJson(url, predicate, seconds = 15) {
  for (let i = 0; i < seconds * 4; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1100) });
      if (r.ok) {
        const json = await r.json();
        if (predicate(json)) return json;
      }
    } catch {}
    await delay(250);
  }
  throw new Error('Linux browser CDP did not become ready: ' + url);
}
const version = await waitForJson('http://127.0.0.1:' + cdpPort + '/json/version', v =>
  typeof v.webSocketDebuggerUrl === 'string');
const pages = await waitForJson('http://127.0.0.1:' + cdpPort + '/json/list', p =>
  Array.isArray(p) && p.some(item => item.type === 'page' && item.id));
const handshake = await new Promise((resolve, reject) => {
  const socket = new WebSocket('ws://127.0.0.1:' + wsPort + '/websockify');
  const timeout = setTimeout(() => { socket.close(); reject(new Error('Timed out waiting for RFB handshake')); }, 12000);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', event => {
    const bytes = event.data instanceof ArrayBuffer ? new Uint8Array(event.data)
      : new TextEncoder().encode(String(event.data));
    const signature = new TextDecoder().decode(bytes.slice(0, 12));
    clearTimeout(timeout);
    socket.close();
    if (!signature.startsWith('RFB 003.')) reject(new Error('Unexpected VNC handshake: ' + signature));
    else resolve(signature.trim());
  });
  socket.addEventListener('error', () => {
    clearTimeout(timeout);
    reject(new Error('WebSocket-to-VNC handshake failed'));
  });
});
console.log(JSON.stringify({
  status: 'M4C_LINUX_LOCAL_SMOKE_PASS',
  platform: process.platform,
  chrome: version.Browser,
  pageCount: pages.filter(p => p.type === 'page').length,
  cdpHost: '127.0.0.1', vncHost: '127.0.0.1', noVncHost: '127.0.0.1',
  rfbHandshake: handshake,
  display: process.env.DISPLAY
}, null, 2));
EOF

# Full GUI input certification (RFB keyboard/mouse delivered to Chrome via
# Xvfb, asserted independently through the local Chrome DevTools Protocol).
"$node_bin" "$(dirname "$0")/linux-takeover-input-smoke.mjs"
