# Routed Private LAN Discovery — 2026-11-06

## Problem and verified topology

Windows Wi-Fi: `10.200.84.27/20`. Android OPPO A18: `10.200.4.187/20`.
Windows to phone: ICMP 4/4 replies and TCP port 17845 reachable. The networks
are routed through the campus infrastructure, not in the same broadcast domain.
A local-subnet UDP discovery broadcast cannot find the Android phone.

## Implemented in the shared main checkout

- Preserve local UDP broadcast discovery for the original same-subnet case.
- Add an **explicit** Target IPv4 field to Tray. Targeted discovery sends a
  single v2 network-segment probe to UDP port 17846, never scans an address range.
- Limit targeted and accepted routed hosts to strict RFC1918 IPv4 within the
  same /16 allocation as a verified physical private adapter. Public, loopback,
  arbitrary RFC1918 /16, VPN and malformed hostnames/IPs are denied.
- For a user-provided target when UDP discovery has no reply, inspect only the
  target's TLS certificate on fixed port 17845, without sending a LAN command.
  Label this fallback as **unverified** and **segment not verified**.
- Preserve segment verification at pairing, a manually compared complete
  TLS SHA-256 fingerprint, one-time pairing code, phone owner approval, and
  separate session approval. No implicit trust from scanning or TLS fallback.
- Android's target service now allows the same private /16 on its current
  Wi-Fi/Ethernet link; every TCP/UDP request rechecks that active physical link.

## Local verification

- TypeScript typecheck: PASS.
- Node UI syntax: PASS.
- Focused Vitest LAN/Tray: 28/28 PASS in 7 files.
- Android JVM LAN policy: 27 PASS.
- Android Gradle offline debug APK: PASS, package
  `click.superagent.lanclient`, versionCode 7 / versionName
  `0.7.0-health-preview`.
- Rust Tray check: PASS.
- Windows Tauri debug executable build: PASS.
- Core compiled build: PASS, but **not activated**.
- A direct source-only probe to `10.200.4.187` completed without error;
  returned zero devices while the installed Android target remained old.
  A successful discovery or pairing was **not** demonstrated.

## Deployment blockers — not production accepted

1. Android ADB USB disappeared after the build. The new APK must be
   installed as an upgrade without uninstalling the full client; the phone
   owner must approve any Android/Play Protect confirmation. Sharing must
   then be restarted with a matching network segment.
2. The supervised Core restart refused the new build with
   `CORE_BUILD_UNVERIFIED`, because concurrent source changes make the
   build manifest stale. Do not stop or replace the verified owner manually.
   Rebuild and use the supervisor's guarded restart after the shared checkout
   becomes stable.
3. Current native Tray remains active from the old binary. The new debug
   build is available at
   `apps/superagent-tray/src-tauri/target/debug/superagent-tray.exe`,
   but the installed Tray has not been replaced/restarted. Package and
   install the new native UI after coordinated owner-scoped lifecycle approval.
4. Campus ACLs may reject cross-subnet UDP. The TLS certificate-only fallback
   is designed for that case but needs live verification against the updated
   Android client. If neither protocol reaches the phone, report a network
   transport block rather than weakening privacy or pairing controls.

## Safe acceptance test

1. Connect and authorize ADB on the OPPO A18.
2. Upgrade the full Android APK, confirm package version and active listener.
3. Rebuild and supervisor-restart Core when the source digest stays stable.
4. Open the updated Tray UI; enter the same segment as Android and target IP
   `10.200.4.187`; run Scan LAN.
5. Confirm either authenticated v2 discovery or an **unverified TLS** candidate
   appears. The latter must not be treated as proof of identity or segment.
6. Compare the full SHA-256 fingerprint on the phone, enter the current
   eight-digit code, approve pairing on the phone, then separately approve a
   session. Reject a wrong fingerprint, wrong segment and non-RFC1918 target.
7. Verify safe read-only Android diagnostics and revoke the session.

No credentials, production services or existing device data were changed.
