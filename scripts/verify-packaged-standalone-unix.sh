#!/usr/bin/env bash
# Validate portable standalone macOS DMG or Linux DEB on disposable CI runners.
set -euo pipefail
repo="apps/superagent-tray/src-tauri/target/release/bundle"
version="$(node -p "require('./package.json').version")"
tmp="$(mktemp -d)"
mounted=0
cleanup() {
  if [[ "$mounted" -eq 1 ]]; then hdiutil detach "$tmp/mount" -quiet || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
unset BUN_EXECUTABLE SUPERAGENT_CLI_PATH SUPERAGENT_EXECUTABLE NODE_PATH || true
if [[ "${RUNNER_OS:-}" == "macOS" ]]; then
  shopt -s nullglob
  dmgs=("$repo"/dmg/*.dmg)
  [[ "${#dmgs[@]}" -eq 1 ]] || { echo "Expected exactly one macOS DMG"; exit 1; }
  mkdir -p "$tmp/mount"
  hdiutil attach "${dmgs[0]}" -quiet -readonly -nobrowse -mountpoint "$tmp/mount"
  mounted=1
  apps=("$tmp"/mount/*.app)
  [[ "${#apps[@]}" -eq 1 ]] || { echo "Expected exactly one .app inside DMG"; exit 1; }
  app="${apps[0]}"
  test -x "$app/Contents/MacOS/bun"
  test -x "$app/Contents/MacOS/superagent"
  test -f "$app/Contents/Resources/standalone/dist/cli.js"
  test -d "$app/Contents/Resources/standalone/node_modules/ink"
  echo "Validating macOS packaged CLI without global Bun/Node"
  output="$(PATH=/usr/bin:/bin "$app/Contents/MacOS/superagent" --version)"
  [[ "$output" == *"$version"* ]] || { echo "Version mismatch: $output"; exit 1; }
  echo "macOS standalone DMG + CLI PASS ($version)"
elif [[ "${RUNNER_OS:-}" == "Linux" ]]; then
  shopt -s nullglob
  debs=("$repo"/deb/*.deb)
  appimages=("$repo"/appimage/*.AppImage)
  [[ "${#debs[@]}" -eq 1 ]] || { echo "Expected exactly one Linux DEB"; exit 1; }
  if [[ "${REQUIRE_APPIMAGE:-1}" == "1" ]]; then
    [[ "${#appimages[@]}" -eq 1 ]] || { echo "Expected AppImage for full multi-OS gate"; exit 1; }
    [[ -x "${appimages[0]}" ]] || { echo "AppImage is not executable"; exit 1; }
    [[ "$(stat -c%s "${appimages[0]}")" -gt 20000000 ]] || { echo "AppImage is unexpectedly small"; exit 1; }
    image_path="$(realpath "${appimages[0]}")"
    mkdir -p "$tmp/image"
    (cd "$tmp/image" && "$image_path" --appimage-extract >/dev/null)
    image_root="$tmp/image/squashfs-root"
    test -x "$image_root/usr/bin/superagent"
    test -x "$image_root/usr/bin/bun"
    image_cli="$(find "$image_root/usr/lib" -type f -path '*/standalone/dist/cli.js' -print -quit)"
    test -n "$image_cli"
    echo "Validating AppImage-extracted standalone CLI without global Bun/Node"
    image_output="$(PATH=/usr/bin:/bin "$image_root/usr/bin/superagent" --version)"
    [[ "$image_output" == *"$version"* ]] || { echo "AppImage CLI version mismatch: $image_output"; exit 1; }
    echo "Linux standalone AppImage CLI PASS ($version)"
  fi
  dpkg-deb --extract "${debs[0]}" "$tmp/extracted"
  test -x "$tmp/extracted/usr/bin/superagent"
  test -x "$tmp/extracted/usr/bin/bun"
  resources="$(find "$tmp/extracted/usr/lib" -type f -path '*/standalone/dist/cli.js' -print -quit)"
  test -n "$resources"
  echo "Validating Linux installed DEB payload without global Bun/Node"
  output="$(PATH=/usr/bin:/bin "$tmp/extracted/usr/bin/superagent" --version)"
  [[ "$output" == *"$version"* ]] || { echo "Version mismatch: $output"; exit 1; }
  echo "Linux standalone DEB CLI PASS ($version)"
else
  echo "This check is intended for disposable GitHub macOS/Linux runners"; exit 1
fi
