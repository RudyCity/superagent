# Desktop UI: remaining items, evidence and plans

**Date:** 2026-11-27
**Status (updated 2026-11-28):** items 1-8, 10, 11, 12 and 13 are implemented. Item 9 (macOS/Linux
carriers) is a validated spec that needs those hosts; the OS-level sandbox from item 6 remains open.
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
the exact sha256 (not the size) is the pin; the build is repeatable but not bit-reproducible; release
packaging must copy `dist/native/desktop-host` before shipped installs use the host.

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
reports no foreground window" (expected from this non-interactive window station). The only remaining
`bun run test:e2e` failure is unrelated (`studioRealMediaE2E` hard-asserts ffmpeg on PATH).

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
the exact sha256 (not the size) is the pin; the build is repeatable but not bit-reproducible; release
packaging must copy `dist/native/desktop-host` before shipped installs use the host.

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
