# Native desktop window discovery

Date: 2026-11-08

## Scope

`desktop_ui` and MCP `superagent_desktop_ui` now expose host-local, read-only window discovery on Windows, macOS, and Linux. The existing `probe`, `open`, `snapshot`, `action`, and `close` behavior remains available; discovery does not grant or dispatch native input.

The new commands are:

- `list_windows`: returns visible, usable top-level application windows with `pid`, stable platform `nativeId`, bounded `title`, bounded `application`, `active`, physical screen `bounds`, and a Windows `scaleFactor` when available. Default limit is 50 and the hard limit is 100. `truncated` tells the caller that additional usable windows were not returned. Screenshot bytes are never included.
- `get_active_window`: returns the positively identified foreground/active window or `null`. It never selects a best guess.
- `find_window`: performs a bounded case-insensitive substring match against `application` and `title`, with an optional exact positive PID filter. A title match is discovery metadata only and never authorizes input or inspection.
- `inspect_window`: requires an exact positive `pid` plus exact `nativeId` that must be present in a fresh discovery pass. It opens a principal-bound session with `allowInput: false`, captures the existing semantic accessibility schema, optionally returns screenshot base64 only when `includeScreenshotImage=true`, and closes the session in `finally`. Screenshot bytes remain capped at 2 MiB by the existing snapshot limit.

MCP keeps `superagent_desktop_ui` classified as dangerous because the same tool also contains native input operations. An authenticated MCP principal is required, and `ssh:` / `chain:` workspaces remain fail-closed before native discovery or inspection. Local discovery uses the existing local-agent principal.

## Platform identity and filtering

### Windows

Discovery uses `EnumWindows`, `GetForegroundWindow`, `GetWindowThreadProcessId`, root-window validation, physical `GetWindowRect`, per-monitor-v2 DPI awareness, and `GetDpiForWindow`. It does not use `Get-Process.MainWindowHandle` for enumeration.

The provider excludes invisible windows, non-root HWNDs, shell desktop/tray classes, DWM-cloaked windows, empty windows, windows without a readable application process name, and windows with non-zero display affinity. The latter avoids returning windows explicitly marked for protected/excluded capture. Only the process name is exposed; executable paths and command lines are not collected.

A disposable WinForms host acceptance test verifies real `EnumWindows` discovery, exact PID/HWND identity, bounds/DPI, UIAutomation inspection, no screenshot bytes by default, and ephemeral-session cleanup.

### macOS

Discovery requires both Accessibility and Screen Recording privacy grants. System Events supplies AX application/window metadata; CoreGraphics supplies `CGWindowNumber`. A candidate is returned only when the AX window maps unambiguously to one layer-zero CoreGraphics window owned by the same PID and matching bounds. Ambiguous candidates are skipped and counted in `skippedAmbiguous`.

`active=true` requires the process to be frontmost and the AX window to be focused or main. Missing privacy access, missing identity, or ambiguous identity fails closed. This implementation was source/mocked-provider verified on the Windows development host; a real macOS host was not available for certification in this milestone.

### Linux / Ubuntu

Discovery enumerates AT-SPI desktop applications and top-level `frame`, `window`, or `dialog` nodes. Stable identity remains compatible with the existing adapter: `atspi:<pid>:<title>`. Because that identity cannot distinguish two top-level AT-SPI windows with the same PID and title, duplicate PID/title candidates are omitted and reported through `skippedAmbiguous`; target lookup, accessibility inspection, and input lookup now also fail closed when that selection is ambiguous.

Linux screenshot capture remains active-window-only. Therefore `inspect_window` can discover a background window but may return `TARGET_NOT_ACTIVE` when the existing screenshot stage cannot safely capture it. Wayland input remains disabled, and unknown session types are not inferred as X11. This implementation was source/mocked-provider verified on the Windows development host; a real Linux/Ubuntu host was not available for certification in this milestone.

## Security properties

Discovery provider processes are launched through the existing restricted process runner with `shell:false`; model strings are passed through JSON environment payloads rather than interpolated into shell commands. Discovery and inspection expose no raw-coordinate input path and never call adapter `dispatch`.

`inspect_window` performs a fresh bounded discovery and requires exact PID/native ID equality before opening its short-lived read-only session. The session is bound to the caller principal and is always closed in `finally`, including snapshot failures. Existing input consent, exact revision/SHA-256 freshness checks, active-window requirements, and semantic element targeting remain unchanged.

Window titles, application names, and discovery queries are redacted by the desktop structured-log sanitizer. Screenshot image fields, tokens, and typed text keep their existing redaction. The public command result intentionally returns title/application metadata because those fields are the requested discovery output; no process path or command line is returned.

New discovery commands enforce command-specific allowed fields in addition to the local/MCP schemas using `additionalProperties: false`. In particular, `inspect_window` does not accept `title`, `allowInput`, action fields, or coordinates, and `find_window` does not turn a title/application match into authorization.

## Verification

The dedicated suite under `tests/desktop-ui-discovery/` covers bounded limits and truncation, provider duplicate rejection, application/title matching, exact PID targeting, stale native IDs, local routing, MCP principal binding, remote SSH/chain denial, extra-field rejection, explicit screenshot behavior, session cleanup on success and failure, native provider script contracts, and a real disposable Windows WinForms host.
