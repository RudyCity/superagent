# Universal Desktop Live Control — secure implementation ledger
Date: 2026-11-14
Repository: SuperAgent, existing main checkout. No new branch/worktree.

## Goal
One consistent operator experience for native application windows and browsers on Windows,
macOS, and Linux. Do not force every platform through a VNC server. Keep CDP, managed
Linux noVNC, and native desktop accessibility as separate authorized backends behind a
shared session/UI model.

## Milestone A — implemented as a local-only read-only foundation
- `src/core/desktopUi/livePreview.ts`: exact application-window preview with
  native adapters already available in `src/core/desktopUi/adapters`.
- Discover at most 100 eligible top-level windows, select exact PID + native ID
  and require explicit local Tray confirmation before start.
- One stream per Core; 256-bit random ephemeral session capability; fixed five-minute TTL.
- Fresh window discovery both before and after each capture; verify exact PID, native ID,
  application name, title and bounds against the originally approved target.
- Capture fails closed on a missing/replaced window, expired session, OS permission
  rejection, oversized PNG (> 2 MiB), suspicious dimensions, or a concurrent capture.
- At most one PNG frame per second. No background session polling or recording;
  the native capture adapter may use a temporary OS file, deleted in its finally block.
- A separate "Desktop Live" Tray page uses native Tauri IPC to talk to the Core bearer
  without exposing that bearer in web JavaScript.
- New Core `/api/desktop/live/{windows,start,frame,stop}` routes reject non-loopback peers,
  non-loopback Host headers, browser Origin/Referer, proxy headers, missing bearer,
  unsupported methods, query parameters, unexpected JSON fields and forged session tokens.
- Explicit Stop, page exit, navigation or hidden Tray clear the image. Failed verification
  clears the server-side session; no automatic retries or moving desktop cursor.
- Input remains off. Any desktop input must independently pass the existing principal-scoped,
  exact-target host consent, screenshot revision/hash and native accessibility checks.

## Native capture limitations and platform gates
| Platform | Implemented backend | Verification | Limitation |
| --- | --- | --- | --- |
| Windows | Existing Win32 exact-HWND PrintWindow PNG | Real disposable WinForms test PASS | Some accelerated/protected content may return an empty/black frame; no screen-wide fallback |
| macOS | Existing AX/CGWindowNumber mapping and `screencapture -l` | Source + mocked adapter tests | Requires both Accessibility and Screen Recording permissions; no physical macOS E2E this milestone |
| Linux | Existing AT-SPI + GNOME Screenshot/scrot active-window path | Source + mocked adapter tests | Background window preview may fail closed. Wayland needs compositor-approved portal capture and input; real Linux E2E not run |

This milestone is **not** smooth real-time video, WebRTC, remote interactive desktop,
cross-machine sharing, or completed multi-OS certification. It is a private local
preview baseline. 1 FPS is intentionally conservative until native capture backends,
consent and bandwidth gates are independently proven.

## Milestone B1 — adaptive local capture transport implemented in source

The existing native screenshot adapters are now wrapped by a bounded JPEG
preview encoder. The authenticated local Tray requests JPEG encoding at
1280 pixels maximum width and quality 65 from Core; the response is capped at
512 KiB/frame with fallback quality and output dimensions. A 64-character
SHA-256 digest is computed only after verifying window identity both before
and after OS capture. When the last digest is unchanged, Core returns no
picture bytes, only metadata; the viewer uses a bounded delay with no
overlapping capture requests. The hard server cap is at most one native
request every 500 milliseconds, but actual Windows capture currently takes
longer because of native subprocess overhead. This is not a 2 FPS
performance promise.

Native Tray approval no longer trusts a JavaScript confirmation: a modal
dialog from the operating system names the exact app and title sourced
from a freshly authenticated Core discovery. A single in-flight native
dialog guard prevents concurrent approval prompts. After approval the
Tray pins the window's title, app and bounds in the Core start request;
Core rejects a mismatch. Preview never grants desktop input or VNC
access. Hidden/minimized Tray cannot start or request frames.

### B1 acceptance evidence
- Focused Vitest suite (tests/desktop-live): 22/22 PASS.
- Real temporary WinForms window: exact native selection; legacy PNG,
  unchanged digest response, and decoded bounded JPEG signature PASS.
- Cross-OS adapter-based tests exercise Windows/macOS/Linux contracts;
  they are not physical macOS/Linux certification.
- \`bun run build\`: PASS; \`cargo check --locked --quiet\` for
  the Tauri Tray: PASS; JavaScript syntax validation: PASS.
- Native OS dialog has been compiled and reviewed, but **not** activated
  in a running installed Tray. No Core, MCP or tunnel restart performed.
- The full milestone B remains open: Windows WGC/DXGI, macOS
  ScreenCaptureKit, Linux PipeWire/XDG portal, true low-latency video and
  native capture stress/recovery tests are not yet implemented.

## Milestone B2 — Windows persistent exact-window capture worker (source)

The Windows Desktop Live adapter now offers `openVerifiedCapture(window)`.
Only a freshly operator-approved preview can open this worker. It launches
one restricted, fixed-script PowerShell process on the local host, reuses
the process for successive frames, and ends it on explicit Stop, capture
failure, token expiry, or Core worker shutdown/stdin closure. Frames are
returned over local process stdout; this fast path writes no screenshot
files. It never accepts shell command text from the UI and cannot dispatch
mouse, keyboard, clipboard, or window-management actions.

Each frame verifies PID ownership, process start time (PID reuse), root
HWND, window visibility, title, bounds, DPI awareness, DWM cloaking and
capture display affinity **before and after** exact-HWND PrintWindow.
Any uncertainty stops the preview. The shared preview manager uses
`DesktopWindowCaptureSource` only for adapters implementing their own
verified pre/post capture contract. macOS/Linux retain the existing
full-discovery-before/after checks; no undocumented screen-wide fallback
has been introduced.

### B2 host verification and limits

- Windows disposable WinForms test: PNG/JPEG/unchanged hash and Stop PASS.
- Windows disposable WinForms identity-change test: a title change triggers
  revocation, prevents a JPEG from escaping, and invalidates the token PASS.
- Shared session tests: verified source bypasses redundant window-list scans,
  excludes legacy capture, closes on Stop, and blocks in-flight frames PASS.
- Final focused desktop regression: 110 tests passed, 6 optional tests
  skipped across 18 passing test files. TypeScript Core build, Tauri Rust
  check and JavaScript syntax verification passed after these changes.
- The prior Windows fixture test took approximately 9.5 seconds for a
  three-frame run; an updated host run took approximately 4.6 seconds.
  These are *whole-test durations*, not a controlled FPS benchmark.
- This is a persistent **Win32 PrintWindow** optimization, not WGC/DXGI.
  The native dialog is compiled but still needs human acceptance in an
  installed Tray. Accelerated WGC, macOS ScreenCaptureKit and Linux
  PipeWire/XDG portals remain pending and need physical host validation.

## Milestone B3 — session-lock and blank-frame safety hardening

The scoped Windows worker now additionally verifies the active input
desktop through Win32 `OpenInputDesktop`/`GetUserObjectInformation` and
requires the interactive `Default` desktop at worker start and around
every frame. An unknown desktop or secure/locked desktop fails closed.
Minimized windows are also rejected through `IsIconic`, not treated as
background windows that might yield stale pixels. No auto-unlock,
password entry, or secure-desktop capture path exists.

The shared preview manager now checks PNG dimensions against the
consented target window to detect unrelated screen-sized frames.
Windows persistent exact-HWND capture requires an exact bitmap match;
other OS backends permit proportional HiDPI scaling (roughly 1–3x).
For the Tray's JPEG path, fully black or transparent sample grids
fail closed, rather than claiming success for a protected/GPU-black
window. Genuine all-black application content can therefore be
rejected; this deliberate limitation does **not** establish that
every type of protected content is detected.

Windows disposable-window host acceptance passed for normal captures,
window title change, minimization and closure. The actual Windows lock
screen was **not** activated during testing because that would disrupt
the operator. macOS Retina proportional-size acceptance and rejection
of unexpected source dimensions were verified with deterministic unit
fixtures, not physical macOS hardware.

Final scoped regression: 116 passed, 6 optional skipped.
TypeScript Core build, JavaScript syntax and Tauri Rust check passed.
This remains source-only local preview, not WebRTC, WGC, ScreenCaptureKit,
PipeWire, or multi-OS production certification.

## Milestone B4 — preview controls, bounded pacing and transport correctness

The Tray now offers three quality presets: **Save data** (768 px at
JPEG quality 50, requests spaced at least 1,000 ms), **Balanced**
(1,280 px at quality 65, requests spaced at least 500 ms), and
**Detail** (1,920 px at quality 75, requests spaced at least 250 ms).
The shared Core hard ceiling is now one capture attempt per 250 ms.
The viewer still awaits every completed capture before its next delay,
so requests never overlap. Its status displays transferred frames,
skipped unchanged frames, and a smoothed rate of actually delivered
changed images. These are requested limits, **not measured or
guaranteed FPS targets**.

SHA-256 source pixel hashes alone cannot prove that a previous JPEG
encoding is reusable after a change in codec, width or quality. The
session manager now binds unchanged-frame suppression to its most
recently delivered encoding profile as well as its pixel hash, and
the viewer clears its local hash when its preset changes.

The persistent Windows process protocol now clears per-response
timeout handles both on success and worker close, including when
the worker disappears during an in-flight capture. A 10-frame
physical Windows fixture test confirmed bounded JPEG output,
unchanged-frame suppression, manual Stop, revoked old tokens and
fresh tokens for new consented sessions. A lightweight real-script
Tray UI harness tested all three preset payloads without adding
browser dependencies or touching the installed Tray.

**Final scoped acceptance:** 120 passing desktop regression tests,
6 optional tests skipped. `bun run build`, Tray `cargo check
--locked --quiet`, and `node --check` passed. This is a bounded
local preview transport only: native WGC/ScreenCaptureKit/PipeWire
high-frame-rate capture, remote transport, attended input and
real multi-OS hardware acceptance remain open.

## Milestone B5 — true Windows Graphics Capture backend (native source, opt-in)

The project now includes a C++/WinRT + Direct3D11 **Windows Graphics
Capture** helper at `native/desktop-live-wgc/windowsCapture.cpp`. It uses
`IGraphicsCaptureItemInterop::CreateForWindow` for the exact approved
HWND, a free-threaded Direct3D11 frame pool, GPU-to-CPU staging and WIC
PNG encoding. The protocol remains bounded and local: one approved
window, one worker process, no arbitrary command execution, no screen
picker, no mouse/keyboard input, and no screenshot files.

The helper verifies input desktop, process PID/birth, executable name,
window title, visibility/minimization, HWND, bounds, cloaking and display
affinity around every frame. WGC's compositor frame dimensions may omit
invisible Win32 borders, so both native code and the Core preview manager
enforce a narrowly proportional size tolerance, rather than requiring
exact `GetWindowRect` dimensions or accepting desktop-sized frames.

To build the optional Windows x64 helper on a developer workstation
that already has MSVC and Windows SDK, run:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/build-desktop-live-wgc.ps1
```

The script builds into a new temporary directory and copies a bounded
`wgc.exe` plus SHA-256 receipt into `dist/native/desktop-live-wgc/`.
Core checks both files, valid x64 PE headers, checksum and regular-file
identity before using the helper. It never accepts an arbitrary binary
path from the WebView or an external request. WGC is **not default on**:
the local runtime owner must opt in at startup with
`SUPERAGENT_DESKTOP_LIVE_WGC=1`. A missing/malformed WGC bundle or
failed capture terminates that preview. It does **not** automatically
switch from rejected/protected WGC windows to another capture mode.
Without the opt-in, the prior exact-HWND PrintWindow path remains.

Native WinForms host tests passed for a bounded sequence of PNG frames,
JPEG via the real Core preview manager, unchanged-frame suppression,
manual Stop/token revocation, title change, minimization and window
closure. They never capture the operator's existing applications.
Full scoped regression: **126 passed, 6 skipped** across 21 passing
test files. Core TypeScript build, Tauri Rust check, JavaScript syntax
and git whitespace checks also passed.

**Still pending:** packaging and native acceptance of an installed
Tray with its OS consent dialog, WGC GPU/adapter compatibility matrix,
stress/soak testing, macOS ScreenCaptureKit, Linux PipeWire/portal
backend, signed multi-platform release, and attended remote control.
The helper has only been built in ignored local dist output; neither
installed Core/Tray nor independent MCP/tunnel services were restarted.

## Milestone B6 — Windows standalone artifact mapping and packaging gates

The Windows native helper is now staged through the normal Windows
standalone build contract. Its source layout, compiled `dist/` layout,
and installed `standalone/dist/` layout resolve to the same logically
corresponding `native/desktop-live-wgc/` directory; the Core will not
search arbitrary fallback folders or accept executable paths from IPC.

`scripts/prepare-standalone-windows.ts` requires a valid x64 WGC
binary and matching SHA-256 before copying the `dist` tree and
re-verifies the exact staged copy. `scripts/verify-standalone-windows.ts`
requires that same verified payload in the portable Core. The Windows
lanes of all three supported workflows (unified prerelease,
Windows-only prerelease, and Tray CI) compile and check the helper
before starting installer preparation. The PowerShell build script
uses the installed MSVC `vswhere.exe` to support Build Tools, Community,
or Enterprise hosts without fetching or installing any SDK on the user
machine. The helper remains opt-in at **runtime**, not at packaging.

Unit regressions verify the three module layouts, checksum/PE
validation, a synthetic independent standalone layout and the
presence/order of all Windows CI gates. Local Windows Core build,
WGC helper compilation and compiled-module path smoke passed.
**No actual new NSIS installer was built or installed in this
development checkout, and the workflow changes have not yet run
on GitHub Actions.** Physical clean-install, signed release,
macOS and Linux capture backends, and remote attended control remain
separate open gates.

## Milestone B7 — installed Windows WGC integrity gate (disposable CI only)

The Windows clean-install verification now checks the WGC helper **after
NSIS installation**, not only in staging. The script
`scripts/verify-installed-standalone-windows.ps1` calls
`scripts/verify-installed-wgc.ps1`, which runs the checked-in
`scripts/verify-installed-wgc.mjs` through the **installed Bun runtime**.
The verifier imports the **installed** compiled Core module from
`standalone/dist/core/desktopUi/adapters`, calls its
`locateVerifiedWindowsWgcHelper()` contract, and requires the resolved
x64 helper/checksum location to match the actual installer destination.
It does not start Core, Tray, a capture session, or any service.

The native Windows regression
`tests/desktop-live/windowsInstalledBundleSmoke.test.ts` creates a
fresh disposable `standalone/dist` layout, copies the built Core module,
WGC helper/receipt and Bun, and runs both the compiled Core check and
the **actual PowerShell verifier**. It confirms normal acceptance,
tampered binary rejection and checksum mismatch rejection. The script
uses checked-in `.mjs` instead of nested Bun `-e` after a real Windows
PowerShell 5 test revealed that nested argument quotes were removed.

The Windows CI and release workflows now include this fixture test
between native WGC build and installer staging. Tray CI path filters
cover WGC source, build/verifier scripts and related tests.
**A new NSIS binary has not yet been packaged or clean-installed on a
disposable runner**; the current checkout was not deployed or installed,
and no active session was interrupted.

## Milestone B8 — real Windows NSIS archive build and WGC verification

On the Windows development host, `bun run installer:prepare` and
`bun run installer:verify` passed for standalone version 1.14.91.
After adding the installed Cargo directory to that command's PATH,
`bun run installer:package` produced the actual local NSIS installer:
`apps/superagent-tray/src-tauri/target/release/bundle/nsis/SuperAgent_1.14.91_x64-setup.exe`
(257,957,818 bytes, SHA-256
`87928049128902f8cc46252a63b8bf44e479a31b6c0501f735ee4585bd5bb94c`).
7-Zip tested all 21,115 NSIS archive files successfully. We extracted
`standalone/dist/native/desktop-live-wgc/wgc.exe` and `wgc.sha256`
directly from that actual installer and verified the 322,048-byte
helper checksum against its receipt **and** the independently staged
WGC artifact (SHA-256
`e0254c02b14b452020fd18ad38e1d5f2e5a0517558cb15a6ae821479248b30b1`).

The reproducible read-only `scripts/verify-wgc-windows-nsis.ps1`
now performs full 7-Zip archive integrity checking plus exact-member
extraction and checksum/staging comparison. It creates and removes
only a fresh random scratch directory. Three Windows CI workflows
call it between NSIS packaging and the separate installed-desktop
smoke test. Release/CI calls use the exact current package version;
its explicit `-InstallerPath` option is for auditing earlier local
artifacts in the fixed NSIS output directory.

**Important scope:** the local checkout's version was advanced by
another worker to 1.14.92 while this diagnostic 1.14.91 build was
being verified. Thus the resulting installer is an **unpublished
local diagnostic artifact, not a release from an immutable clean
commit**. It was deliberately not installed or published. Windows
clean-install tests on a disposable CI runner, code signing,
macOS ScreenCaptureKit, Linux PipeWire/portal, and remote attended
control remain separate acceptance gates.

## Milestone B9 — macOS ScreenCaptureKit + Linux X11 native sources and Wayland portal policy

**macOS ARM64 (source implemented, physical macOS acceptance pending):**
`native/desktop-live-sck/macosCapture.swift` uses macOS 14+
`SCScreenshotManager.captureImage` with
`SCContentFilter(desktopIndependentWindow:)` for one approved CGWindowID.
The native helper verifies Screen Recording TCC permission and one
matching CG window ID, PID, application, title, onscreen visibility,
sharing state and bounds before and after each frame. It encodes PNG
in memory and never falls back to a display screenshot or requests
permission silently. The local worker protocol is bounded to one
five-minute view-only session with expiry and strict target checks.
Enable at local Core startup only using `SUPERAGENT_DESKTOP_LIVE_SCK=1`.
`scripts/build-desktop-live-sck.sh` builds the ARM64 Mach-O with Xcode
Swift on the macOS CI host, stages a SHA-256 receipt under
`dist/native/desktop-live-sck`, and portable macOS packaging rejects
missing/mutated files. Legacy CoreGraphics window-ID capture remains
unless the opt-in is selected; a missing or denied SCK helper never
silently falls back in the same native preview session.

**Linux X11 x64 (source implemented, physical Linux X11 acceptance
pending):** `native/desktop-live-x11/linuxCapture.py` provides a
persistent, fixed-command Python worker: `wmctrl` resolves exactly
one PID/title/geometry to XID, `xprop` verifies it is currently the
active X11 window, and ImageMagick `import -window XID png:-` returns
one bounded PNG frame through memory. The worker pins `/proc/<pid>/stat`
process start time, rechecks active XID and owner/geometry before and
after every frame, and never executes a shell, changes focus, injects
input, or captures the root screen. Enable explicitly at Core startup
with `SUPERAGENT_DESKTOP_LIVE_X11=1`; install the platform tools
Python 3, wmctrl, xprop and ImageMagick import on the Linux host.
`scripts/build-desktop-live-x11.sh` verifies Python syntax and stages
a SHA-256 receipt; Linux DEB/AppImage staging rejects missing or
tampered worker files. Without opt-in the existing verified X11
active-window adapter remains.

**Wayland/PipeWire:** `linuxPortalPolicy.ts` probes XDG ScreenCast
and GStreamer PipeWire availability read-only, defines WINDOW-only,
single-source, hidden-cursor, no-persistence selection options, and
rejects opaque portal stream metadata that cannot prove the user's
approved AT-SPI PID/native window identity. Standard portal streams
do not carry this identity attestation, so Wayland native capture is
currently **disabled/fail-closed**, including removal of any implicit
`gnome-screenshot -w` fallback. This is *not* yet an operational
PipeWire streaming backend. A safe future version requires an
OS-attested window binding or a separate portal-selected viewer
identity/consent model, then real Wayland host acceptance tests.

New contract/unit tests cover the bundle mappings, local worker
protocol, rejected window swaps, malformed/tampered receipts, and
Wayland capture refusal. Core TypeScript build and host-independent
tests passed on Windows. **macOS native Swift compilation, macOS
Screen Recording approval, Linux X11 actual capture and Linux
Wayland PipeWire portal sessions have not been run on their own OS
hosts yet.** macOS/Linux CI build steps are committed in source but
not validated by new Actions runs. No active Core, Tray, MCP, named
tunnel, OS permissions, or production release was modified.

## Milestone B10 — one-use native Tray consent attestation (local-only)

HTTP Desktop Live now includes an authenticated **loopback-only**
`POST /api/desktop/live/challenge` endpoint. Core issues a random
192-bit nonce valid for 30 seconds and remembers at most eight pending
challenges. Only after the user approves the *native OS dialog* does
the Tauri Tray read a separate, local owner-only 32-byte approval key,
sign the nonce plus pinned PID/CGWindowID/HWND/AT-SPI ID, UTF-8
application/title, and exact bounds using HMAC-SHA256, then send
`approvalProof` with `/api/desktop/live/start`. The HTTP handler
consumes the nonce (even for forged proofs), checks the MAC in constant
time, removes proof material, and only then calls the preview manager.
A captured/replayed proof, bare bearer credential, forged consent
boolean, modified window identity, expired challenge or changed
window bounds cannot start or recover the preview. The signing key
is never returned over HTTP or exposed to Tray JavaScript and is
created only on authenticated challenge issuance.

Tests include an independent UTF-8 signature vector checked against
the native Rust implementation, a positive loopback protocol path,
negative forged/replayed proofs, challenge expiration and rate caps.
`bun run build`, Rust `cargo check --locked`, and focused tests
passed on Windows. The Rust unit HMAC vector passed once the other
agent's in-progress named-tunnel module was compilable.

**Security scope remains local-only.** File-key secrecy prevents
bearer-only/remote clients from invoking capture but is not a
strong OS process identity attestation against a hostile process
already running as the same local user, particularly on Windows
where ACL inheritance must still be certified. No remote streaming
endpoint has been enabled. Platform keystore/native IPC binding,
separate remote-view and input approvals, remote transport, and R0–R7
acceptance remain mandatory before internet desktop sharing.

WSL2 Ubuntu x64 also successfully executed
`scripts/build-desktop-live-x11.sh` and independently validated the
resulting SHA-256-pinned Linux helper (`e9c6b3346ca4831b2ad19fc3a63e994a2948eee5281380034460602cbf929b6a`).
That environment lacks `wmctrl`, `xprop`, ImageMagick and a full X11
session; no physical Linux window capture was certified by this check.

## Milestone B11 — parallel Unix hardening and remote safety foundations

**Implementation, not a production activation.** Commit `c0415613`
contains independently scoped results from six GPT-6 High delegates:
macOS ScreenCaptureKit boundary hardening, Linux X11 worker and artifact
hardening, independent Wayland WINDOW portal consent proof, strict
view-only remote-session/frame policies, separate host-first remote
input authorization with human takeover, and fail-closed Unix CI
artifact/package verification. The Wayland portal client intentionally
discards the selected stream and closes the session; it does **not**
unlock AT-SPI-bound Desktop Live, export pixels, or silently capture
a display. The remote viewer and input policy modules are **not wired**
to network listeners, OS action dispatch, or a production native
approval UI. Both capabilities remain disabled.

**Verified at the shared Windows checkout after integration:**
- `bun --bun x vitest run tests/desktop-live tests/desktop-ui
  tests/desktop-ui-discovery tests/unixStandaloneInstaller.test.ts
  --maxWorkers=2`: **238 passed, 12 skipped, 0 failed**. Optional
  Windows WGC tests were then explicitly run with the pinned helper;
  all **5/5** passed on a disposable WinForms window.
- `bun --bun x vitest run tests/desktop-live/windowsGraphicsCapture.e2e.test.ts
  tests/desktop-live/remoteControlAuthority.test.ts
  tests/desktop-live/remoteInputGuard.test.ts --maxWorkers=2`:
  **58 passed, 0 failed**.
- `bun run build` and `bun --bun x tsc --noEmit --pretty false`: PASS.
- `cargo check --locked --quiet` for Tauri and native Rust HMAC
  cross-language unit verification: PASS.
- Ubuntu WSL2 Linux x64: X11 Python build, AST, SHA-256 checksum,
  Unix host guard, Python Wayland syntax, and shell scripts: PASS.
  Current checksum of X11 script: `90f92617656e521f648ddb53c345f1b723765103bafae32bfdeb902a27139ca5`.
  The Wayland helper is checksum pinned but not a live capture backend.
- `git diff --cached --check` before integration commit: PASS;
  staged files were exactly the 33 Desktop Live-owned paths.

**Still BLOCKED by native evidence / architecture, not papered over:**
macOS ARM64 compilation with Xcode and real Screen Recording consent;
Linux X11 capture with `wmctrl`, `xprop`, ImageMagick and a real GUI
session; Wayland actual PipeWire frames from an attended OS portal;
a separately host-approved and identity-bound remote viewer over a
trusted private TLS transport (not a public tunnel); exact native
remote-control dispatch and revoke-on-takeover; installed per-OS
DMG/DEB/AppImage/Windows installer smoke, signing/notarization, soak,
and R0–R7 operator approval. No live Core/MCP/Tray/tunnel was
restarted, no public desktop port opened, and no push/release was made.

## Next bounded milestones
**B — capture backend**: Windows WGC/DXGI with protected-window and black-frame
detection; macOS ScreenCaptureKit per-window filtered session, hardened TCC checks;
Linux PipeWire/XDG desktop portal with compositor/user selection (never bypass
Wayland permissions). Use one platform-abstract `CaptureSource` contract and explicit
error states, adaptive frame pacing/backpressure, resize, reconnection and quality caps.
No unattended restart or process takeover.

**C — shared viewer + safe input**: short-lived operator capabilities bound to OS user,
exact PID/native identity, session generation, capture source and permission scope
(view vs control). Add read-only viewer first; input only after a separate explicit
host approval, human takeover hold and per-action exact target verification. Reuse
`desktop_ui` UIA/AX/AT-SPI, native semantic element targeting, revision/hash checks.
Keyboard/text/clipboard/drag/scroll must be independently authorized; never
forward untrusted raw pixel coordinates to privileged OS APIs.

**D — remote transport**: authenticated HTTPS/WSS/WebRTC with mutual session identity,
OIDC/PKCE, CSRF/Origin validation, one viewer/control owner, forward secrecy,
bounded bandwidth and revocation at disconnect. Never expose VNC, CDP or native
desktop agent ports directly. Require OS-level attended consent for remote viewing
and remote control; no default monitor-wide sharing or sensitive content recording.

**E — certification**: genuine Windows, macOS, Linux X11 and Wayland host E2Es;
multi-monitor/DPI, minimized/occluded windows, identity reuse, locked screen,
protected windows, permission denial/revocation, network partition, takeover
races, hot reload, CI native packaging, signer verification and soak testing.
Respect SuperAgent R0–R7 release gates. No production cutover until verified.

## Evidence obtained in this work
- `bun --bun x vitest run tests/desktop-live`: 16/16 PASS.
- `bun --bun x vitest run tests/desktop-live tests/desktop-ui tests/desktop-ui-discovery`:
  92 tests passing, 5 optional host tests skipped (before adding the final HTTP suite).
- Real Windows disposable WinForms capture: native PNG signature and buffer inspected;
  exact window identity confirmed; token revoked on Stop; no user-window screenshot.
- `bun run build`: PASS (TypeScript + Core manifest); `node --check` on new Tray JS: PASS.
- Rust `cargo check --locked --quiet` using the explicitly installed cargo path: PASS.
- Core, MCP, Muse, public tunnels, installed Tray, secrets, runtime permissions,
  deployments and production branches were not changed.
