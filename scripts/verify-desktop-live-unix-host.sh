#!/usr/bin/env bash
# Fail early for a wrong runner architecture / too-old macOS SDK.
set -euo pipefail
if [[ "${RUNNER_OS:-}" == "macOS" ]]; then
  [[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || {
    echo "ScreenCaptureKit packaging needs a native macOS ARM64 runner" >&2; exit 2;
  }
  command -v xcrun >/dev/null
  xcrun --find swiftc >/dev/null
  sdk_version="$(xcrun --sdk macosx --show-sdk-version)"
  major="${sdk_version%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$major" -ge 14 ]] || {
    echo "ScreenCaptureKit requires macOS SDK 14 or newer (found $sdk_version)" >&2; exit 2;
  }
  echo "DESKTOP_LIVE_MACOS_ARM64_SDK_PASS $sdk_version"
elif [[ "${RUNNER_OS:-}" == "Linux" ]]; then
  [[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
    echo "X11 helper packaging needs a Linux x64 runner" >&2; exit 2;
  }
  test -x /usr/bin/python3
  echo "DESKTOP_LIVE_LINUX_X64_HOST_PASS"
else
  echo "Set RUNNER_OS to macOS or Linux on a native runner" >&2
  exit 2
fi
