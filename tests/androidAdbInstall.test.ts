import { describe, expect, it } from "vitest";
import {
  installAndroidApk, selectAuthorizedDevice, parsePackageDetails,
  type AdbRunner, type AdbResult, type AndroidInstallOptions,
} from "../src/core/android/adbInstall.js";

const target: AndroidInstallOptions = {
  packageName: "click.superagent.lanclient.lite",
  apkPath: "C:\\dev\\app-lite.apk",
  versionCode: 6,
  versionName: "0.6.0-folder-segments-preview-lite",
};
function result(stdout = "", code: number | null = 0, timedOut = false): AdbResult {
  return { code, stdout, stderr: "", timedOut };
}
function adbFixture(options: {
  initial?: "missing" | "current" | "old";
  final?: "missing" | "current" | "old";
  install?: AdbResult;
  devices?: string;
  beforeStamp?: string;
  afterStamp?: string;
  focus?: string;
} = {}) {
  const commands: string[][] = [];
  let installAttempted = false;
  let count = 0;
  const makePackage = (kind: string, stamp: string) => kind === "missing" ? "" :
    "Packages:\n  Package [" + target.packageName + "]:\n" +
    "    versionCode=" + (kind === "old" ? 5 : 6) + " minSdk=29\n" +
    "    versionName=" + (kind === "old" ? "0.5.0" : target.versionName) + "\n" +
    "    lastUpdateTime=" + stamp + "\n" +
    "    User 0: installed=true\n";
  const states = () => {
    const kind = installAttempted ? (options.final ?? "current") : (options.initial ?? "missing");
    const stamp = installAttempted ? (options.afterStamp ?? "2026-11-06 11:28:26") :
      (options.beforeStamp ?? "2026-11-05 09:00:00");
    return { kind, stamp };
  };
  const runner: AdbRunner = async (args) => {
    commands.push([...args]);
    if (args[0] === "devices") return result(options.devices ?? "List of devices attached\nSERIAL123\tdevice product:a model:b\n");
    if (args.includes("install")) {
      installAttempted = true;
      return options.install ?? result("Performing Streamed Install\nSuccess\n");
    }
    if (args.includes("pm")) {
      count++;
      const { kind } = states();
      return result(kind === "missing" ? "" : "package:/data/app/" + target.packageName + "/base.apk\n");
    }
    if (args.includes("dumpsys") && args.includes("package")) {
      const { kind, stamp } = states();
      return result(makePackage(kind, stamp));
    }
    if (args.includes("dumpsys") && args.includes("window")) return result(options.focus ?? "");
    throw Error("Unexpected ADB command " + args.join(" "));
  };
  return { runner, commands, get installCount() { return commands.filter((cmd) => cmd.includes("install")).length; }, get packageProbeCount() { return count; } };
}
describe("safe, owner-initiated Android LAN APK installer", () => {
  it("requires a single authorized device or explicit serial", () => {
    const devices = "List of devices attached\nSERIAL_A\tdevice\nSERIAL_B\toffline\n";
    expect(() => selectAuthorizedDevice(devices)).toThrow(/multiple/i);
    expect(() => selectAuthorizedDevice(devices, "SERIAL_B")).toThrow(/offline/);
    expect(selectAuthorizedDevice(devices, "SERIAL_A")).toBe("SERIAL_A");
    expect(() => selectAuthorizedDevice("List of devices attached\nSERIAL_A\tunauthorized\n")).toThrow(/unauthorized/);
    expect(() => selectAuthorizedDevice(devices, "bad;rm -rf")).toThrow(/invalid/i);
    expect(() => selectAuthorizedDevice("List of devices attached\nemulator-5554\tdevice\n")).toThrow(/USB-only/);
    expect(() => selectAuthorizedDevice("List of devices attached\n192.168.0.5:5555\tdevice\n")).toThrow(/USB-only|Unsafe/);
    expect(() => selectAuthorizedDevice("List of devices attached\nadb-myphone_adb-tls-connect._tcp\tdevice\n")).toThrow(/USB-only/);
  });
  it("reads the package manager version and last update time", () => {
    const parsed = parsePackageDetails(
      result("package:/data/app/abc/base.apk"),
      result("versionCode=6 minSdk=29\nversionName=" + target.versionName + "\nlastUpdateTime=2026-11-06 11:28:26\n"),
    );
    expect(parsed).toEqual({
      present: true, versionCode: 6, versionName: target.versionName,
      lastUpdateTime: "2026-11-06 11:28:26",
    });
  });
  it("never resends an APK if matching version is already installed", async () => {
    const f = adbFixture({ initial: "current" });
    const outcome = await installAndroidApk(target, f.runner);
    expect(outcome.status).toBe("already-installed");
    expect(f.installCount).toBe(0);
  });
  it("checks preflight without installing for dry run", async () => {
    const f = adbFixture();
    const outcome = await installAndroidApk({ ...target, dryRun: true }, f.runner);
    expect(outcome.status).toBe("dry-run");
    expect(f.installCount).toBe(0);
  });
  it("installs only once and verifies version after Success", async () => {
    const f = adbFixture();
    const outcome = await installAndroidApk(target, f.runner);
    expect(outcome.status).toBe("installed");
    expect(f.installCount).toBe(1);
    expect(f.commands.find((cmd) => cmd.includes("install"))).toEqual([
      "-s", "SERIAL123", "install", "-r", target.apkPath,
    ]);
  });
  it("accepts a genuine fresh installation confirmed after ADB timeout", async () => {
    const f = adbFixture({ install: result("Performing Streamed Install\n", 124, true) });
    const outcome = await installAndroidApk(target, f.runner);
    expect(outcome.status).toBe("installed-after-timeout");
    expect(f.installCount).toBe(1);
  });
  it("accepts a changed version confirmed after an ADB timeout", async () => {
    const f = adbFixture({ initial: "old", install: result("", null, true) });
    const outcome = await installAndroidApk(target, f.runner);
    expect(outcome.status).toBe("installed-after-timeout");
  });
  it("does not claim a forced reinstall succeeded from an unchanged matching version after timeout", async () => {
    const f = adbFixture({
      initial: "current", final: "current",
      beforeStamp: "2026-11-06 11:00:00", afterStamp: "2026-11-06 11:00:00",
      install: result("", 124, true),
    });
    const outcome = await installAndroidApk({ ...target, force: true }, f.runner);
    expect(outcome.status).toBe("indeterminate");
    expect(f.installCount).toBe(1);
  });
  it("reports verification failure and Play Protect focus without bypassing protection", async () => {
    const f = adbFixture({
      final: "missing",
      install: result("Failure [INSTALL_FAILED_VERIFICATION_FAILURE: Install not allowed]", 1),
      focus: "mFocusedApp=PlayProtectDialogsActivity",
    });
    const outcome = await installAndroidApk(target, f.runner);
    expect(outcome.status).toBe("verification-blocked");
    expect(outcome.playProtectDialog).toBe(true);
    expect(f.installCount).toBe(1);
    expect(f.commands.some((cmd) => cmd.includes("settings") || cmd.includes("disable"))).toBe(false);
  });
  it("reports signing, version, storage, and APK errors without unsafe recovery", async () => {
    const cases = [
      ["INSTALL_FAILED_UPDATE_INCOMPATIBLE", /different signing certificate/i],
      ["INSTALL_FAILED_VERSION_DOWNGRADE", /newer version/i],
      ["INSTALL_FAILED_INSUFFICIENT_STORAGE", /insufficient storage/i],
      ["INSTALL_FAILED_INVALID_APK", /SHA-256/i],
      ["INSTALL_FAILED_NO_MATCHING_ABIS", /CPU architecture/i],
    ] as const;
    for (const [code, message] of cases) {
      const f = adbFixture({ install: { ...result("", 1), stderr: "Failure [" + code + ": denied]" } });
      const outcome = await installAndroidApk(target, f.runner);
      expect(outcome.status).toBe("failed");
      expect(outcome.installErrorCode).toBe(code);
      expect(outcome.message).toMatch(message);
      expect(f.installCount).toBe(1);
      expect(f.commands.some((cmd) => cmd.includes("uninstall") || cmd.includes("disable"))).toBe(false);
    }
  });
  it("includes verification error codes without bypassing owner consent", async () => {
    const f = adbFixture({ install: { ...result("", 1), stderr: "Failure [INSTALL_FAILED_USER_RESTRICTED]" } });
    const outcome = await installAndroidApk(target, f.runner);
    expect(outcome.status).toBe("verification-blocked");
    expect(outcome.installErrorCode).toBe("INSTALL_FAILED_USER_RESTRICTED");
    expect(outcome.message).toContain("ColorOS");
  });
  it("does not call missing or wrong-version packages installed, even after ADB Success", async () => {
    const missing = adbFixture({ final: "missing" });
    const old = adbFixture({ final: "old" });
    expect((await installAndroidApk(target, missing.runner)).status).toBe("failed");
    expect((await installAndroidApk(target, old.runner)).status).toBe("failed");
  });
  it("rejects invalid timeouts and injection-like parameters before ADB execution", async () => {
    const f = adbFixture();
    await expect(installAndroidApk({ ...target, timeoutMs: 20_000 }, f.runner)).rejects.toThrow(/timeout/i);
    await expect(installAndroidApk({ ...target, packageName: "a;rm" }, f.runner)).rejects.toThrow(/package name/i);
    expect(f.commands).toHaveLength(0);
  });
});
