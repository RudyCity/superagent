# Android 0.7.0 — Health Snapshot and Support Status

This development increment adds two **read-only**, allowlisted Android LAN commands. Both require an already authenticated, manually approved TLS LAN support session; discovery segment is only a filter and never authorization.

## Android health snapshot

Use the **Android health snapshot** shortcut in SuperAgent Tray → LAN Devices, or select `android.health` from diagnostic presets.

The Android client returns a bounded JSON payload with `schemaVersion: 1`, `readOnly: true`, a device-side timestamp, seven sections, warnings, and a privacy statement. The sections reuse the existing Android API-backed diagnostics:

- `device`: manufacturer/model, OS version and SDK/security patch
- `battery`: charge level, charging, battery temperature
- `memory`: total/available RAM and Android's low-memory signal
- `storage`: free/total app data *volume* bytes, never private documents
- `network`: active local Wi-Fi/Ethernet characteristics without SSID or MAC
- `power`: battery saver state
- `app`: this Android LAN Client's own version and notification state

Each section fails independently with `{"unavailable": true}`, so a platform-specific diagnostic error does not hide other useful sections. A partial result sets `partial: true` and counts unavailable sections. Output is bounded by the existing server's 64-KiB diagnostic limit.

Signals are advisory, not a clinical or device-service diagnosis: battery <=15% while unplugged; battery temperature >=42°C; Android low-memory status; less than 10% free on the app data volume; Internet not validated on a network claiming Internet capability; and battery saver enabled. The snapshot does not collect SSIDs, MACs, app inventory, user files, accounts, contacts, credentials, screen pixels or UI text.

## Support status

Use **Screen / support status** in Tray, or `android.support_status`. The response reports only current transient capability booleans, never pairing/session tokens:

- `sessionApproved`
- `screenSharing` — only true when Android MediaProjection and the session permission are active
- `accessibilityEnabled` — OS accessibility service is enabled, not an authorization for remote input
- `remoteInputAllowed` — true only with a visible capture session, Accessibility and separate on-phone input consent
- `notificationsEnabled`, `ownerCanStop`

The device owner retains the local **Stop Sharing** and **Revoke** controls. The remote controller cannot grant itself screen capture or Accessibility permission by calling these diagnostics.

## Build and verification

```sh
cd apps/superagent-lan-android
./gradlew.bat :app:assembleLite :app:assembleDebug --offline
cd ../..
bun --bun x vitest run tests/androidHealthSnapshot.test.ts tests/androidLanExpandedControls.test.ts tests/androidLanClientContract.test.ts
bun --bun x tsc --noEmit
```

The Android version is `0.7.0-health-preview` with `versionCode 7`. It is intentionally a separate development build from the installed `0.6.0` app. Only install on an owner-approved device; review Android/ColorOS package verification instead of turning security off. See [the USB installer guide](android-adb-install.md).

This change does not yet prove physical phone-to-Tray E2E pairing, screenshots, remote input, transfer throughput, or runtime performance. Those remain release gates.
