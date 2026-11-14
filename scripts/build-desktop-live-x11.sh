#!/usr/bin/env bash
# Build fixed Linux X11 exact-active-window worker; never install packages.
set -euo pipefail
if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "Linux x64 host required" >&2; exit 2
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SOURCE="$ROOT/native/desktop-live-x11/linuxCapture.py"
if [[ ! -f "$SOURCE" ]]; then echo "X11 helper source missing" >&2; exit 2; fi
/usr/bin/python3 -c 'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read(),filename=sys.argv[1])' "$SOURCE"
out="$ROOT/dist/native/desktop-live-x11"
mkdir -p "$out"
cp "$SOURCE" "$out/linuxCapture.py"
chmod 644 "$out/linuxCapture.py"
sha256sum "$out/linuxCapture.py" | awk '{print $1}' > "$out/linuxCapture.sha256"
echo "LINUX_X11_WORKER_BUILD_PASS sha256=$(cat "$out/linuxCapture.sha256")"
