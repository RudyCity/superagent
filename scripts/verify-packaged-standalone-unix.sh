#!/usr/bin/env bash
# Validate the built macOS/Linux package contents and installed CLI on an ephemeral runner.
set -euo pipefail
repo="apps/superagent-tray/src-tauri/target/release/bundle"
version="$(node -p "require('./package.json').version")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
unset BUN_EXECUTABLE SUPERAGENT_CLI_PATH SUPERAGENT_EXECUTABLE NODE_PATH || true
if [[ "${RUNNER_OS:-}" == "macOS" ]]; then
  shopt -s nullglob
  dmgs=("$repo"/dmg/*.dmg)
  apps=("$repo"/macos/*.app)
  [[ "${#dmgs[@]}" -eq 1 && "${#apps[@]}" -eq 1 ]] || { echo "Expected one DMG and one .app"; exit 1; }
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
  [[ "${#debs[@]}" -eq 1 && "${#appimages[@]}" -eq 1 ]] || { echo "Expected a DEB and an AppImage"; exit 1; }
  dpkg-deb --extract "${debs[0]}" "$tmp"
  test -x "$tmp/usr/bin/superagent"
  test -x "$tmp/usr/bin/bun"
  resources="$(find "$tmp/usr/lib" -type f -path '*/standalone/dist/cli.js' -print -quit)"
  test -n "$resources"
  echo "Validating Linux installed DEB payload without global Bun/Node"
  output="$(PATH=/usr/bin:/bin "$tmp/usr/bin/superagent" --version)"
  [[ "$output" == *"$version"* ]] || { echo "Version mismatch: $output"; exit 1; }
  echo "Linux standalone DEB/AppImage + CLI PASS ($version)"
else
  echo "This check is intended for disposable GitHub macOS/Linux runners"; exit 1
fi
