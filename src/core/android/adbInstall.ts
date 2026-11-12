/**
 * Owner-initiated, USB-only development APK installer.
 * Device-side confirmation is never bypassed, and an uncertain install is never retried.
 */
export interface AdbResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export type AdbRunner = (args: readonly string[], timeoutMs: number) => Promise<AdbResult>;
export interface AndroidApkTarget {
  apkPath: string;
  packageName: string;
  versionCode: number;
  versionName: string;
}
export interface AndroidInstallOptions extends AndroidApkTarget {
  serial?: string;
  force?: boolean;
  dryRun?: boolean;
  timeoutMs?: number;
}
export type AndroidInstallStatus =
  | "installed" | "installed-after-timeout" | "already-installed" | "dry-run"
  | "verification-blocked" | "indeterminate" | "failed";
export interface AndroidInstallOutcome {
  status: AndroidInstallStatus;
  serial: string;
  packageName: string;
  message: string;
  before: AndroidPackageState;
  after: AndroidPackageState;
  installExitCode?: number | null;
  installTimedOut?: boolean;
  playProtectDialog?: boolean;
  /** Sanitized Android package manager failure code. */
  installErrorCode?: string;
}
export interface AndroidPackageState {
  present: boolean;
  versionCode?: number;
  versionName?: string;
  lastUpdateTime?: string;
}
const PROBE_MS = 12_000;
const DEFAULT_INSTALL_MS = 120_000;
const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SERIAL_PATTERN = /^[A-Za-z0-9._-]{3,128}$/;
function androidInstallErrorCode(output: string): string | undefined {
  return /\b(INSTALL_FAILED_[A-Z0-9_]+)\b/.exec(output)?.[1];
}
function androidInstallFailureMessage(code?: string): string {
  switch (code) {
    case "INSTALL_FAILED_UPDATE_INCOMPATIBLE":
      return "Existing app has a different signing certificate. Preserve app data and verify its source before considering removal.";
    case "INSTALL_FAILED_VERSION_DOWNGRADE":
      return "A newer version is installed. Obtain a newer APK instead of forcing a downgrade.";
    case "INSTALL_FAILED_INSUFFICIENT_STORAGE":
      return "Android reports insufficient storage. Free space before an owner-approved retry.";
    case "INSTALL_FAILED_NO_MATCHING_ABIS":
      return "This APK does not support the device CPU architecture.";
    case "INSTALL_FAILED_INVALID_APK":
      return "Android rejected the APK format. Download again and compare SHA-256 with the download metadata.";
    default:
      return code
        ? "Android rejected installation (" + code + "). Inspect the device before manually retrying."
        : "Installation did not produce a confirmed matching package. Review the phone prompt and ADB output.";
  }
}
function isLocalUsbSerial(serial: string): boolean {
  return SERIAL_PATTERN.test(serial) && !/^emulator-/i.test(serial) &&
    !/^adb-.*_adb-tls/i.test(serial) && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(serial);
}

export function selectAuthorizedDevice(output: string, serial?: string): string {
  const entries = output.split(/\r?\n/).map((line) => {
    const parts = line.trim().match(/^(\S+)\s+(device|offline|unauthorized|recovery|sideload)(?:\s|$)/);
    return parts ? { serial: parts[1], status: parts[2] } : null;
  }).filter((value): value is { serial: string; status: string } => value !== null);
  if (serial && !SERIAL_PATTERN.test(serial)) throw new Error("Invalid ADB serial.");
  const matches = serial ? entries.filter((entry) => entry.serial === serial) : entries;
  if (matches.length === 0) throw new Error("No matching USB-authorized Android device. Check USB and run adb devices -l.");
  if (!serial && matches.length !== 1) throw new Error("Multiple Android devices connected. Specify --serial explicitly.");
  if (matches[0].status !== "device") throw new Error("ADB device is " + matches[0].status + ". Unlock and authorize USB debugging on the phone.");
  if (!isLocalUsbSerial(matches[0].serial)) throw new Error("ADB-over-network and emulator targets are not supported by this USB-only installer.");
  return matches[0].serial;
}

export function parsePackageDetails(pathResult: AdbResult, detailsResult?: AdbResult): AndroidPackageState {
  const present = pathResult.code === 0 && /^package:\S+/m.test(pathResult.stdout);
  if (!present) return { present: false };
  const text = detailsResult?.stdout ?? "";
  const versionCode = /\bversionCode=(\d+)\b/.exec(text)?.[1];
  const versionName = /\bversionName=([^\s\r\n]+)/.exec(text)?.[1];
  const lastUpdateTime = /\blastUpdateTime=([^\r\n]+)/.exec(text)?.[1]?.trim();
  return {
    present: true,
    ...(versionCode ? { versionCode: Number(versionCode) } : {}),
    ...(versionName ? { versionName } : {}),
    ...(lastUpdateTime ? { lastUpdateTime } : {}),
  };
}
async function getInstalledState(run: AdbRunner, serial: string, packageName: string): Promise<AndroidPackageState> {
  const prefix = ["-s", serial, "shell"] as const;
  const paths = await run([...prefix, "pm", "path", packageName], PROBE_MS);
  if (paths.timedOut || paths.code !== 0) throw new Error("ADB package status probe failed; installation result cannot be trusted.");
  if (!/^package:\S+/m.test(paths.stdout)) return { present: false };
  const details = await run([...prefix, "dumpsys", "package", packageName], PROBE_MS);
  if (details.timedOut || details.code !== 0) {
    return { present: true };
  }
  return parsePackageDetails(paths, details);
}
function matchesTarget(state: AndroidPackageState, target: AndroidApkTarget): boolean {
  return state.present && state.versionCode === target.versionCode && state.versionName === target.versionName;
}
function changedSince(before: AndroidPackageState, after: AndroidPackageState): boolean {
  return !before.present || before.versionCode !== after.versionCode ||
    before.versionName !== after.versionName ||
    (Boolean(before.lastUpdateTime) && Boolean(after.lastUpdateTime) &&
      before.lastUpdateTime !== after.lastUpdateTime);
}
function installedOutcome(
  status: AndroidInstallStatus, serial: string, target: AndroidApkTarget,
  message: string, before: AndroidPackageState, after: AndroidPackageState,
  details: Partial<AndroidInstallOutcome> = {},
): AndroidInstallOutcome {
  return { status, serial, packageName: target.packageName, message, before, after, ...details };
}
export async function installAndroidApk(
  options: AndroidInstallOptions,
  run: AdbRunner,
): Promise<AndroidInstallOutcome> {
  if (!PACKAGE_PATTERN.test(options.packageName)) throw new Error("Invalid APK package name.");
  if (!Number.isSafeInteger(options.versionCode) || options.versionCode < 1)
    throw new Error("Invalid APK versionCode.");
  if (!options.versionName || /[\r\n]/.test(options.versionName))
    throw new Error("Invalid APK versionName.");
  if (!options.apkPath || /[\r\n\0]/.test(options.apkPath)) throw new Error("Invalid APK path.");
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSTALL_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 300_000)
    throw new Error("Install timeout must be between 30,000 and 300,000 ms.");
  const list = await run(["devices", "-l"], PROBE_MS);
  if (list.timedOut || list.code !== 0) throw new Error("ADB device discovery failed.");
  const serial = selectAuthorizedDevice(list.stdout, options.serial);
  const before = await getInstalledState(run, serial, options.packageName);
  if (matchesTarget(before, options) && !options.force) {
    return installedOutcome("already-installed", serial, options,
      "Matching package version is already installed. No repeat installation was sent.",
      before, before);
  }
  if (options.dryRun) {
    return installedOutcome("dry-run", serial, options,
      "Preflight passed. No APK installation command was sent.", before, before);
  }
  // ADB sends only one install attempt. Never use an automatic retry or disable Play Protect.
  const attempt = await run(["-s", serial, "install", "-r", options.apkPath], timeoutMs);
  let after: AndroidPackageState;
  try {
    after = await getInstalledState(run, serial, options.packageName);
  } catch {
    return installedOutcome("indeterminate", serial, options,
      "Post-install status could not be verified. Do not automatically retry; inspect the phone.",
      before, { present: false }, { installExitCode: attempt.code, installTimedOut: attempt.timedOut });
  }
  const details = { installExitCode: attempt.code, installTimedOut: attempt.timedOut };
  const output = attempt.stdout + "\n" + attempt.stderr;
  const installErrorCode = androidInstallErrorCode(output);
  const failureDetails = { ...details, ...(installErrorCode ? { installErrorCode } : {}) };
  const verificationBlocked = /INSTALL_FAILED_VERIFICATION_FAILURE|INSTALL_FAILED_USER_RESTRICTED|INSTALL_FAILED_ABORTED|Install not allowed/i.test(output);
  if (verificationBlocked) {
    let playProtectDialog = false;
    try {
      const focus = await run(["-s", serial, "shell", "dumpsys", "window"], PROBE_MS);
      playProtectDialog = /PlayProtectDialogsActivity/.test(focus.stdout);
    } catch { /* ADB UI diagnostics are best-effort and read-only. */ }
    return installedOutcome("verification-blocked", serial, options,
      "Android refused this install. Review the Play Protect or ColorOS prompt on the unlocked phone; do not disable device security." +
      (installErrorCode ? " (" + installErrorCode + ")" : ""),
      before, after, { ...failureDetails, playProtectDialog });
  }
  if (attempt.timedOut) {
    if (matchesTarget(after, options) && changedSince(before, after)) {
      return installedOutcome("installed-after-timeout", serial, options,
        "ADB timed out, but Android package state proves the requested version was installed.",
        before, after, details);
    }
    return installedOutcome("indeterminate", serial, options,
      "ADB timed out. The requested update was not proven; no automatic retry was attempted.",
      before, after, details);
  }
  if (attempt.code === 0 && /(?:^|\n)Success\s*(?:\n|$)/.test(output) && matchesTarget(after, options)) {
    return installedOutcome("installed", serial, options,
      "ADB returned Success and Android confirms the expected package and version.",
      before, after, details);
  }
  // Some ADB responses may be incomplete; a changed package version is stronger evidence
  // than a truncated CLI response, unless the installer explicitly reported an error.
  if (attempt.code === 0 && matchesTarget(after, options) && changedSince(before, after) &&
      !/\bFailure\s*\[|INSTALL_FAILED_/.test(output)) {
    return installedOutcome("installed", serial, options,
      "Android confirms a newly installed package and matching version.",
      before, after, details);
  }
  return installedOutcome("failed", serial, options,
    androidInstallFailureMessage(installErrorCode),
    before, after, failureDetails);
}
