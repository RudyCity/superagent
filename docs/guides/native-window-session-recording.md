# Native window recording — SuperAgent Tray

SuperAgent Tray can record a **single exact desktop application window** after separate, attended OS approval. This is not remote desktop recording, VNC, screen sharing, or unattended monitoring.

## Use from the installed Tray

1. In **Desktop Live**, choose a native application (not a LAN device or a Chrome CDP target) and start its **View Only** preview. The user must approve that exact window in the native dialog.
2. In the stream header, select **Record compact (640×360, 3 FPS)**, **standard (960×540, 5 FPS)**, or **detail (1280×720, 5 FPS)**.
3. Click **Record window**, select the active project with the native folder picker, and review the **separate recording approval** in the OS dialog. Declining leaves recording off.
4. Click **Stop recording** to finalize the H.264 MP4, or use **Recordings → Stop**. Stopping Desktop Live invalidates the preview and stops associated recording; if the Tray is hidden, Core finalizes after capability revocation.
5. Open **Recordings**, choose the project and use **Play**, **Folder**, **Export ZIP**, or **Delete**. ZIP export creates `recording.zip` beside the recording's other files and opens its folder; no video or ZIP bytes are served through HTTP.

All project archives live in `<project>/.superagent/recordings/cdp/<recording-uuid>/`. The recording subtree includes a `.gitignore` rule; review before manual sharing. Exported ZIP includes `checksums.sha256` for contents. ZIP uses STORE mode, appropriate for already compressed H.264 video.

## Security and lifecycle

- Desktop preview consent alone **does not authorize video**. Recording uses a different, single-use 30-second challenge and domain-separated HMAC bound to the exact process/window/title/bounds, preview capability, selected project path and video preset. The OS dialog runs only from the visible main native Tray.
- Capture reuses the same verified native preview adapter. Window identity changes, revoked preview, vanished process, OS permission failure or expired lease stop the recorder. The current preview permission expires after five minutes; recording never extends it.
- No video is captured from an unapproved monitor, another window, camera or microphone. **Audio and input control are absent.** Linux Wayland or unsupported OS capture facilities remain fail-closed.
- Raw console strings, typed values, network request bodies and session secrets are not included in recording logs. **Pixels themselves may show sensitive data**, so the video and ZIP require private handling.
- Local ZIP export is bounded, allows only known basenames, rejects symlinked archive entries and appends SHA-256 checksums. It is not encrypted; operators must decide how and where to share it.
- Native Core operator recording routes require loopback, a valid Core Bearer, a localhost Host header, no forwarding headers, no Origin/Referer and no query-string credentials. Playback and export use the OS file viewer, not a URL.
- FFmpeg and FFprobe are prerequisites for encoding and media verification. No tool auto-installs FFmpeg on the user's machine. Video is capped at ten minutes; the native preview normally expires earlier.

## Verification matrix

The `Recording Acceptance` GitHub Actions workflow runs on Windows, Linux and macOS and checks TypeScript, Tray JS parsing, MP4 encoding/FFprobe validation, ZIP CRC and checksum validation, host-native recording consent and a simulated preview-revocation end-to-end flow.

Those tests **do not replace** an attended physical-machine test for the user's particular window, OS capture backend, installed Tray/Core build and OS permission prompt. Do not mark **Runtime Verified** or **Released** until those live checks and a verified distribution artifact are available.
