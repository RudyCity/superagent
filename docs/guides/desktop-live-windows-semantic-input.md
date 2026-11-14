# Windows Desktop Live — host-only native semantic input

This is source implementation and a security gate, not production-enabled remote control. Only the locally attended Windows host may instantiate the native binding. It is not an HTTP route, MCP tool, VNC backend, or replacement for the existing coordinate adapter. Never accept DLL paths, script, approval proof, HWND, or bearer from a remote caller.

## Build

On Windows x64 with already-installed MSVC and Windows SDK, run:

    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File native/desktop-live-windows-input/build.ps1

This creates winremote.dll and winremote.sha256. The loader verifies SHA256, x64 PE and fixed source-layout path. An installed/packaged host binary resolver has NOT been implemented, so production use is blocked. Do not copy/upload the DLL through a tunnel.

## Host-only composition and safety

The host supplies RemoteControlAuthority after separate physical native input approval. Viewer consent alone never permits input. A trusted wrapper around captureFresh() must expose the SAME frame to the adapter currentVerifiedFrame() callback; the adapter fails closed if frame identity, revision, SHA256 or age differs. The adapter cannot be constructed or invoked by a network client. This worker cannot wire the composition into existing dispatcher/Tray/route files because those belong to other workers.

RemoteHostScope is OS-derived. nativeId: decimal HWND; processBirthId: filetime:<GetProcessTimes creation FILETIME>; osUserId: S-1-... token SID; hostSessionId: session:<ProcessIdToSessionId>. Remote input cannot pick or guess these values.

Native checks: exact root HWND, PID, process birth, SID, session, foreground, user token integrity, interactive Default desktop, visible/unminimized/uncloaked target, stable unique UIA AutomationId and semantics, actionable control with InvokePattern, focused nonpassword ValuePattern or ScrollPattern. One-shot authorizeNow() is called by native C++ immediately before the UI Automation method. No SendInput, raw coordinates, key chords, clipboard, shell, or screen-wide fallback. Generic key action is intentionally denied. After a post-checkpoint error, the dispatcher revokes the approval without retry.

Native WindowDisplayAffinity querying may be unsupported on foreign-process HWNDs. Until a safe attended host integration is proven, do not relax the check simply to turn tests green.

## Evidence

Run focused tests:

    bun vitest run tests/desktop-live/windowsRemoteSemantic.test.ts tests/desktop-live/remoteNativeInputDispatch.test.ts
    bun --bun x tsc --noEmit

Physical disposable WinForms action test (opt-in only on an attended interactive host):

    SUPERAGENT_RUN_NATIVE_WINFORMS_E2E=1 bun --bun x vitest run tests/desktop-live/windowsRemoteSemanticHost.test.ts

The test starts its OWN temporary WinForms control and never selects user apps. The 2026-11-14 MCP-run fixture did not become the foreground HWND, native status -356; input was correctly denied before invoking UIA. This is a real native negative gate, NOT proof of successful remote click. Physical native action certification remains BLOCKED. No running Core/Tray/MCP/tunnel was changed or restarted.
