#!/usr/bin/env bash
# Native opt-in ScreenCaptureKit window-only helper. No downloads or restarts.
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "macOS ARM64 host required" >&2; exit 2
fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
SOURCE="$ROOT/native/desktop-live-sck/macosCapture.swift"
SWIFTC="$(xcrun --find swiftc)"
if [[ ! -f "$SOURCE" || ! -x "$SWIFTC" ]]; then echo "Swift source/toolchain missing" >&2; exit 2; fi
scratch_base="${TMPDIR:-/tmp}"
SCRATCH="$(mktemp -d "${scratch_base%/}/superagent-sck.XXXXXXXX")"
cleanup() { rm -rf -- "$SCRATCH"; }
trap cleanup EXIT
"$SWIFTC" -O -parse-as-library -target arm64-apple-macos14.0 \
  -framework ScreenCaptureKit -framework CoreGraphics -framework AppKit \
  -framework ImageIO -framework UniformTypeIdentifiers "$SOURCE" -o "$SCRATCH/sck"
test -s "$SCRATCH/sck"
file "$SCRATCH/sck" | grep -q "Mach-O 64-bit executable arm64"
# Refuse universal and arm64e-only executables; this is a single arm64 payload.
test "$(lipo -archs "$SCRATCH/sck")" = "arm64"
size="$(stat -f "%z" "$SCRATCH/sck")"
if (( size < 65536 || size > 8388608 )); then echo "SCK executable size invalid" >&2; exit 2; fi
out="$ROOT/dist/native/desktop-live-sck"
mkdir -p "$out"
cp "$SCRATCH/sck" "$out/sck"
chmod 755 "$out/sck"
shasum -a 256 "$out/sck" | awk '{print $1}' > "$out/sck.sha256"
echo "SCK_MACOS_ARM64_BUILD_PASS bytes=$size sha256=$(cat "$out/sck.sha256")"
