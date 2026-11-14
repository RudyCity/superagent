# Windows Desktop Live UIA DLL — standalone NSIS packaging gate

Scope: optional Windows x64 UI Automation semantic native DLL only. This does **not**
activate desktop control, bypass native Security Approval Manager approval, grant
remote authority, or install/launch a service. Exact HWND/PID/session/owner binding,
foreground-window checks, one-shot native approval and human takeover remain runtime
security conditions. If those checks fail, remote input must fail closed; there is
no monitor, coordinate, keyboard or public-bearer fallback.

## Trusted source build and installed path

The source of truth is `native/desktop-live-windows-input/windowsRemoteSemantic.cpp`.
The standalone workflows run `scripts/build-desktop-live-windows-semantic.ps1`
on a GitHub-hosted `windows-2025` x64 runner **after** Core compilation and
**before** packaging. The script requires the exact tracked source and GitHub
commit/run identity, discovers installed MSVC via `vswhere`, builds in a unique
temporary directory with `cl`/`link`, validates an AMD64 PE32+ DLL, and only
then writes these generated artifacts:

- `dist/native/desktop-live-windows-input/winremote.dll`
- `dist/native/desktop-live-windows-input/winremote.sha256` (lowercase SHA-256)
- `dist/native/desktop-live-windows-input/winremote.provenance.json`

The provenance pins C++ source digest, DLL digest, Git commit, GitHub run ID and
GitHub-hosted Windows runner identity. It does not cryptographically sign the
runner. This gate relies on the trusted workflow permissions and isolation.

The developer's `native/desktop-live-windows-input/*.obj, *.lib, *.exp,
winremote.dll, winremote.sha256` are **never used** in packaging. The original
`native/desktop-live-windows-input/build.ps1` is neither edited nor invoked.
CI aborts rather than reuse a pre-existing `dist/native/desktop-live-windows-input`
directory, and preparation refuses untrusted/stale/unverifiable input.

The NSIS Tauri standalone resource mapping is
`resources/standalone/ -> $INSTDIR/standalone/`. The native loader in
`src/core/desktopUi/adapters/windowsRemoteSemanticNative.ts` computes
`../../../../native/desktop-live-windows-input` from its compiled adapter path.
Consequently the **only** installed native helper location is:

`$INSTDIR/standalone/native/desktop-live-windows-input/`

Preparation removes the intermediate `standalone/dist/native/desktop-live-windows-input`
copy from generated staging and copies only the DLL, SHA-256 and provenance
to the fixed installed path. The manifest declares
`optionalWindowsRemoteSemanticInput.activated: false`: presence in the
installer is not approval to control an application. The runtime must still
require deliberate opt-in and the native host approval path before any action.

## Fail-closed checks

`scripts/verify-standalone-windows.ts` provides
`verifyWindowsRemoteNativePackaging()` and `windowsNativeCiContext()`, used
by preparation, standalone verification, native CI build and the extracted NSIS
audit. It denies absent/incomplete files, symlinks, invalid sizes, non-PE,
x86/ARM64/PE32/EXE payloads, tampered SHA-256, source changes, unexpected
metadata and mismatched GitHub build identities.

The standalone Windows workflows perform:

1. Compile fresh WGC and UIA native helpers and run focused tests.
2. Validate standalone staging and isolated portable CLI.
3. Build NSIS without changing active user services or deploying it.
4. Run `scripts/verify-wgc-windows-nsis.ps1` and
   `scripts/build-desktop-live-windows-semantic-audit-nsis.ps1`; the latter
   uses 7-Zip to test/list the **actual compressed installer**, rejects duplicate
   or unexpected UIA members, extracts all three pinned members to an isolated
   temporary folder, compares them byte-for-byte with verified staging, and
   rechecks provenance and PE x64 before deleting the temporary folder.

## Verification boundaries

Unit tests and typecheck prove rejection rules and workflow order, not an
installer. Until a real new Windows CI build passes preparation, native
compiler, bundle, extracted NSIS audit and (where approved) clean-host
installed-layout smoke, report **PARTIAL**, not a working/installed/released
Desktop Live controller. Publishing or switching an active installation
requires separate owner approval and R0–R7 gates; this task performs neither.
