#!/usr/bin/env bash
# Read-only verifier of the *extracted* native payloads, not just build staging.
# Temporary mounts/extractions are cleaned on exit; no installer is executed.
set -euo pipefail
cd "$(dirname "$0")/.."
repo="apps/superagent-tray/src-tauri/target/release/bundle"
tmp="$(mktemp -d)"
mounted=0
cleanup() {
  if [[ "$mounted" -eq 1 ]]; then hdiutil detach "$tmp/mount" -quiet || true; fi
  rm -rf -- "$tmp"
}
trap cleanup EXIT

audit_tree() {
  local package_root="$1" platform="$2"
  local -a entries=()
  mapfile -d '' entries < <(find "$package_root" -type f -path '*/standalone/dist/cli.js' -print0)
  if [[ "${#entries[@]}" -ne 1 ]]; then
    echo "Expected exactly one standalone Core entrypoint in $package_root" >&2
    exit 1
  fi
  local standalone="${entries[0]%/dist/cli.js}"
  bun scripts/verify-desktop-live-unix-artifacts.ts "$platform" "$standalone"
}

if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
  shopt -s nullglob
  dmgs=("$repo"/dmg/*.dmg)
  [[ "${#dmgs[@]}" -eq 1 ]] || { echo "Expected exactly one DMG" >&2; exit 1; }
  mkdir -p "$tmp/mount"
  hdiutil attach "${dmgs[0]}" -quiet -readonly -nobrowse -mountpoint "$tmp/mount"
  mounted=1
  audit_tree "$tmp/mount" darwin
  echo "DESKTOP_LIVE_MACOS_DMG_CONTENT_PASS"
elif [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]]; then
  shopt -s nullglob
  debs=("$repo"/deb/*.deb)
  images=("$repo"/appimage/*.AppImage)
  [[ "${#debs[@]}" -eq 1 && "${#images[@]}" -eq 1 ]] || {
    echo "Full release requires exactly one DEB and one AppImage" >&2; exit 1;
  }
  mkdir -p "$tmp/deb" "$tmp/image"
  dpkg-deb --extract "${debs[0]}" "$tmp/deb"
  audit_tree "$tmp/deb" linux
  image_path="$(realpath "${images[0]}")"
  (cd "$tmp/image" && "$image_path" --appimage-extract >/dev/null)
  audit_tree "$tmp/image/squashfs-root" linux
  echo "DESKTOP_LIVE_LINUX_DEB_APPIMAGE_CONTENT_PASS"
else
  echo "Requires native Linux x64 or macOS ARM64 host" >&2
  exit 2
fi
