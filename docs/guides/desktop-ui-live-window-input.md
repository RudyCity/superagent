# Desktop UI input on live windows

**Date:** 2026-11-27
**Scope:** `superagent_desktop_ui` / `desktop_ui` perception and input for native
windows that animate while an agent is working (editors, chat apps, Electron
IDEs such as Antigravity).

## Why this exists

The first generation of the Desktop UI pipeline required a window to be
**pixel-identical** between two consecutive captures before it would hand out a
screenshot schema, and it re-checked that exact SHA-256 before every click or
keystroke. It also bound a session to the exact window title.

That contract is correct for static dialogs and structurally unusable for live
applications: a streaming chat pane, a blinking caret, or a title that changes
with the active document changed the hash every time. The result was
`STALE_SCREENSHOT` on `snapshot`, no `expectedRevision`/`expectedHash` for the
caller, and therefore **zero** successful `action` calls.

## Current contract

Identity and authorization are unchanged. Freshness is now expressed with three
independent, bounded checks:

1. **OS window identity** — exact `pid` + native window id, unchanged bounds,
   and foreground state for input (`TARGET_NOT_ACTIVE` otherwise).
2. **Visual scene budget** — `framesEquivalent` compares sampled pixels
   (16k points, 8-bit channel delta 12) and accepts up to 12% changed pixels.
   Byte-identical frames short-circuit. Undecodable PNGs, mismatched
   dimensions, or a replaced window/dialog still fail closed with
   `STALE_SCREENSHOT`. The budget was calibrated against a live Electron window
   where 5% rejected legitimate streaming frames while a dialog replaces ≥25%.
3. **Element fence** — the exact semantic control the caller selected must still
   exist at the same place: same role, label, description, native ref, and bounds
   within 2 device pixels. Untargeted key input re-checks focused-control
   identity instead. Varying text values and unrelated live regions no longer
   block input.
4. **Control-pixel fence** — `regionChangeRatio` compares only the selected
   control's own rectangle (35% budget, sampled at most 4k points). This catches
   a visually replaced control that kept its label, role and bounds, while an
   unrelated pane is free to stream.

## Recovering from perception failures

`wait_ready` polls perception with a bounded deadline (500-10000 ms, default
3000 ms, 150 ms interval) and returns `attempts`/`waitedMs` with the schema. It
retries only capture-assembly failures (`STALE_SCREENSHOT`,
`SCREENSHOT_UNAVAILABLE`, `ACCESSIBILITY_UNAVAILABLE`, `TARGET_NOT_FOUND`,
`PROCESS_FAILED`); permission and policy denials propagate immediately.

Every Desktop UI error result now carries machine-readable guidance:

```json
{ "code": "STALE_SCREENSHOT", "retryable": true, "retryAfterMs": 200,
  "nextAction": "Capture again with wait_ready or snapshot; never reuse an old revision/hash." }
```

`INPUT_DISABLED`, `INVALID_ACTION` and other policy denials are `retryable:false`
with the operator step that must happen in SuperAgent Tray.

## Auditing perception quality

`schema.screenshot.changeRatio` records the share of sampled pixels that moved
while the schema was assembled (`0` for a static window), and a warning is added
when it is non-zero. It is diagnostic only and never authorizes input.


## Window titles are metadata

`pid` + native window id identify a window. The title is volatile metadata
(active document, conversation name, progress suffix) and is **canonicalized
from fresh OS discovery**:

- `open` accepts a stale, truncated (`...`), or differently-cased title from
  `find_window`/`list_windows` and corrects it. An unrelated title is rejected
  with `INVALID_ACTION` so a caller cannot silently bind the wrong document.
- An omitted title is allowed; the canonical title is still recorded.
- After the session opens, title drift is tolerated **only** when the
  host-approved rule is app-scoped (no `scope.windowTitle`). Rules that name an
  exact `windowTitle` keep the strict boundary for both `snapshot` and `action`.

`desktopAccessRequiresExactTitle` in `src/core/desktopUi/persistentAccessPolicy.ts`
implements that split and fails closed for unreadable policies, unknown
executable identities, or missing allow rules.

## Operational notes

- Windows capture now retries `PrintWindow` up to three times (150 ms apart)
  before reporting `SCREENSHOT_UNAVAILABLE`; there is still **no** overlap-prone
  screen-region fallback.
- Capability probing is memoized for five seconds per session. Probing spawns a
  PowerShell helper, and re-probing per snapshot tripled the time a live window
  had to stay still. Failures are never cached.
- An already-running MCP server keeps its loaded modules. Reconnect the client
  (or restart the MCP owner) after deploying a new build before expecting the
  new behavior.
- Raw coordinates remain forbidden. Use the accessibility `elementId` from a
  successful `snapshot`.
- Permission layers are unchanged and still independent: dangerous-tool
  authorization with project Execute, the v2 permanent access registry
  (executable SHA-256 + operations + optional element/title scope), native host
  consent, and Host File Policy.

## Verification

- `tests/desktop-ui/frames.test.ts` — decode, tolerance, scene-change rejection,
  fail-closed behavior.
- `tests/desktop-ui/session-live-frames.test.ts` — animated snapshots, element
  fencing, bounds jitter, replaced windows.
- `tests/desktop-ui-integration/title-drift.test.ts` — canonicalization, app-
  scoped drift, title-scoped strictness, wrong-title rejection.
- Existing suites (`tests/desktop-ui`, `tests/desktop-ui-integration`,
  `tests/desktop-ui-discovery`) stay green; the attended `windows-winforms`
  E2E still requires exclusive desktop focus.
