# SuperAgent LAN Client (portable, local-network support)

## Development build

On the SuperAgent host, run:

    bun scripts/build-lan-client.ts

This compiles standalone portable executables and packages ready-to-run `.zip` and `.tar.gz` archives in `artifacts/lan-client/` for:
- **Windows (x64)**:
  - CLI portable executable: `superagent-lan-client-windows-x64.exe` (and `superagent-lan-client.exe`)
  - CLI portable archive: `superagent-lan-client-windows-x64.zip`
  - GUI portable companion archive: `superagent-lan-windows-portable-x64.zip` (with System Tray and custom titlebar)
  - NSIS full installer: `SuperAgent-LAN-Client-0.2.1-Windows-x64-setup.exe`
- **Linux (x64 & arm64)**:
  - Standalone binaries: `superagent-lan-client-linux-x64`, `superagent-lan-client-linux-arm64`
  - Portable archives: `superagent-lan-client-linux-x64.tar.gz`, `superagent-lan-client-linux-arm64.tar.gz`
- **macOS (x64 Intel & arm64 Apple Silicon)**:
  - Standalone binaries: `superagent-lan-client-macos-x64`, `superagent-lan-client-macos-arm64`
  - Portable archives: `superagent-lan-client-macos-x64.tar.gz`, `superagent-lan-client-macos-arm64.tar.gz`
- **Master Checksums**: `artifacts/lan-client/SHA256SUMS`

No Bun, Node.js, or runtime installation is required on the target machine. Each portable binary runs completely self-contained.

## Connect another Windows laptop by QR

1. Copy the latest portable Windows LAN Client executable to the target laptop and run it as a standard user (never elevated).
2. Start the client with --tunnel-qr in a visible Windows console. Enter its network segment, or also pass --segment=office-lan.
3. On the controlling laptop, open SuperAgent Tray → LAN Devices → Device Tunnel → Create connect QR. On the target, a local-only browser page opens. Select Scan using camera, select a QR image, or paste the setup JSON copied by Tray when the browser cannot decode QR.
4. Verify the HTTPS host displayed in the target browser; click Connect only when it is the expected SuperAgent controller. The target user must still type APPROVE to permit pairing and approve again for a session.
5. The QR is single-use and expires within 10 minutes. Keep the visible Windows LAN Client open to maintain access; type revoke or stop when finished. No permanent background service, public inbound listener or UAC bypass is installed.

The Windows camera scanner uses the browser BarcodeDetector capability (current Chromium recommended); frames and QR images are processed on the target laptop. The client accepts only explicit confirmed invitations over a temporary local loopback HTTP page. Two-physical-laptop end-to-end testing remains pending.

## Use

1. Ensure **both Windows machines share the same physical home/office LAN**, not public Internet, guest Wi-Fi isolation, VPN, or a virtual adapter.
2. On the target laptop, run `superagent-lan-client.exe` in an ordinary command prompt. Select the desired private LAN IPv4 with `--bind=192.168.x.y` if the default is wrong. **Keep the visible terminal open** to observe and approve requests.
3. The target prints its **temporary** 8-digit pairing code (valid for 2 minutes), LAN IP, and its **full 64-character SHA-256 TLS fingerprint**. The pairing code expires after two minutes; the target can type `pair` to issue a fresh code without restarting. Pairing is valid only while this client process remains active.
4. If Windows Defender Firewall blocks the inbound connection, a user with administrator privileges can create a **program-specific, Private-profile-only, LocalSubnet-only** TCP rule for port 17845 and an analogous UDP rule for port 17846. Never use a blanket firewall disable or Public-profile exception. Remove the rules when no longer needed. Example PowerShell (elevated on target; set your actual path):

       New-NetFirewallRule -DisplayName "SuperAgent LAN Support TCP" -Direction Inbound -Action Allow -Profile Private -RemoteAddress LocalSubnet -Protocol TCP -LocalPort 17845 -Program "C:\path\superagent-lan-client.exe"

   Discovery uses UDP 17846; manually entering the target's IP avoids discovery requirements.
5. On the controller, launch `bun src/lanControllerCli.ts` for a terminal workflow or connect via the new LAN MCP tools after restarting the SuperAgent MCP server to load the new definitions.
6. Pair with target LAN IP, full fingerprint and 8-digit code. The target must type **approve**. Use returned device ID to open a session; the target must **approve** a second time. Commands run with the permissions of the *currently logged-in target user*. There is **no UAC bypass**.
7. The target can type `revoke` to erase paired controllers and close their session or `stop` to terminate support, all active commands and the listener. Client process exit also ends the connection.

## Exposed MCP tools

- `superagent_lan_discover` — local IPv4 discovery only.
- `superagent_lan_list_devices` — process-local paired handles, no credentials.
- `superagent_lan_pair` — pairing code + target TLS fingerprint + target approval.
- `superagent_lan_session_open` — target-side session approval.
- `superagent_lan_terminal_exec` — 30-second bounded command, output cap 64 KiB, no privilege elevation.
- `superagent_lan_session_close` — stop session.
- `superagent_lan_revoke_device` — revoke pairing on target.

Dangerous tools require locally enabled **Full YOLO**, existing MCP permission checks, OAuth write scopes when applicable, plus physical target approval for pairing and sessions. Avoid including passwords or credentials in commands. The controller stores temporary pairing/session secrets **only in process memory**; the target generates an ephemeral TLS private key in memory. No background access or persisted approval.

## Security and current limitations

- The app binds a **specific verified private IPv4 adapter**, and checks peer source address and interface/subnet on each connection. TLS 1.3 server fingerprint must match out-of-band text from the target before a code is sent. This is authenticated fingerprint-based pairing, **not PAKE**; a full PAKE implementation is still a release requirement in the original master plan.
- The target EXE rejects an elevated/admin process token; users must launch it normally without Run as administrator. The user must open a visible terminal and approve each pairing and terminal session. There is no permanent trusted device store; client restarts invalidate pairing.
- LAN detection relies on IP/interface checks. They cannot categorically guarantee physical co-location if an organization bridges or routes networks unusually. Narrow Windows Firewall rules and segmented Wi-Fi configuration are additional safety controls.
- Default command execution uses non-interactive PowerShell, 30-second timeout, 64-KiB cumulative output limit and one command at a time. Interactive ConPTY, robust OS job-object cleanup, persistent audit logging, DPAPI-protected long-lived identities, native Tray UI, Windows code signing and installed two-PC validation remain pending.
- Do not install this prototype on production or untrusted laptops until independent security review and Windows two-device end-to-end checks are complete.

## Verification

Build: `bun scripts/build-lan-client.ts`.
Unit/security integration: `bun --bun x vitest run tests/lanRemote.test.ts`.
Native Windows EXE test: `bun scripts/verify-lan-exe.ts` (runs against the first detected physical private LAN adapter with temporary, visibly approved permissions; stops test-owned processes). A passing single-machine EXE test is **not** evidence of successful two-laptop communication or production security acceptance.

## SuperAgent Tray integration

With an updated Tray and Core, open **LAN Devices** in the Tray sidebar
or Windows tray icon menu. Scan LAN or enter the target's private IPv4 and
port, compare the full target fingerprint, enter the temporary code, and
wait for the target owner to approve pairing. The paired device appears in
the **Paired devices & sessions** panel; Request session requires another
target-side approval before the PowerShell panel is enabled.

Tray sends fixed, validated actions to an authenticated loopback Core.
Pairing credentials never enter browser storage. This is a Core-owned
session; independently supervised MCP servers do not share its in-memory
device identities. Source and tests: see
`apps/superagent-tray/README.md` section “LAN Devices”.

## Android LAN Client

A separate, foreground-only Android 10+ companion is implemented in
`apps/superagent-lan-android`. Build a debug APK with the included Gradle
wrapper. It uses Android Keystore TLS 1.3 with out-of-band fingerprint
confirmation, an 8-digit one-time code, target-side approval for pairing and
sessions, and the same `pair/open/exec/close/revoke` protocol as Windows.

Unlike Windows, Android supports an exact read-only diagnostic catalog
plus settings/volume actions with a separate approval for EACH action.
Settings open only on the Android device and automatically terminate
sharing; the owner alone changes settings. The Android UI provides Start Sharing, Rotate Code, Revoke All,
Stop Sharing and approval dialogs. Leaving the app stops the listener
unless an explicitly approved, visibly notified MediaProjection foreground
service is active. There is no unattended service, device administrator, root,
ADB or silent settings control.
The Tray detects platform `android` and shows diagnostic presets instead
of PowerShell. Guide: `apps/superagent-lan-android/README.md`.

A debug APK build and Android Lint have been completed, but two-physical-
device TLS, discovery, pairing, and live Android UI checks remain unverified.


## Schema-first Android screen control (v0.4.0 preview)

Instead of processing screenshots constantly, Android now sends a small
revisioned Accessibility view-tree schema. It contains up to 96 interactable
or editable element descriptions (roles, normalized bounds, sanitized resource
IDs and interaction flags) with **no raw app text**. On unchanged views the
controller receives only a revision/changed=false receipt. Semantic clicks
use element IDs and verified current revisions; stale coordinates are blocked.
Only an explicit operator click on **Capture one screenshot (fallback)**
causes the Android MediaProjection pipeline to compress a JPEG. The schema
does not depend on screenshot OCR; graphics-only apps need visual fallback.
Android system capture and target approval are still required for the
approved screen-control session.


## Bidirectional per-file LAN exchange (preview v0.5.0)

Windows and Android LAN Clients both receive files sent from the controller
and can send back a document selected by their physical owner. The user
chooses the local file in Tray, then the target approves each transfer.
Remote outgoing source selection: Windows client console share <path> or
Android ACTION_OPEN_DOCUMENT system picker. File data uses 4096-byte ordered
TLS chunks, 4 MiB maximum, ten-minute expiry, and full SHA-256 verification
before final commit. Android writes via MediaStore into Downloads/SuperAgent
LAN, Windows writes to a unique file in Downloads/SuperAgent LAN, and Tray
receives via a native Save As picker that refuses overwrite. No remote file
browse, silent collection, cloud transfer or resumable transfers.


## v0.6.0 — segment-specific LAN discovery, two-way folder transfer

Set a mandatory 3–32-character network segment on each Windows/Android
client BEFORE starting its listener. In Tray LAN Devices, input the SAME
name before Scan LAN. UDP v2 discovery uses a SHA-256 segment tag, and v1
or mismatching responses are not surfaced. Segment name is a grouping
filter only; it is not pairing authentication, a password, firewall or VLAN.

Folder transfers are supported in both directions: Tray explicitly selects
a local folder and sends a SAFOLDER1 package; a target first explicitly
selects an outgoing folder via Windows console share-folder or Android
ACTION_OPEN_DOCUMENT_TREE system picker, then Tray receives it. Every
transfer requires approval on the target, TLS 1.3 fingerprint verification,
ordered 4096-byte chunks, outer SHA-256 + per-file SHA-256, safe path checks
and creation of a new extraction directory. At most 64 files in 4 MiB
including manifest; no automatic resume or broad remote folder browsing.
Physical device Android E2E is still a release gate.

## LAN transfer hardening: queued sends and uncertain-ACK recovery (2026-11-17)

The Tray **Send selected files** picker accepts 1–32 explicitly selected
files, processed sequentially with a fresh target-side approval for each
file. Every file remains capped at 4 MiB; cancel stops remaining items.
The progress bar reflects the overall file queue. No remote directory
enumeration, unattended collection, or overwrite is introduced.

A read-only, authenticated `file_status` query returns only metadata
and the acknowledged cursor for a single still-active, approved
transfer ID. After an ambiguous lost upload acknowledgement, the
controller confirms that the exact chunk arrived before continuing,
without blindly replaying a mutating write. A download may re-read
only the preceding already-acknowledged chunk after matching the
transfer's source metadata. A status query never cancels an active
transfer. Android pins its locally selected file revision before the
owner approval dialog and rejects any selection change before offer.

This is in-session recovery, not durable restart/resume. Limits
remain 4 MiB per file/folder package, 64 files in a folder archive,
one active transfer per target and ten-minute idle expiry. Large-file
streaming, parallel transfers, direct device-to-device relay and
Android physical-device acceptance remain incomplete.

Verification: `.github/workflows/lan-file-transfer-regression.yml`
runs typecheck, existing owner-consent and folder regressions, plus
queue, uncertain-ACK and read-only status tests on Ubuntu and Windows.
Native APK Gradle compilation and real-device Android/Windows round
trips are separate release gates.

## In-session pause and Android cancel atomicity (2026-11-17)

SuperAgent Tray's LAN transfer pane now supports **Pause transfer** and
**Resume transfer** for an already approved, active file or folder
exchange. Pausing stops issuing additional chunks at the next chunk
boundary; it does not suspend a currently in-flight TLS request, revoke
the target's approval, or extend its 10-minute idle/session expiry. The
owner can cancel while paused: the waiting loop is released, outstanding
transfer handles are aborted, and the queue stops rather than silently
continuing. It is **not** durable resume after application restart or
network/session expiration.

The Tray keeps a bounded list of the latest six transfer receipts
(direction, selected basename, byte count and verification outcome)
**in the current view's memory only**. No file contents, target paths,
pairing tokens or credentials are persisted by this list. A failed or
ambiguous transfer is marked *Not verified*; do not blindly retry it
when the target may have completed a final save.

Android's `LanFileExchange.abort` now changes an atomic revocation
generation **before** waiting for a synchronized MediaStore write.
The in-progress commit must recheck that generation and delete staged
output if the owner cancelled before it committed. The active transfer
reference is visible to the abort thread. Races at the exact point
a final commit has already completed remain an uncertain-outcome
case; the UI explicitly warns the owner to inspect the target.

Verification is tracked in
`.github/workflows/lan-file-transfer-regression.yml` with dedicated
Pause/Resume/Cancel UI regressions, Android cancellation source contracts,
the existing TLS/owner-consent tests and an Android Java compilation
job. Native Java compilation does **not** substitute for physical
Android device tests, OEM MediaStore acceptance, or distributed
network/expiry tests.
