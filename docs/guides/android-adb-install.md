# SuperAgent Android LAN development APK — reliable USB installation

Use the local **developer-only** installer with an owner-authorized USB connection. It is not a network-facing LAN or Tray endpoint and never installs packages through remote pairing.

## Commands

From the SuperAgent repository root:

```sh
cd apps/superagent-lan-android
./gradlew.bat :app:assembleLite
cd ../..
bun scripts/install-android-lan.ts --variant=lite --dry-run
bun scripts/install-android-lan.ts --variant=lite
```

If multiple ADB devices are attached, select the serial displayed by `adb devices -l`:

```sh
bun scripts/install-android-lan.ts --variant=lite --serial=YOUR_DEVICE_SERIAL
```

The normal debug build may be installed with `--variant=debug`. The installer reads `output-metadata.json` to select the correct APK, package name and expected version. It refuses unexpected variant metadata and missing APKs. The default ADB installation timeout is **120 seconds**, configurable to 30–300 seconds with `--timeout-ms=...`.

## Outcomes and safety

- `already-installed`: matching package/version was present; the installer does not resend APK. Use `--force` only for an intentional reinstall of the same version.
- `installed`: the install command and the Android package manager confirm the expected version.
- `installed-after-timeout`: ADB timed out but a **new** matching installed package or changed version/last-update timestamp proves installation.
- `verification-blocked`: Android denied the request, e.g. `INSTALL_FAILED_VERIFICATION_FAILURE`. Unlock the device and review its Play Protect/ColorOS prompt. Never disable security protections as a workaround.
- `indeterminate`: a timeout or failed status probe cannot prove what happened. Inspect `adb shell pm path click.superagent.lanclient.lite` and `adb shell dumpsys package click.superagent.lanclient.lite` before deciding whether an explicit retry is necessary.
- `failed`: ADB and installed package state do not confirm the requested version.

The installer performs **one** install attempt, never retries after an ambiguous outcome, and never modifies device security settings. A pre-existing matching version alone cannot prove a forced reinstall completed after a timeout. The final package manager check is authoritative for whether the expected APK package/version is installed, not whether each feature works after launch.

The app uses two distinct package names, `click.superagent.lanclient` and `click.superagent.lanclient.lite`, so both can appear on the phone. Lite omits the Accessibility service and remote touch capability.

## Validation

```sh
bun --bun x vitest run tests/androidAdbInstall.test.ts
bun --bun x tsc --noEmit
```

Do not automatically initiate an install from a remote ChatGPT session. Only the local device owner should approve debugging access and security confirmation dialogs.
