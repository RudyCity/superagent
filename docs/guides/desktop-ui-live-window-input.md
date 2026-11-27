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

## Persistent verified capture (fast path)

Each session may bind one persistent, identity-verified capture worker
(`adapter.openVerifiedCapture`, the existing exact-HWND worker used by Desktop
Live). The worker re-verifies HWND, PID birth, title, bounds, DWM cloak and
display affinity inside every frame and never accepts a path from a caller.

Measured on a real Windows Terminal window (2026-11-27):

| Path | Capture | Snapshot |
|---|---|---|
| One-shot PowerShell capture | 768 ms | 2.6-3.1 s |
| Persistent verified worker | 131 / 103 / 89 ms | 1.6 s cold, **1.05 s warm** |

Behavior and limits:

- The worker is optional. Any refusal permanently falls back to one-shot
  capture for that session and adds a schema warning; it is never fatal.
- Targets the worker refuses (some Electron hosts and Explorer windows fail its
  strict `Verify`) simply use the fallback path.
- WGC remains owner opt-in via `SUPERAGENT_DESKTOP_LIVE_WGC=1`; the bundled
  helper is checksum-verified before use.
- The worker pins the title it was opened with, so a volatile title closes it and
  the session continues on the fallback path (title drift policy is unchanged).
- High-DPI note: discovery and the worker may run in different DPI contexts, so
  window geometry is compared with a DPI-aware equivalence (exact, or
  consistently scaled either direction, 2 px tolerance). Identity remains HWND +
  owner PID birth + title + cloak + affinity; only the pixel unit is normalized.
- `PrintWindow` is retried up to three times (120 ms apart) inside the worker,
  re-verifying the target each round, so a transient GPU-composited failure does
  not kill the fast path.

## Persistent accessibility host

UIAutomation used to be loaded by a fresh PowerShell process per snapshot
(~0.95 s). A single shared carrier process now holds the UIAutomation assemblies
and re-validates HWND, owner PID, root status, visibility and geometry for every
request. Only the tree walk remains per snapshot.

| Stage | Before | After |
|---|---|---|
| Accessibility inspect | ~950 ms | **241-314 ms** warm (first call 2.5 s while the carrier starts) |
| Warm snapshot (capture + inspect + confirm) | 1.05 s | **278 ms** |

Safety and limits:

- The carrier only runs for the production process runner; injected runners used
  by tests and security harnesses stay fully scripted.
- Any spawn, protocol or parse failure closes the carrier and falls back to the
  audited one-shot script for that call; nothing is weakened.
- Idle carriers close after 60 s; requests are serialized with a 15 s timeout.
- No path, script or argument is ever accepted from a caller.

## Bounded confirmation retry

Perception assembly now retries the settling frame up to three times before
declaring `STALE_SCREENSHOT`. A single animated tick no longer discards a
schema, while a genuinely changing window still fails closed.

## Operator policy: read-only discovery

`superagent_desktop_ui` is a dangerous tool, so every call normally needs an
operator-approved Execute grant on the active project. Discovery returns window
titles and process names, which is metadata-sensitive, so it stays strict by
default. An operator may opt in with a bounded file in the SuperAgent config
directory:

`desktop-ui-policy.json`

```json
{ "version": 1, "discoveryRequiresDangerousTool": false }
```

When `discoveryRequiresDangerousTool` is `false`, only these commands skip the
dangerous-tool project Execute gate: `probe`, `list_windows`, `list_monitors`,
`get_active_window`, `find_window`, `inspect_window`, `list_installed_apps`,
`inspect_security_prompts`, `live_inventory`, `snapshot`, `wait_ready`.
`open`, `action`, `close`, `launch_app`, `restart_app`, `close_app`,
`live_stop`, `plan_package_change` and `apply_package_change` always require it.

The Tray exposes this as a checkbox in the MCP connections pane ("Izinkan
penemuan read-only tanpa persetujuan proyek"); enabling it writes the file through
an authenticated, atomic, symlink-safe command. The checkbox reflects the effective
state and leaves the previous value untouched when a save fails.

Missing, malformed, oversized or symlinked policy files fail closed to the strict
default. MCP clients cannot self-grant this: only the host-side file changes it.
Host file policy, window identity, permanent access rules and native consent are
unchanged and still evaluated per call.

## Registry v3 title policies

The v2 desktop access registry now also accepts an optional per-rule
`titlePolicy` field (`"app"` or `"exact"`) so the semantics are explicit instead
of inferred:

- `"app"` — the approved application is in scope; a renamed window stays usable.
  A `scope.windowTitle` on the same rule is ignored.
- `"exact"` — the rule must carry `scope.windowTitle`, and only that title is
  authorized.
- absent — legacy behaviour: exact title only when `scope.windowTitle` exists.

Core reads and enforces this field, and the Tray registry now writes it on every new
approval: `exact` when the operator approved one window title, `app` when the whole
application was approved. Rules that differ only by title policy are treated as
distinct targets, and an `exact` rule without a bound title is rejected. Older
entries without the field keep the legacy inference, so no migration is needed.

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
