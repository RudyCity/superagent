# SuperAgent LAN terminal — physical acceptance gate (18 November 2026)

## Status

**Not runtime-verified on two independent Windows PCs or a physical Android device by this document.** GitHub-hosted tests and emulators do not count as physical acceptance. Record a dated result and artifact for each gate below before describing the feature as Released.

Source: `main`. Capture the exact full commit SHA and product/build versions on each machine; test the identical installer/APK hash on every device.

## Gate A — Native ConPTY on a real Windows receiver

Prerequisites:
- Windows 11 or supported Windows with ConPTY; current SuperAgent LAN receiver built from the verified commit, running as the local logged-in user.
- A separately authenticated Core, installed Tray, and one local human approving support sessions.
- Receiver on a real physical private interface or an independently approved Device Tunnel. No bypass of firewall, UAC, consent, or session expiry.

Run the reproducible Windows GitHub CI smoke first:

```powershell
bun scripts/verify-windows-conpty.ts
```

The command **must** be run with Bun (not `node` or `bun x vitest`) and must report `PTY_INTERACTIVE_OK` and `PTY_STOP_OK`. It checks the actual ConPTY backend, Read-Host input, resize, cross-session rejection, bounded process stop.

On the receiving PC:
1. Start LAN Client visibly. Pair the controller only after verifying its SHA-256 identity fingerprint on both screens. Confirm the requested capabilities and finite expiry.
2. Approve an explicit new support session. Never treat pairing as terminal execution consent.
3. In Tray/MCP select *this* device's opaque `deviceId` and start `Write-Host READY; $x = Read-Host INPUT; Write-Output ("DEVICE_OK_" + $x)`. The owner confirms the **exact** command on the receiving machine.
4. Check the reply has `mode: "conpty"` and an opaque `jobId`; write `verified` only after its separate input approval. Confirm `DEVICE_OK_verified` and exit code 0.
5. Start a bounded long-running task, send `terminal_resize` from 80×24 to 120×40, and send an explicitly approved `terminal_key` such as ArrowUp or CtrlC. Verify no cross-session key/resize is possible.
6. Stop the exact job, then close/revoke that device's support session. Verify the owned child process and descendants are gone; unrelated local shells must remain running.
7. Repeat after disconnect/reconnect and local Stop sharing. Revoked tokens must not restart, read, or input into prior jobs.

For each action record: timestamp, sanitized device ID (prefix only), OS version, CLI/Core build SHA, original and final process identity, requested action, local-approval result, result/exit status, and filtered logs without secrets.

## Gate B — Two independent physical Windows receivers

This is **not** the same as two simulated connections to one OS process. Use two separate Windows computers (PC-A and PC-B) as receivers and the same authenticated Core controller. Each machine has its *own* pairing, owner, approval dialog, unique session, process tree, and terminal cursor.

1. Pair and approve sessions on PC-A and PC-B separately. Show the two identities/fingerprints do not match.
2. Send a fleet start request with two device entries: PC-A executes a distinct read/prompt task with marker `A_OK`; PC-B executes a different task with marker `B_OK`. Confirm parallel progress and separate job IDs.
3. Send input to PC-A while PC-B continues. Deny input on PC-B. PC-A must succeed and PC-B must not receive that input or lose its own output cursor.
4. Close/revoke PC-A only while PC-B is active. Confirm PC-A child tree terminated and PC-B still works; then close PC-B.
5. Repeat each direction via direct LAN and via Device Tunnel if both transports are available. Never infer a private LAN result validates a remote tunnel result.

Required evidence: local approval screenshots on **both** PC displays (redact personal data), unique process identity logs, request/result per device, two concurrent terminal transcript excerpts, session revocation outcomes, and a comparison of untouched peer sessions.

## Gate C — Real Android handset / Android TV

1. With physical USB-debug approval, record `adb devices -l` (redact the serial), API level, ABI, APK package ID, APK SHA-256 and signer. Install the exact CI/release APK and confirm the package launches from the device UI.
2. Pair via visible phone or TV QR flow, or enter a one-time code in the supported reverse direction for TV without a camera. The device owner explicitly approves the pairing **and** support session.
3. Verify owner-approved diagnostics and allowed local sandbox-shell commands through Agent/MCP; deny an unapproved command. Android **does not have a persistent remote ConPTY**, and sandbox-shell must remain bounded, non-root, and app-scoped.
4. Exercise screen-view approval, Accessibility input approval (if enabled by the owner), screen disconnection, and device-local Stop sharing. Confirm there is no silent permission restoration after restart.
5. Send and receive an owner-selected small file and a V2 large file (when the app supports the requested flow). Verify SHA-256, no overwrite without local choice, cancellation, and resume.
6. Revoke phone pairing or close its support session while a Windows PC terminal remains active. Confirm the PC session continues and revoked Android capability cannot be reused.
7. On Android TV repeat QR/manual pairing without assuming camera hardware.

Required evidence: build + APK signature, real ADB install result, device logcat filtered to SuperAgent, consent screenshots, output hashes, and exact physical model/API level. **A passing Java compile or Android emulator is not physical-device verification.**

## Gate D — CI and release

Minimum checks for the exact prospective release commit:
- Windows GUI workflow and native Bun ConPTY smoke pass on Windows-2025.
- LAN File Transfer Regression passes on Windows and Ubuntu, including Android Java compile.
- Bun Runtime Validation, MCP Fast Regression, relevant Tray/native build and security gates pass. Do not equate a pending/cancelled run with success.
- Two-PC and physical Android gates A–C have independently captured PASS evidence.
- Installer/APK artifacts are hashed, signing status documented; reject a production label if signing is absent or unverified.
- A staged/RC release must not be labeled production-ready before physical validation.

## Outcome ledger

| Gate | Status | Evidence |
| --- | --- | --- |
| ConPTY compiled and wired in source | Implemented; CI result must be attached | GitHub commit and workflow run |
| Native Windows ConPTY smoke | Pending latest workflow result | `PTY_INTERACTIVE_OK`, `PTY_STOP_OK` |
| Two physical Windows receiver PCs | **BLOCKED: no live devices connected to this verification session** | Physical capture pending |
| Real Android handset | **BLOCKED: no live device/ADB session connected here** | Physical capture pending |
| Android TV (if requested) | **BLOCKED: no live device** | Physical capture pending |
| Release | Not released by this plan | Signed artifact and release URL pending |

Do not fill the evidence cells with simulated results or claim PASS for an unobserved physical device.
