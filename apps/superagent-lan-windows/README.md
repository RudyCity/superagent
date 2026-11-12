# SuperAgent LAN Client — Windows native receiver

This is a standalone Tauri 2 desktop GUI for a Windows laptop receiving an approved SuperAgent connection. It is a separate current-user application: no Core/MCP installation, OS service, silent startup or administrator elevation.

## Build a Windows installer

Build on a Windows development host with the Rust/MSVC toolchain, Bun, Tauri and NSIS:

    bun scripts/build-lan-windows-gui.ts

The finished NSIS installer is copied to:

    artifacts/lan-client/SuperAgent-LAN-Client-0.2.0-Windows-x64-setup.exe

The target laptop does not need Rust, Bun or MSVC. WebView2 is the standard Tauri Windows runtime prerequisite. The installer is not yet code-signed.

## Connect two Windows laptops

1. On the target Windows laptop, install **SuperAgent LAN Client**, enter a matching network segment, and click **Start receiver**.
2. On the controlling laptop open **SuperAgent Tray → LAN Devices → Device Tunnel → Create connect QR**.
3. In the receiving app select **Use camera**, choose a QR image, or paste the one-time connection setup JSON. Camera frames are decoded locally with Rust; they are never uploaded to the controller.
4. Confirm the HTTPS hostname displayed by the receiver, then choose **Connect to this device**.
5. Review the controller name, IP, operation and details on each access request. Choose **Approve** or **Deny**. Requests expire and deny after 90 seconds. Pairing, sessions, and file transfers need separately granted permission.
6. Use **Disconnect tunnel**, **Revoke all access** or **Stop sharing** at any time. Closing the window gracefully stops its exact child receiver process.

## Architecture and security

- ui/ is the local HTML/CSS/JavaScript frontend loaded by Tauri.
- src-tauri/src/main.rs implements scoped Rust commands, user-selected file/folder dialogs, the native QR decoder and exact child-process lifecycle.
- src/lanClientGui.ts is compiled into a bundled portable Windows receiver engine. It accepts fixed-schema JSON commands and requests explicit target-side approval for access.
- src/core/deviceTunnel/client.ts implements the existing authenticated HTTPS relay and QR pairing.

The application runs without administrator privileges, stores no QR secret or pairing token on disk, does not disable Windows Firewall, and cannot stop unrelated Core or MCP processes. Independent two-physical-laptop testing (camera permissions, pairing and network discovery) remains necessary before production distribution.

Verification: bun scripts/verify-lan-gui-receiver.ts, bun --bun x tsc --noEmit, and Cargo check in the native app.

## 0.2.0 security and operations

The 0.2.0 receiver adds explicit physical-adapter selection, native Windows approval notifications, separate enrollment / pairing / active-session states, real transfer progress and owner-side cancellation. Its bundled receiver executable is verified against the build-time SHA-256 before launch. A Windows Job Object ensures the receiver stops if its Tauri parent crashes. Closing the app makes a bounded attempt to revoke its own authenticated device token on Core before terminating the owned child.

**Controller compatibility:** update and safely restart the controlling SuperAgent Core so it exposes POST /api/device-tunnel/leave. If Core is older or unreachable, the receiver still blocks local access and shuts down, but it cannot prove that the remote token was removed; the GUI reports this failure. Revoke that device manually in the controller until Core confirms it. QR pairing on the controller requires the project's explicitly enabled Full YOLO permission gate; the receiver never bypasses it.

**Transfer limits:** the existing protocol accepts a single active upload or download up to 4 MiB, including packaged folders. Progress and cancellation are based on real byte counts, not estimates. This release does not claim a multi-item queue, resumable large transfers, or Windows remote screen sharing. Each request still requires its target-side permission.

## Production release gates

The CI workflow at .github/workflows/lan-windows-gui.yml builds and tests a Windows x64 installer for **CI artifact use only**. It does not publish an unsigned binary to a production release channel.

Before a production rollout, complete these operator-owned gates:

1. Obtain and configure a trusted Authenticode code-signing certificate and verify both the installer and installed executable signatures. The present build is unsigned; the printed SHA-256 is an integrity check, not proof of publisher identity.
2. Provision an updater-signing key pair and a trusted, versioned HTTPS update manifest/channel before enabling Tauri auto-update. Neither key nor endpoint exists in this project, so automatic updates remain deliberately disabled instead of accepting unauthenticated packages.
3. Verify the package on clean Windows 10 and 11 x64 devices without Bun/Rust/MSVC, including WebView2 provisioning, camera privacy permissions, and scan from a real webcam and QR image.
4. Perform an actual **two-physical-laptop** session: QR enrollment → manual target pairing approval → target session approval → file transfer with cancellation → Revoke while a request is pending → confirm no remaining tunnel token on Core → close app and confirm no orphan receiver.
5. Test adverse cases: offline Core during Revoke (manual controller cleanup warning), expired/wrong QR, denied/expired approval, wrong network segment, multiple adapters, app force-crash, connectivity loss and reinstall/rollback.

Once release signing and a trusted update endpoint are configured, implement and validate Tauri's signature-verified update flow and a rollback policy; do not claim it already works in 0.2.0. Device permissions and the user-visible safety model must remain fail-closed throughout updates.
