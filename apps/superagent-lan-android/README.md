# SuperAgent Android LAN Client — preview

Native Android **target-side** client for the existing Windows SuperAgent Tray's
**LAN Devices** page. This does not make Android a full SuperAgent controller;
it enables consent-based diagnostics and on-phone-approved actions on an
Android device connected to the same physical LAN. A visible Android MediaProjection foreground service is
used only after the owner approves screen capture; there is no unattended
background support, root, ADB, hidden capture, or silent system configuration.

## Requirements and build

- Android 10+ (API 29), Wi-Fi or Ethernet on the same physical private IPv4
  subnet as Windows SuperAgent; no cellular-only link or VPN.
- Java 17, Android SDK 35, Gradle 9.6.1 and Android Gradle Plugin 9.3.1.
  The project includes a Gradle wrapper and is importable in Android Studio.
- Windows Tray and Core updated from the same repository. Full YOLO is
  required on the controller for pairing, opening sessions and diagnostics.

From the repository root on Windows:

    cd apps\superagent-lan-android
    .\gradlew.bat :app:assembleDebug

Generated preview: `app/build/outputs/apk/debug/app-debug.apk`.
Install using `adb install -r app\build\outputs\apk\debug\app-debug.apk`
with an owner's USB-authorized device, or copy the APK and explicitly allow
installation from the chosen source in Android settings.

The debug-signed APK is for authorized tests only, not a Play Store release.
Do not turn off device security protections to install it.

## Android 0.7.0 health and support diagnostics

The **Android health snapshot** and **Screen / support status** shortcuts in
SuperAgent Tray use the existing authenticated, explicitly approved LAN session.
They do not access screen contents or bypass Android permissions. The health
snapshot groups battery, memory, storage, network, power, device and app details,
with actionable advisory signals and independently reported unavailable sections.
The support status reports transient screen/input authorization booleans only.

See [Android Health and Support Status](../../docs/guides/android-health-and-support-status.md)
and [safe USB APK installation](../../docs/guides/android-adb-install.md).

## Guided remote-control permission setup (0.9.2)

The **Remote control setup** panel near the top of the Android app shows
notifications, Accessibility, screen sharing and remote-touch permission
states. Tap **Continue permission setup** to request the next missing
step. Tap **Refresh permission status** when returning from Android settings.

- Notifications: use Android's runtime notification permission on Android
  13+, or open this app's notification settings if blocked. Visible
  notifications with STOP SHARING are mandatory for screen capture.
- Accessibility: show a security explanation, then open the Android
  Accessibility screen; only the phone owner can enable the service.
- Screen sharing: wait for a separately approved support session and
  request Android's MediaProjection consent from the foreground.
- Remote touch: prompt for separate in-app confirmation after screen sharing
  and the owner-enabled Accessibility service are both active.

Opening Android Settings ends the current LAN/Device Tunnel sharing session;
reconnect the previously paired device and approve a new support session.
There is no silent permission grant, persistent remote input, or unattended
screen capture.

## Pairing and remote support

1. On Android, open the client and tap **Start LAN sharing**.
   Without a separately authorized screen-capture foreground service the
   Activity must stay visible, and switching apps stops LAN sharing.
   With the Android system's screen-capture consent, the visible foreground
   notification allows the approved screen session to continue when opening
   another app. STOP SHARING ends it instantly.
2. The app displays the local IPv4, an 8-digit code valid 2 minutes, and
   a full 64-character SHA-256 TLS certificate fingerprint.
3. On Windows, open **SuperAgent Tray → LAN Devices → Scan LAN**. Alternatively,
   enter the phone IP and TCP port 17845 manually. Compare the entire fingerprint
   displayed on the phone with the Tray value, enter the code and check the
   verification box.
4. The phone shows **Approve controller pairing?** with a local controller IP.
   The owner taps APPROVE, or DENY to refuse.
5. In Tray, select the now paired **Android** device and click **Request session**.
   The phone presents a separate approval dialog.
6. In Tray, run a diagnostic or select an action marked **REQUIRES PHONE APPROVAL**.
   Every Android action requires a separate on-phone APPROVE/DENY dialog.
   The user can open a Settings screen or approve a single media-volume step.
7. Finish with **Disconnect** or **Revoke** even while an action is pending.
   The phone owner can always tap **Stop sharing** or **Revoke all paired access**.

A pairing code is single-use and has a maximum of five attempts. Generate
a new code for each additional controller. The certificate private key
is generated in Android Keystore; pair/session tokens are process-memory only.

## Read-only diagnostic commands

| Command | Returns |
| --- | --- |
| `android.info` | Android version, manufacturer, model and SDK |
| `android.network` | Local IP, mask prefix and Wi-Fi/Ethernet transport |
| `android.battery` | Battery percentage and charge status |
| `android.storage` | Total/available app-data volume bytes |
| `id` | Android app sandbox UID |
| `uname -a` | Basic Android OS information |
| `getprop ro.product.model` | Device model |
| `getprop ro.build.version.release` | Android version |
| `getprop ro.build.version.sdk` | Android SDK |

The client does not expose an arbitrary shell, remote installation,
filesystem enumeration, silent system setting changes, camera, microphone
or unapproved screen sharing. Approved media-volume steps are supported. The phone
owner must change Android system settings locally; choosing
**Open Android Settings** ends sharing first.


## Expanded diagnostics and on-device controls

Read-only diagnostics include RAM, network validation, Wi-Fi state, audio
level, display resolution and brightness, battery health and power saver,
storage, sensor inventory (without readings), app-self information, and uptime.

The following exact action names may be selected by the Windows controller.
Each requires a **new explicit user approval on the phone** after the normal
pairing and support-session approvals:

- android.action.open_wifi_settings
- android.action.open_bluetooth_settings
- android.action.open_display_settings
- android.action.open_battery_settings
- android.action.open_storage_settings
- android.action.open_app_settings
- android.action.open_app_info
- android.action.open_date_settings
- android.action.volume_up
- android.action.volume_down

Opening Settings on Android is a local handoff: the **phone owner** changes
settings, not the controller, and opening it terminates LAN sharing/pairing.
The owner must pair again to continue. Volume changes one media-volume step
and displays Android's own volume UI; each step needs approval.

No arbitrary shell, APK installation, unrestricted file access, ADB, root,
accessibility screen control or silent Wi-Fi toggle has been added. The
exact Android allowlist is enforced by both controller and phone.

## Security and limitations

TCP TLS 1.3 listens only on Android's chosen Wi-Fi/Ethernet private IPv4
(port 17845). Peers must be on its currently connected subnet and the
network identity is re-checked after consent. UDP 17846 offers optional
broadcast discovery to on-link peers. The Windows controller must pin
the entire SHA-256 TLS certificate fingerprint before sending its code.
Approved sessions expire after 10 minutes idle or 60 minutes absolute;
the app never starts automatically or shares in the background.

**This is an unsigned/debug-signed preview, not a security-audited release.**
Vetted PAKE, persistent mutually authenticated client identities,
production-signed distribution, Android OEM coverage, Android 16/17
local-network compatibility and two-physical-device LAN pairing tests
are not yet verified. Same-IP-subnet checks alone cannot establish physical
co-location on unusual bridged or routed networks. Never forward the LAN
ports through a router or Internet tunnel.

Verification in the development workspace: Gradle offline debug build,
pure Java LAN subnet policy tests, TypeScript contract tests and Tray UI
tests. No Android device or AVD was connected during those tests.

## v0.3.0: owner-consented live screen and remote touch (preview)

The v0.3.0 compatibility feature uses **Android MediaProjection** to show screen images and a
separately user-enabled **AccessibilityService** to dispatch touch gestures.
It is not root/ADB, not an invisible remote desktop, and cannot bypass
screen locks, protected displays, banking-app restrictions or Android OS
consent. Supported Android: 10+ (API 29); tests on physical devices pending.

To start a fully interactive session:

1. Install the v0.3.0 preview APK with permission from the phone owner.
2. Before pairing, open **Open Android Accessibility Settings** in the app.
   The phone owner explicitly enables **SuperAgent remote touch** there,
   then returns to the LAN Client. Android may require acknowledging its
   own restricted-settings warnings for locally installed APKs. Do not
   bypass system restrictions or security policy.
3. On the same private physical Wi-Fi/Ethernet LAN, tap **Start LAN sharing**.
   On Windows Tray, use **LAN Devices** to verify the FULL TLS fingerprint
   and complete the one-time pairing. On Android approve pairing, then
   approve a *separate* support session.
4. On the Android app, tap **Share phone screen (Android consent)**.
   On Android 14+ this explicitly requests default full-display capture.
   The phone owner must approve the system capture prompt again for each
   new capture session. If notifications are disabled, screen share fails
   closed rather than operating invisibly.
5. The Android app displays **Screen: SHARING**. Tap **Allow remote taps
   and swipes** and confirm the additional high-privilege remote touch
   warning. The service never turns remote touch on automatically.
6. In the current Tray v0.4.0 UI, open **LAN Devices → Android schema-first
   control** and select **Start schema-first control**. Read the safe element
   schema; only press **Capture one screenshot (fallback)** if visual
   context is needed. No screenshots are recorded or saved.
7. Click the displayed screen for a tap, drag for a swipe; use
   Back / Home / Recents, or send up to 160 characters to the
   **currently focused, editable, non-password** field. Input is sent
   only when all three state gates remain true: approved support session,
   active system-consented MediaProjection, and explicit remote-touch opt-in.
8. Use **End remote session** in Tray or **STOP SHARING** in the visible
   Android foreground notification to terminate the entire session.
   Revocation invalidates tokens and screenshots; new sessions require
   fresh approval and the Android system screen-capture dialog again.

Implementation and limitations:

- Frame format: TLS-pinned JPEG snapshots, maximum 480px wide, roughly
  1 screenshot/s through Tray. This is a low-bandwidth preview, not
  WebRTC or high-framerate video streaming.
- The Android foreground service is visible with a notification whose
  **STOP SHARING** action stops capture and LAN access. No auto-start,
  unattended mode, remote privilege escalation or Internet relay.
- Accessibility can remain manually enabled in Android settings after
  the LAN session ends, but the app sends **no gestures**, text, or
  global actions unless the ephemeral authorization gates are active.
  It deliberately ignores all Accessibility events and reads only the
  currently focused non-password editable node when inserting text.
- Android's secure-window flags may blank sensitive application windows;
  Android still controls what content can be captured. The feature does
  not read notifications, SMS, contacts, call logs, stored passwords,
  other apps' private files or screenshots in the background without
  a visible, owner-approved capture session.
- The app uses no third-party cloud service. Screen frames pass only
  over the authenticated and fingerprint-pinned TLS LAN session to
  the selected SuperAgent controller, and are not written to disk.
- New permissions (MediaProjection foreground service, notification,
  user-enabled Accessibility) are sensitive and must be disclosed in any
  future signed release. The APK remains debug-signed for testing.
- **Unverified:** hands-on Android system capture, Accessibility consent,
  live screen updates, gesture accuracy (including orientation), phone
  OEM variants, Android 14+ capture token lifecycle, cross-device TLS
  performance and a formal security audit. Compilation and static tests
  do not demonstrate physical-device reliability.

## v0.4.0 — schema-first screen control, not continuous screenshots

The Tray now defaults to a **privacy-reduced native Android Accessibility
structure schema**, not a repeated screenshot or OCR pipeline. This is
usually more accurate and much cheaper than trying to infer button locations
from each screenshot. The phone owner still must explicitly approve pairing,
support, Android Accessibility, system screen capture, and remote touch for
the live session; these permissions are not bypassed.

The Android client traverses only the currently visible Accessibility tree,
bounded at **96 output elements, 512 inspected nodes and 12 levels of depth**.
Each element supplies a revision-scoped ID, role, clickable/editable/scrollable
status, and normalized on-screen coordinates. The optional resource ID suffix
is sanitized. The client **does not retrieve actual UI text, hints, content
descriptions, password contents, messages, or private-app data** for schema
mode. App/window identity participates in on-device change detection but
is not transmitted to Windows.

At runtime:

1. The owner approves the LAN session, MediaProjection consent and enables
   the manually opted-in Android Accessibility service.
2. Tray → LAN Devices → **Start schema-first control** fetches schema revision
   1 with a list of safely exposed UI elements and their coordinates.
3. The Android Accessibility service marks its cached schema dirty on
   window, focus, scroll or content changes. The next request recomputes
   the small metadata tree and hashes its representation.
4. If the schema is unchanged, the phone returns only
   \`{version:1,revision:N,changed:false}\`. No image bytes or repeated UI
   list are transmitted. If changed, it returns the new bounded list.
5. A user clicking an actionable element in Tray sends **elementId + schema
   revision**. The phone checks current user control permission, checks the
   last schema revision is fresh, re-resolves that element in the current
   Android tree, compares bounds and dispatches its authorized CLICK.
   Stale/missing/password/editable elements are rejected.
6. Only if native Accessibility metadata is insufficient (games, canvases,
   unusual WebViews) does the operator explicitly press
   **Capture one screenshot (fallback)**. The Android image reader now
   compresses a JPEG **only when requested**. There is no continuous
   JPEG transfer or automatic screen-to-schema OCR.

Current design intentionally prioritizes **privacy and bounded cost** over
showing private text labels. The schema cannot fully describe proprietary
canvas/game graphics; visual fallback remains necessary. There is no
LLM-based screenshot parsing in this version. Schema-first is built on the
Android Accessibility UI tree, not inferred from pixels.

Device-specific performance, OEM Accessibility differences, lifecycle,
orientation, and correctness of stale-revision rejection still require
physical Android acceptance tests before production.


## v0.5.0 — LAN file transfer between PC and mobile

Both Windows and Android target clients support sending and receiving files
through the existing, paired TLS 1.3 session. The controller initiates a
transfer and the target owner must approve EVERY individual file.

**Send a file to a Windows/Android device:**
Open SuperAgent Tray / LAN Devices / Send & receive files. Select one local
file with the file chooser, then click Send file. The target's owner receives
a visible file-upload APPROVE/DENY request containing the filename and size.
The file is committed only after 4096-byte ordered chunks pass SHA-256
verification. A Windows target saves to its current user's
Downloads/SuperAgent LAN folder. Android saves via MediaStore Downloads in
Downloads/SuperAgent LAN. A randomized filename prefix prevents overwrite.

**Receive a file from a Windows/Android device:**
The device owner must first explicitly select its outgoing file.
On Windows, type: share "C:\path	o\chosen-file.pdf" in the LAN Client console.
On Android, tap Choose document to share; the OS ACTION_OPEN_DOCUMENT chooser
grants access to that ONE selected file only. After that, click Receive
owner's shared file in Tray. The target must approve the file-download
request. The controller verifies chunk order, total bytes and SHA-256,
then opens a native Save As dialog on the Windows receiver. The user selects
a destination, and the native Save As refuses existing-file overwrite.

**Preview restrictions:** 4 MiB per file, 4 KiB each chunk, 1 transfer per
target, 10-minute inactivity expiry, safe ASCII filename basenames, no
resume, no directory listing, no arbitrary remote path, no broad Android
storage permission or Internet relay. Cancel and Revoke stop transfers.
Repeated TLS connections make larger transfers relatively slow. Real
Windows↔Windows exchange was tested using an isolated temporary fixture,
but Android physical-device picker/MediaStore and cross-device transfer
are NOT verified yet. This is a debug-signed testing build.


## v0.6.0 — mandatory network segment discovery + owner-selected folders

**Network segment first.** Before Start sharing, the phone owner must type a
segment name (3–32 ASCII letters/digits/spaces/underscore/dot/hyphen).
Windows client similarly needs an initial segment name, either interactively
or via --segment=office-team. The controller/Tray must enter the matching
name before Scan LAN. Names are trimmed and lowercased before SHA-256
tagging. Legacy v1 discovery and wrong-segment v2 requests are ignored.
The segment is a discoverability grouping tag, **not** an encryption key,
authorization credential or VLAN isolation; pair code, full pinned TLS
certificate fingerprint and physical approval continue to be mandatory.

**Folder sharing:** To send a folder from the Tray to Android or Windows,
choose it in the Tray's directory picker and press Send selected folder.
To receive a folder from Android, the PHONE owner taps Choose folder to share
in the Android application, selects a folder in the Android SAF system
picker, then taps Start LAN sharing and approves the support session and
each transfer. To receive a folder from the Windows client, its owner types
share-folder "C:\path	o\local-folder" in the client console. Then the Tray
uses Receive owner's shared file. Verified folders are safely extracted
to unique folders under Downloads/SuperAgent LAN on the targets; Tray
receivers choose the parent directory in a native folder-picker dialog.
No unattended filesystem reads or writes, overwrites, root or ADB.

**Portable archive:** SAFOLDER1 is nine ASCII bytes + a four-byte
big-endian JSON manifest length (maximum 32 KiB), followed by an ordered
list of relative file paths, byte lengths, SHA-256s and raw file contents.
The full archive remains <=4 MiB. Maximum 64 regular files and 8 nested
folders; empty folders, unsafe/sensitive paths, case-insensitive collisions,
hidden files, symlinks and unsupported names are rejected before commit.
No resume, no folders larger than the preview size cap.

The Android APK remains a debug-signed preview. Physical Android
folder-picker, OEM MediaStore, TLS and real-device transfer acceptance
have NOT been completed, even when local build and contract tests pass.
