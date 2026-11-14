#!/usr/bin/env bash
# Package the fixed Linux X11 exact-window worker; never install packages.
set -euo pipefail
if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "Linux x64 host required" >&2; exit 2
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SOURCE="$ROOT/native/desktop-live-x11/linuxCapture.py"
if [[ ! -f "$SOURCE" || -L "$SOURCE" ]]; then
  echo "X11 helper source missing or not a regular file" >&2; exit 2
fi
/usr/bin/python3 -c 'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read(),filename=sys.argv[1])' "$SOURCE"
out="$ROOT/dist/native/desktop-live-x11"
mkdir -p "$out"
stage="$(mktemp -d "$out/.x11-build.XXXXXXXX")"
trap 'rm -rf -- "$stage"' EXIT
cp -- "$SOURCE" "$stage/linuxCapture.py"
if ! cmp -s -- "$SOURCE" "$stage/linuxCapture.py"; then
  echo "X11 worker source changed during packaging" >&2; exit 2
fi
chmod 644 "$stage/linuxCapture.py"
sha256sum "$stage/linuxCapture.py" | awk '{print $1}' > "$stage/linuxCapture.sha256"
chmod 644 "$stage/linuxCapture.sha256"
# The verifier requires both regular files and a matching digest; it rejects
# any transient mixed pair while these individually atomic renames complete.
mv -f -- "$stage/linuxCapture.py" "$out/linuxCapture.py"
mv -f -- "$stage/linuxCapture.sha256" "$out/linuxCapture.sha256"
echo "LINUX_X11_WORKER_BUILD_PASS sha256=$(cat "$out/linuxCapture.sha256")"
