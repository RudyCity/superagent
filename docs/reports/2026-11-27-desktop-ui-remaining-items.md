# Desktop UI: remaining items, evidence and plans

**Date:** 2026-11-27
**Status (updated 2026-11-28):** items 1-8, 10, 11, 12 and 13 are implemented. Item 9 (macOS/Linux
carriers) is a validated spec that needs those hosts; the OS-level sandbox from item 6 remains open
and is now documented, with evidence and accepted residual risk, in section 6a.
Windows now prefers one native host (capture + UIA); all PowerShell paths stay as fallback.
**Related:** [Desktop UI live-window input](../guides/desktop-ui-live-window-input.md)

## 13. Workspace permission (ACL) escalation — evidence

The one-shot DSH ACL diagnosis/repair was run unconfined (not elevated) against the
workspace root and its ancestors. Verdict: **NOT_THIS_CLASS**, zero changes.

| Object | Owner | Effective rights |
|---|---|---|
| `…\superagent` | signed-in user | FullControl, WRITE_DAC, WRITE_OWNER |
| `…\Documents Development` | signed-in user | WRITE_DAC, no WRITE_OWNER |
| `D:\backup from pc asus` | signed-in user | WRITE_DAC, no WRITE_OWNER |
| `D:\` | Administrators | none for this user |

No AppContainer package SIDs (`S-1-15-2-*`) and no missing workspace right were found;
the folder does carry a **low mandatory label**. Report:
`C:\Users\USER\.superagent-r\acl-recovery\acl-report-233f4960eb7b48b088da87a90b82a083.jsonl`

### Escalation text (send with the report)

> DSH fails to provision its workspace grant with `SetNamedSecurityInfoW` / Win32 5 on
> `D:\backup from pc asus\Documents Development\superagent`. The authorised ACL repair
> reports `NOT_THIS_CLASS`: the workspace root already grants this user FullControl plus
> WRITE_DAC and WRITE_OWNER, no package ACL entries exist, and the only anomaly is a low
> mandatory label on the folder. Please check DSH's own ACL provisioning path (and its
> interaction with the low integrity label) rather than the folder ACL.
> Report: `<path above>`.

Until then, the session can run with **full access** to avoid per-command escalation.

## 5. Single native Desktop UI host — implemented (Windows)

`native/desktop-host/` (C#, built by `scripts/build-desktop-host.ps1` into
`dist/native/desktop-host/`) now serves both PrintWindow capture and the UIAutomation tree over
one JSON-lines protocol. Core verifies the fixed artifact (PE x64, size bounds, sha256 sidecar),
performs a nonce handshake, enforces 2 MB line caps and a 15 s timeout, and silently falls back to
the persistent PowerShell carrier and then the audited one-shot script when the host is absent or
refuses.

| Window | Host capture | Host inspect | Elements | Previous path |
|---|---|---|---|---|
| Windows Terminal | 75-112 ms | 178-194 ms | 36 | capture 1040-1078 ms, inspect 249-253 ms, 30 |
| DeepSeek Harness (Electron) | 247-403 ms | 1166-1397 ms | 360 | capture 1278-1410 ms, inspect 2059-3218 ms, 360 |

Protocol hardening verified live: malformed JSON exits 4, oversized line exits 3, three unknown
commands exit 3, missing nonce exits 5 with no ready line, invalid target returns an error and keeps
the host alive, `close` exits 0, stderr always empty. Renaming the artifact directory restores the
PowerShell behaviour exactly.

Known gaps: the .NET Framework csc image is 28,160 bytes, so the artifact size floor is 16 KB and
the exact sha256 (not the size) is the pin; the build is repeatable but not bit-reproducible.
Release packaging now **builds or verifies** the pair and stages it at
`standalone/dist/native/desktop-host/` (prepare/verify fail closed on a missing, oversized,
non-PE-x64 or digest-mismatched pair); the installed-host smoke on a disposable Windows runner
remains the final gate.

## 6. Sandboxing the carrier

**Partially implemented:** the native host and the PowerShell carriers now enforce a nonce
handshake, strict framing (2 MB line cap), protocol-violation self-exit after 3 errors, request
serialization and idle close. Remaining: OS-level containment (AppContainer / Job Object with a
restricted token and low integrity), which requires a native launcher and kernel-level verification.

Original plan:

- Launch inside a Job Object with a restricted token and a low integrity level.
- Bind each request to a per-connection nonce and reject replayed frames.
- Cap stdout framing (already bounded) and add a watchdog that kills the carrier after
  N consecutive protocol violations.
- Acceptance: a carrier that is fed a forged request cannot capture or inspect a window
  it was not started for; kernel-level containment verified with Process Explorer.

## 9. Persistent carriers for macOS and Linux — implementation spec

The Windows carriers already define the reusable contract: a fixed helper process, one
JSON line per request, per-request window re-validation, idle close, strict size caps and
fail-open only to the audited one-shot path. Port that contract, not the Windows code.

### Shared client contract (platform neutral)

| Line | Direction | Payload |
|---|---|---|
| `{"type":"ready","nonce":"<env nonce>"}` | helper -> Core | must echo the nonce Core passed by environment; mismatch closes the helper |
| `{"cmd":"capture","pid":N,"windowId":"..."}` | Core -> helper | exactly one frame |
| `{"type":"frame","png":"<base64>","window":{pid,windowId,title,active,scaleFactor,bounds}}` | helper -> Core | bounded base64 (2 MB line) |
| `{"cmd":"inspect","pid":N,"windowId":"..."}` | Core -> helper | accessibility tree |
| `{"type":"elements","window":{...},"elements":[...],"warnings":[]}` | helper -> Core | same element shape as Windows |
| `{"cmd":"close"}` / EOF | Core -> helper | orderly exit |

Rules that must be identical on every platform: serialize requests, 15 s timeout, idle
close after 60 s, exit non-zero after 3 protocol violations, never accept a path or script
from a caller, and re-validate the window identity inside every capture/inspect.

### macOS helper (Swift, AX)

- `AXUIElementCreateApplication(pid)` + `AXUIElementCopyAttributeValue` for role, title,
  description, value, position, size, focused, enabled; skip offscreen elements but keep
  them as non-actionable context only when labelled.
- Window identity: `CGWindowID` from `AXWindowNumber` plus pid; capture with
  `CGWindowListCreateImage` restricted to that window id (no screen-wide capture).
- Permission: `AXIsProcessTrustedWithOptions` must be checked per request; a missing
  Accessibility grant fails closed with `ACCESSIBILITY_UNAVAILABLE`.

### Linux helper (Python, AT-SPI2)

- `pyatspi`/D-Bus AT-SPI registry: resolve the application by pid, walk
  `get_child_at_index` up to the same depth/caps, map `getRoleName`, `name`,
  `description`, `query_component().get_extents()`.
- Capture only the target window: X11 `xwd -id <window>` or Wayland portal
  `org.freedesktop.portal.Screenshot` with the existing consent policy; no full-screen grab.
- Respect the existing Wayland consent and portal-owner checks; a missing portal fails
  closed to the one-shot path.

### Acceptance criteria

1. Warm snapshot < 600 ms on macOS and Linux for a static window; cold < 2 s.
2. Parity tests: element shape, identity re-validation, nonce mismatch, protocol
   violation exit, idle close, fallback to one-shot when the helper is absent.
3. No platform helper is started unless the operator session is interactive and the
   target window is approved by the existing policy/RBAC gates.
4. CI: macOS and Linux runners with a graphical session (or an explicit skip with the
   documented reason where no display is available).

## 9. Persistent carriers for macOS and Linux

`macos.ts` and `linux.ts` still spawn a helper per snapshot (~1 s). The Windows carrier
protocol is already platform neutral. Plan:

1. Port the JSON-lines carrier loop to a small Swift (AX) and Python (AT-SPI) helper.
2. Reuse `windowsAccessibilityHost`'s framing, timeouts, idle close and fail-open-to-
   one-shot behaviour as the shared client contract.
3. Acceptance: warm snapshot < 600 ms on macOS and Linux, parity tests in CI where
   runners have a graphical session.

## 10. CI-safe native E2E — implemented

`tests/desktop-ui-discovery/windows-winforms.e2e.test.ts` now runs four tests: two are
focus-independent (discovery/geometry/capture/screenshot/accessibility/session) and always run, two
are foreground-authority tests that skip with a concrete capability reason unless
`SUPERAGENT_E2E_REQUIRE_FOCUS=1` requests attended certification. A bounded pre-flight names the
missing precondition instead of failing an assertion diff, and `test:e2e` was fixed to select nested
e2e files (`vitest run e2e`).

Verified on this host: default mode 3 passed / 1 skipped; strict mode fails closed with "Windows
reports no foreground window" (expected from this non-interactive window station). `studioRealMediaE2E`
now skips only its encoder-dependent render assertions with an explicit reason when ffmpeg is absent;
the remaining `bun run test:e2e` failure is unrelated (`lanNetworkSegmentE2E`, real on-link UDP
segment unavailable on this host).

## 13. Workspace permission (ACL) escalation — evidence

The one-shot DSH ACL diagnosis/repair was run unconfined (not elevated) against the
workspace root and its ancestors. Verdict: **NOT_THIS_CLASS**, zero changes.

| Object | Owner | Effective rights |
|---|---|---|
| `…\superagent` | signed-in user | FullControl, WRITE_DAC, WRITE_OWNER |
| `…\Documents Development` | signed-in user | WRITE_DAC, no WRITE_OWNER |
| `D:\backup from pc asus` | signed-in user | WRITE_DAC, no WRITE_OWNER |
| `D:\` | Administrators | none for this user |

No AppContainer package SIDs (`S-1-15-2-*`) and no missing workspace right were found;
the folder does carry a **low mandatory label**. Report:
`C:\Users\USER\.superagent-r\acl-recovery\acl-report-233f4960eb7b48b088da87a90b82a083.jsonl`

### Escalation text (send with the report)

> DSH fails to provision its workspace grant with `SetNamedSecurityInfoW` / Win32 5 on
> `D:\backup from pc asus\Documents Development\superagent`. The authorised ACL repair
> reports `NOT_THIS_CLASS`: the workspace root already grants this user FullControl plus
> WRITE_DAC and WRITE_OWNER, no package ACL entries exist, and the only anomaly is a low
> mandatory label on the folder. Please check DSH's own ACL provisioning path (and its
> interaction with the low integrity label) rather than the folder ACL.
> Report: `<path above>`.

Until then, the session can run with **full access** to avoid per-command escalation.

## 5. Single native Desktop UI host — implemented (Windows)

`native/desktop-host/` (C#, built by `scripts/build-desktop-host.ps1` into
`dist/native/desktop-host/`) now serves both PrintWindow capture and the UIAutomation tree over
one JSON-lines protocol. Core verifies the fixed artifact (PE x64, size bounds, sha256 sidecar),
performs a nonce handshake, enforces 2 MB line caps and a 15 s timeout, and silently falls back to
the persistent PowerShell carrier and then the audited one-shot script when the host is absent or
refuses.

| Window | Host capture | Host inspect | Elements | Previous path |
|---|---|---|---|---|
| Windows Terminal | 75-112 ms | 178-194 ms | 36 | capture 1040-1078 ms, inspect 249-253 ms, 30 |
| DeepSeek Harness (Electron) | 247-403 ms | 1166-1397 ms | 360 | capture 1278-1410 ms, inspect 2059-3218 ms, 360 |

Protocol hardening verified live: malformed JSON exits 4, oversized line exits 3, three unknown
commands exit 3, missing nonce exits 5 with no ready line, invalid target returns an error and keeps
the host alive, `close` exits 0, stderr always empty. Renaming the artifact directory restores the
PowerShell behaviour exactly.

Known gaps: the .NET Framework csc image is 28,160 bytes, so the artifact size floor is 16 KB and
the exact sha256 (not the size) is the pin; the build is repeatable but not bit-reproducible.
Release packaging now **builds or verifies** the pair and stages it at
`standalone/dist/native/desktop-host/` (prepare/verify fail closed on a missing, oversized,
non-PE-x64 or digest-mismatched pair); the installed-host smoke on a disposable Windows runner
remains the final gate.

## 6. Sandboxing the carrier

**Partially implemented:** the native host and the PowerShell carriers now enforce a nonce
handshake, strict framing (2 MB line cap), protocol-violation self-exit after 3 errors, request
serialization and idle close. Remaining: OS-level containment (AppContainer / Job Object with a
restricted token and low integrity), which requires a native launcher and kernel-level verification.

Original plan:

- Launch inside a Job Object with a restricted token and a low integrity level.
- Bind each request to a per-connection nonce and reject replayed frames.
- Cap stdout framing (already bounded) and add a watchdog that kills the carrier after
  N consecutive protocol violations.
- Acceptance: a carrier that is fed a forged request cannot capture or inspect a window
  it was not started for; kernel-level containment verified with Process Explorer.

## 9. Persistent carriers for macOS and Linux — implementation spec

The Windows carriers already define the reusable contract: a fixed helper process, one
JSON line per request, per-request window re-validation, idle close, strict size caps and
fail-open only to the audited one-shot path. Port that contract, not the Windows code.

### Shared client contract (platform neutral)

| Line | Direction | Payload |
|---|---|---|
| `{"type":"ready","nonce":"<env nonce>"}` | helper -> Core | must echo the nonce Core passed by environment; mismatch closes the helper |
| `{"cmd":"capture","pid":N,"windowId":"..."}` | Core -> helper | exactly one frame |
| `{"type":"frame","png":"<base64>","window":{pid,windowId,title,active,scaleFactor,bounds}}` | helper -> Core | bounded base64 (2 MB line) |
| `{"cmd":"inspect","pid":N,"windowId":"..."}` | Core -> helper | accessibility tree |
| `{"type":"elements","window":{...},"elements":[...],"warnings":[]}` | helper -> Core | same element shape as Windows |
| `{"cmd":"close"}` / EOF | Core -> helper | orderly exit |

Rules that must be identical on every platform: serialize requests, 15 s timeout, idle
close after 60 s, exit non-zero after 3 protocol violations, never accept a path or script
from a caller, and re-validate the window identity inside every capture/inspect.

### macOS helper (Swift, AX)

- `AXUIElementCreateApplication(pid)` + `AXUIElementCopyAttributeValue` for role, title,
  description, value, position, size, focused, enabled; skip offscreen elements but keep
  them as non-actionable context only when labelled.
- Window identity: `CGWindowID` from `AXWindowNumber` plus pid; capture with
  `CGWindowListCreateImage` restricted to that window id (no screen-wide capture).
- Permission: `AXIsProcessTrustedWithOptions` must be checked per request; a missing
  Accessibility grant fails closed with `ACCESSIBILITY_UNAVAILABLE`.

### Linux helper (Python, AT-SPI2)

- `pyatspi`/D-Bus AT-SPI registry: resolve the application by pid, walk
  `get_child_at_index` up to the same depth/caps, map `getRoleName`, `name`,
  `description`, `query_component().get_extents()`.
- Capture only the target window: X11 `xwd -id <window>` or Wayland portal
  `org.freedesktop.portal.Screenshot` with the existing consent policy; no full-screen grab.
- Respect the existing Wayland consent and portal-owner checks; a missing portal fails
  closed to the one-shot path.

### Acceptance criteria

1. Warm snapshot < 600 ms on macOS and Linux for a static window; cold < 2 s.
2. Parity tests: element shape, identity re-validation, nonce mismatch, protocol
   violation exit, idle close, fallback to one-shot when the helper is absent.
3. No platform helper is started unless the operator session is interactive and the
   target window is approved by the existing policy/RBAC gates.
4. CI: macOS and Linux runners with a graphical session (or an explicit skip with the
   documented reason where no display is available).

## 9. Persistent carriers for macOS and Linux

`macos.ts` and `linux.ts` still spawn a helper per snapshot (~1 s). The Windows carrier
protocol is already platform neutral. Plan:

1. Port the JSON-lines carrier loop to a small Swift (AX) and Python (AT-SPI) helper.
2. Reuse `windowsAccessibilityHost`'s framing, timeouts, idle close and fail-open-to-
   one-shot behaviour as the shared client contract.
3. Acceptance: warm snapshot < 600 ms on macOS and Linux, parity tests in CI where
   runners have a graphical session.

## 10. CI-safe native E2E

`windows-winforms.e2e` requires exclusive desktop focus and fails whenever another window
is foreground. Options, in order of cost:

1. Dedicated window station/desktop for the fixture (`CreateDesktop`) so focus is isolated.
2. Deterministic animated fixture app plus a focus guard that fails with a clear skip
   reason instead of a spurious assertion.
3. Keep adapter-level animation fixtures (already in `tests/desktop-ui/session-live-frames.test.ts`)
   as the CI default and treat native E2E as an attended certification step.

Acceptance: `bun run test:e2e` is green on a clean Windows runner without a human at the
machine, and the attended run is separately labelled as certification.

## 6a. Privilege hardening, bounded lifetime and rotation — implemented (2026-11-28)

The native host now refuses to run elevated and removes every token privilege it does not need
before it touches a window (`native/desktop-host/PrivilegeGuard.cs`).

| Control | Implementation | Live evidence |
|---|---|---|
| Elevation refusal | `GetTokenInformation(TokenElevation)` on the process token; elevated -> typed `{"type":"error","code":"ELEVATED_TOKEN"}` and exit 7 | ready line reports `"elevated":false` |
| Privilege removal | `AdjustTokenPrivileges` with `SE_PRIVILEGE_REMOVED` (plain disable as fallback) for SeDebug, SeImpersonate, SeTakeOwnership, SeLoadDriver, SeTcb, SeAssignPrimaryToken, SeIncreaseQuota, SeBackup, SeRestore, SeShutdown; any removal failure -> typed `PRIVILEGE_HARDENING_FAILED`, exit 8 | ready line reports `"privilegesRemoved":1` on a non-elevated medium token: only the one dangerous privilege actually present in that token (a standard user token holds `SeShutdownPrivilege`) needed stripping; the other nine report `ERROR_NOT_ALL_ASSIGNED` and are therefore absent from the token |
| Kept privilege | `SeChangeNotifyPrivilege` stays enabled: the CLR and file/registry traversal need it and it grants no capture/UIA reach | source plus native contract test |
| Bounded request count | default 500, override `SUPERAGENT_DESKTOP_HOST_MAX_REQUESTS` (1..1,000,000) | capped live run exits 0 with a `rotating` line |
| Bounded lifetime | default 600,000 ms, override `SUPERAGENT_DESKTOP_HOST_MAX_LIFETIME_MS` (1..86,400,000) | idle watchdog + in-band pre-request check, covered by injected-double tests |
| Planned exit | typed `rotating` line with `reason` = `request-cap` or `lifetime` and `served` count, written in-band **before** the over-cap request is served, then exit 0 | live: `rotating:request-cap`, exit 0 |
| Client rotation | `windowsDesktopHost.ts` respawns and re-issues that exact request once, counts rotations, exposes `rotationCount` / `servedRequestCount` and the `onRotation` hook; a second rotation fails permanently and the adapter falls back | live: 8 commands, 2 rotations, 0 fallbacks, 0 crash restarts |

Operational consequence: an elevated Core (or a caller that elevates the helper) loses the native
host by design — the refusal arrives as a typed line and the adapter silently falls back to the
audited PowerShell carriers, which fail closed on UIPI-blocked targets. Elevation is never required
to capture or inspect the user's own same-integrity windows.

Live verification (2026-11-28, Windows Terminal, pid 38664 / hwnd 8982872, forced cap 3 = rotate after
every 3 served commands; 4 capture+inspect pairs = 8 commands):

| Operation | Pair 1 | Pair 2 | Pair 3 | Pair 4 |
|---|---|---|---|---|
| capture | 172.9 ms | 162.2 ms | 142.4 ms | 395.6 ms (rotation before capture 4) |
| inspect | 346.9 ms | 384.6 ms (rotation before inspect 2) | 151.1 ms | 316.5 ms |

8 requests served, 2 transparent `request-cap` rotations, 8 frames, 0 crash restarts, host remained
available, image 119,432 bytes, 36 normalized elements. A second adapter run forced the cap only
through the environment (`SUPERAGENT_DESKTOP_HOST_MAX_REQUESTS=3`, no code override): 4 commands,
1 transparent rotation, both snapshots valid (36 elements each), host available, 1,173.9 ms total for
two capture+inspect pairs.

Header/protocol evidence from the same build
(`sha256=242804d327984ca66aa2b95eb2623b32e9194b66c4ead359712bb4df3f0d4623`, size 36,352 bytes):
missing nonce exits 5 with no stdout; `MAX_REQUESTS=0` and a non-numeric lifetime are typed
`HOST_CONFIG_INVALID` + exit 9; malformed JSON is `PROTOCOL_MALFORMED` + exit 4; an oversized command
line exits 3; an invalid target returns `TARGET_NOT_FOUND` and the host keeps serving; `close` exits 0;
stderr always empty. Lifetime is enforced both in-band (with `MAX_LIFETIME_MS=1` a request immediately
gets `rotating:lifetime` + exit 0) and by the idle watchdog (bound 600 ms, idle host wrote
`rotating:lifetime` at 836 ms and exited 0 with stderr empty).

Rotation failure is never a request failure: with the budget deliberately made unusable
(`maxLifetimeMs=1`) the client rotates twice, marks the host permanently unavailable and the adapter
falls back to the audited PowerShell capture (1,107.0 ms, valid 119,432-byte frame).

### Residual risk

OS-level containment (AppContainer, low-integrity token, Job Object desktop restrictions, UIAccess)
is **not** applied. That is a deliberate, measured decision, not an oversight:

- The host must read the signed-in user's own **medium-integrity** windows. Running it low-integrity
  breaks the capture path. A probe built from the same PrintWindow recipe and launched after labeling
  its image Low with `icacls probe.exe /setintegritylevel Low` ran at `LOW(0x1000)`: `GetWindowRect`
  still worked, but `PrintWindow` failed with Win32 error 5 (`ERROR_ACCESS_DENIED`) and
  `OpenProcess(PROCESS_QUERY_INFORMATION / PROCESS_VM_READ)` was denied. The same probe at
  `MEDIUM(0x2000)` captured the window and read UIA successfully. UIA element reads happened to
  survive low IL on the same desktop, but capture does not, and the Windows mandatory-integrity
  policy blocks read-up in general
  ([Mandatory Integrity Control](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)).
- AppContainer is stricter still: an AppContainer/package process runs at low IL with a package SID
  and, by default, cannot access the interactive window station/desktop (`WinSta0\Default`), so
  window enumeration, UIA and PrintWindow would each need explicit ACL grants that reopen exactly
  the access the containment is meant to deny
  ([AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)).
  The sanctioned escape hatch is a `UIAccess` token, which is only granted to binaries signed with a
  trusted certificate, installed under a secure path, and approved through UAC; it requires the very
  elevation/installation privilege this work removes, and it would let the helper drive other
  processes instead of narrowing it
  ([UI Automation security overview](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)).
- The containment that ships is therefore behavioural and bounded, not kernel-enforced: nonce
  handshake, strict 2 MB framing, per-request PID/HWND re-validation, elevation refusal, removal of
  every dangerous token privilege the process actually holds (all ten are attempted; absent ones
  cannot be abused), bounded request count/lifetime with announced rotation, one-crash restart
  budget and silent fallback to the audited PowerShell carriers.

Accepted residual risks, explicitly tracked:

1. A memory-safety/deserialization defect **inside** the native host would still execute as the
   signed-in user at medium integrity. It cannot use `SeDebugPrivilege`, `SeImpersonatePrivilege`,
   `SeTcbPrivilege`, `SeBackupPrivilege` and the other removed privileges, and UIPI keeps it out of
   elevated windows, but it could read the user's own files and same-integrity windows until the
   request cap/lifetime rotates the process (default 500 requests or 10 minutes). The blast radius is
   bounded, not zero.
2. A corrupted/hostile stdout that emits an unsolicited `rotating` line while idle is treated as a
   clean rotation (counter incremented, process replaced); it can never serve a response or produce
   a forged frame. The worst case is one extra spawn.
3. AppContainer/low-integrity containment stays open as a platform feature. It needs a signed
   UIAccess launcher plus kernel-level verification (Process Explorer evidence) and cannot be
   implemented in this iteration without breaking capture. No claim of OS-level sandboxing may be
   made until that work lands.

## 7. Chromium payload budget and Chrome limitation

### Payload and Chrome limitation

**Bounded payload — implemented.** `normalizeAccessibilityElements` is the single retention
authority for all three Windows paths (persistent carrier, native host, one-shot script). It now
enforces a documented budget in priority order — actionable > focused > focusable > labelled
context (on-screen before offscreen) > unlabeled decoration — with
`ACCESSIBILITY_OFFSCREEN_CONTEXT_LIMIT = 192`, `ACCESSIBILITY_CONTEXT_LIMIT = 768` and
`ACCESSIBILITY_DECORATION_LIMIT = 96`; `ACCESSIBILITY_ELEMENT_LIMIT = 2000` remains the absolute
backstop. The carrier walk applies the same offscreen/decoration caps before reading optional
properties, so a capped node costs five cross-process reads instead of twelve. Actionable, focused
and keyboard-focusable elements are never dropped by a budget, and no identity/HWND/owner-PID/root
check changed.

Measured live on this host (persistent UIA carrier, 3 warm inspects per cell, same session; "before"
= HEAD `ec2c5240`, "after" = this change):

| Window | Elements | Actionable | Payload | Inspect latency |
|---|---|---|---|---|
| Antigravity (Electron editor) | 787 → 569 (-28%) | 158 → 158 | 195 KB → 141 KB (-28%) | 3205-3555 → 2697-2799 ms |
| DeepSeek Harness (Electron chat) | 339 → 337 | 64 → 64 | 89 KB → 89 KB | 1216-1384 → 1266-1444 ms |
| Chrome 158.0.8127.88 (web content) | 83 → 83 | 29 → 29 | 19 KB → 19 KB | 689-827 → 677-1095 ms |
| Windows Terminal (Win32/XAML) | 30 → 30 | 10 → 10 | 6.8 KB → 6.8 KB | 249-268 → 249-266 ms |
| Notepad (Win32) | 45 → 45 | 13 → 13 | 11.5 KB → 11.5 KB | 420-470 → 420-431 ms |

Actionable counts are identical everywhere: the budget only removes offscreen context and unlabeled
layout structure, which is the acceptance criterion. Native windows are already below the budget and
pay nothing. A `UIA CacheRequest` walk was prototyped to remove the remaining per-property round
trips; it returned a single root node and was slower (2.7-8.1 s), so it was discarded instead of
shipped.

**Chrome (non-Electron) web content — documented limitation.** Chromium exposes page content to UIA
only after a renderer accessibility signal, and through the renderer's provider rather than the
top-level window's `ControlView` tree that the verified-window carrier walks. Measured evidence
(Chrome 158.0.8127.88, live tab rendering a known local page):

- A live Chrome window yields browser chrome only: 83 elements / 29 actionable (toolbar, tabs,
  address bar, window buttons) with no document, text, heading or link from the page.
- Asking every same-process child window for its UIA element (the carrier's warm-up, including all
  six `Chrome_RenderWidgetHostHWND` handles) did not change the tree: 43 nodes before and after, and
  the renderer element exposes one `Pane` ("Chrome Legacy Window") — an MSAA bridge, not a UIA
  subtree.
- Launching a throwaway profile against the same page with the documented flag
  `--force-renderer-accessibility` still produced 35 nodes with no page content.

The helper will not flip the global Windows screen-reader signal (`SPI_SETSCREENREADER`): it is a
user-wide persistent setting, and the per-call alternative measurably does not work. Browser *content*
perception must use the existing CDP path (`control_chrome_cdp` `snapshot` / `read_page`), which does
not depend on UIA. The exact flag, if an operator wants to experiment, is
`--force-renderer-accessibility`, set on the Chrome shortcut/launch command (and in
`scripts/chrome-debug.bat` for the debug profile) — with the measured caveat above that the top-level
UIA tree on this host still did not surface page content, so Core and Tray must not promise it.
