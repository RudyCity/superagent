# Cross-platform native desktop screen schema

Date: 2026-11-08

## Scope

This module provides a native desktop perception/action boundary for Windows, macOS and Ubuntu Linux without treating CDP as an operating-system GUI API. Existing Chrome/Electron automation should continue to use CDP/Delegate. Native adapters are for non-CDP application chrome and controls.

The implementation is isolated under `src/core/desktopUi/`. Toolset/MCP exposure is intentionally owned by the separate integration layer.

## Export API for the integrator

Import from `src/core/desktopUi/index.ts`:

- `createNativeDesktopUiAdapter(options?)`
- `createDesktopUiSession(options)`
- `DesktopUiSession`
- `createLocalUiDetrVisionDetector(options)`
- normalized schema/action/capability types from `types.ts`
- `DesktopUiError` and error codes

Vision is disabled by default. Constructing the local detector requires either `allowScreenshotUpload: true` or an `authorizationToken`. The endpoint is still restricted to loopback HTTP. A token is sent as a Bearer header. The native session does not create a detector automatically.

Recommended integration flow:

1. Use CDP/Delegate for Chrome/Electron. Use the native adapter only for an explicitly scoped native application window.
2. Create one session for one target `{ pid, nativeId?, title? }`.
3. Keep `allowInput` false unless a separately authorized active local session explicitly permits input.
4. Call `snapshot()`; treat the returned screenshot bytes and schema as sensitive data.
5. Send actions only by current accessibility-backed `elementId` or an allowed key, with the exact screenshot revision and SHA-256.
6. Treat stale screenshot, target identity, permission, DPI, dependency, inactive-window and unsupported-session errors as hard failures.
7. Never retry an uncertain mutation by guessing coordinates or replaying the same action.

## Security invariants

### Window identity

A screenshot, accessibility tree and input action must refer to the same target window.

The session assembles a snapshot with a fail-closed sandwich:

`target capture A -> accessibility inspection -> target capture B`

It accepts the schema only when:

- PID is unchanged;
- native window ID is unchanged;
- window bounds are unchanged;
- the PNG SHA-256 is unchanged between capture A and capture B.

Before every mutation, the session captures the pinned target again and requires the same PID/native ID/bounds and the exact expected screenshot hash. Session operations are serialized so two concurrent calls cannot both consume the same revision.

Platform adapters independently re-resolve the target before native operations. The session-level checks do not replace adapter-level ownership validation.

### Semantic action policy

The public session API exposes no raw-coordinate click/type method.

Accessibility controls may be actionable. Vision-only detections are always emitted with `actionable: false` and cannot be clicked, typed into or scrolled through. UI-DETR is an optional perception hint, not an authority for native input.

UI-DETR detections are filtered to a bounded control-role allowlist and a default minimum confidence of 0.75. The detector does not invent OCR text; visual labels remain roles/categories and `label`, `description` and `value` stay null for vision-only elements.

### Screenshot confidentiality

A target-window screenshot is not "secret free". It may legitimately contain passwords, tokens, personal data, private messages or any other pixels rendered by the selected application. Callers must treat screenshot artifacts as sensitive.

The adapters do not intentionally fall back to arbitrary rectangular screen-region capture:

- Windows uses `PrintWindow` for the validated HWND and fails closed if it cannot render the target.
- macOS uses `screencapture -l<CGWindowID>` after resolving an unambiguous CoreGraphics window ID owned by the requested PID.
- Linux uses active-window capture only after AT-SPI says the target is active and revalidates the same target immediately after capture.

Accessibility text is also conservative: Windows never exports edit values; macOS suppresses secure/password role values; Linux suppresses protected/password text values.

## Coordinate, DPI and Retina policy

Vision boxes are screenshot-local pixels. Accessibility boxes are platform screen coordinates. The normalized schema records measured `pixelRatioX` and `pixelRatioY`, and vision boxes are transformed through the target window bounds rather than assuming a 1:1 mapping.

Windows establishes `PER_MONITOR_AWARE_V2` with `SetThreadDpiAwarenessContext` for every native operation. A zero return is a hard failure. `GetDpiForWindow` must also return a valid DPI. This keeps Win32 HWND bounds, UI Automation screen coordinates, PrintWindow dimensions and input coordinates in one physical-coordinate contract.

Retina/macOS is allowed to report screenshot dimensions larger than AX point bounds; the measured pixel ratio is the conversion boundary.

## Platform adapters

### Windows

Security/correctness behavior:

- the requested PID must exist;
- a supplied HWND must be a live root/top-level HWND;
- `GetWindowThreadProcessId(hwnd)` must equal the requested PID;
- PID/root ownership is revalidated after screenshot/UIA and after input;
- exact target title comes from the selected HWND, not a different process main window;
- `PrintWindow` is used instead of `CopyFromScreen`;
- per-monitor-v2 DPI context is mandatory and fail-closed;
- input requires the exact target HWND to already be foreground;
- scroll moves the pointer and sends wheel events only; it does not click first;
- UIPI/integrity boundaries may still block automation into elevated applications.

Windows host evidence (updated 2026-11-08):

- capability/DPI probe: PASS;
- read-only Settings snapshot with PrintWindow + UIA: PASS;
- mismatched PID/foreign HWND: rejected with TARGET_NOT_FOUND;
- real disposable WinForms window screenshot with semantic button/edit: PASS;
- native click with observed button counter increment: PASS;
- native text entry with observed exact textbox content: PASS;
- native TAB and post-action capture: PASS;
- native wheel-scroll without accidental extra click: PASS;
- scoped MCP dispatcher probe/open/snapshot/real click/close: PASS;
- temporary processes exited without leftovers: PASS.

These tests certify the exercised Windows fixture path. macOS and Ubuntu still need real-host acceptance.

### macOS

Security/correctness behavior:

- Accessibility and Screen Recording are probed separately; screenshot capability is false without Screen Recording permission;
- AX window selection must be unique;
- the AX window is correlated to exactly one CoreGraphics window owned by the requested PID;
- the pinned native ID is `cg:<windowId>`;
- capture uses `screencapture -l<windowId>`, not `-R` screen-region capture;
- capture re-resolves the same CoreGraphics ID and bounds afterward;
- input requires the application to be frontmost and the selected AX window to prove it is focused;
- coordinate click is sent to the selected application process, not the System Events application;
- modifier chords and scrolling remain disabled.

This implementation has not been run on a real macOS host in this checkout. JXA/CoreGraphics behavior must be certified on a supported macOS host before external capability advertising.

### Ubuntu Linux

Security/correctness behavior:

- AT-SPI is used for target/window semantics;
- window capture requires the target to already be active;
- the same active AT-SPI target is revalidated after `gnome-screenshot -w` or `scrot -u`;
- input is enabled only when `XDG_SESSION_TYPE` is explicitly `x11`;
- empty, unknown and Wayland session types are default-denied at both capability and dispatch boundaries;
- Wayland requires a future compositor-approved integration rather than generic injection;
- modifier chords remain disabled.

This implementation has not been run on a real Ubuntu host in this checkout.

## Process execution safety

Native adapters do not invoke an arbitrary shell.

The process runner:

- calls `execa` with `shell: false`;
- uses exact executable allowlist matching;
- does not treat an allowed basename as permission for an arbitrary full path with the same basename;
- platform adapters use canonical absolute executable paths;
- invokes fixed PowerShell/JXA/Python source;
- transports target IDs/text/action data as JSON environment payloads rather than interpolating them into executable source;
- bounds subprocess duration and output.

The PowerShell, JXA and Python interpreters are implementation dependencies, not generic commands exposed by the native session.

## Testing boundary

`tests/desktop-ui/` covers:

- screenshot/accessibility/confirmation coherence;
- bounds/native-ID race rejection even when pixel hashes are unchanged;
- serialized mutations and stale revision rejection;
- accessibility-only action authority;
- vision default-off transport and auth/opt-in;
- low-confidence/unsafe visual-role filtering;
- Windows HWND ownership/root/DPI/PrintWindow script contracts;
- Windows scroll-without-click contract;
- Linux Wayland/unknown default deny at probe and dispatch;
- exact executable allowlisting and basename-path bypass rejection;
- macOS CoreGraphics window-ID capture and process-targeted JXA click contract.

Mock/script-contract tests prove orchestration and fail-closed policy, not real macOS/Linux permission state or native event delivery. Real platform certification remains required before claiming those hosts are production-ready.

## Windows WinForms provider fallback and input fencing (2026-11-08)

An actual Windows WinForms fixture revealed that this host exposes legacy WinForms buttons and text boxes as generic UI Automation `pane` nodes. The Windows adapter now promotes only HWND-backed `WindowsForms10.BUTTON.*` and `WindowsForms10.EDIT.*` classes to actionable `button` and `edit` roles. Before promotion, it verifies that the child HWND is real, belongs to the requested PID, and is a descendant of the pinned root HWND. Names alone never authorize an action. The normal `IsEnabled` and `IsOffscreen` checks still apply.

Every native input action now requires a capture → accessibility-tree verification → confirmation capture sequence. The action is rejected if the PID, HWND, bounds, pixel hash, accessibility roles, labels, native references, or element bounds differ from the last semantic schema. The target must remain foreground, and the chosen actionable element center must stay inside the pinned root window. This is a fail-closed guard, not a guarantee that another process can never race immediately before OS input dispatch.

The opt-in Windows host test at tests/desktop-ui-windows-e2e/windows-host-input.e2e.test.ts now passes real screenshot-to-schema, click, type, TAB, scroll, and PID/HWND scoping. Earlier attempts were correctly denied with TARGET_NOT_ACTIVE; the disposable test fixture now uses test-only foreground activation by attaching to the current foreground input thread. This does not relax production input checks. The test verifies its owned process exited. A second host test passes in-process MCP dispatcher probe/open/snapshot/real-click/close and rejects a different MCP principal.

## Follow-up P1 safety closure: dispatch outcomes, focus, and Windows SendInput

Native mutation now distinguishes three outcomes: no action attempted (the existing preflight errors), success with a verified post-action screenshot, and DISPATCH_UNVERIFIED when the operating-system dispatch result is unknown or verification fails after sending input. The last status contains details.dispatched (true or "unknown") and invalidates the previous schema. Agents must never automatically retry this state because input may already have taken effect.

The native session now pins a discovered window ID only after the capture/accessibility/confirmation screenshot sandwich succeeds. Each mutation rechecks focused-element metadata, roles, identities, labels, descriptions, actionable state, bounds, and image hash. Untargeted mutating keys or modifier chords require exactly one focused, actionable accessibility control. Navigation keys without modifiers can operate when the pinned window is foreground. Providers unable to identify focused controls must fail closed for mutating keys.

Windows no longer treats any keyboard-focusable pane as clickable; only enabled, on-screen, allowlisted roles are actionable. Windows checks the pinned foreground HWND immediately before each input event batch and uses SendInput with exact event-count validation instead of legacy mouse_event and keybd_event for click, scroll, type and modifier chords. A failed modifier batch triggers best-effort release. This narrows but does not eliminate OS scheduling races, and successful event insertion does not prove the application processed the event.

The Windows host compiled its generated C# SendInput wrappers in PowerShell and passed real click/type/TAB/scroll on a disposable WinForms fixture, plus a real MCP dispatcher click on another fixture. The tests verify the click counter and typed textbox content; scroll is confirmed as successfully dispatched without an additional click. macOS and Ubuntu GUI acceptance remain outstanding.
