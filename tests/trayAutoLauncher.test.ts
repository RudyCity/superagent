import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { shouldAutoLaunchTray, trayExecutableCandidates,
  trayPreferencesAllowAutoLaunch } from "../src/core/runtime/trayAutoLauncher.js";

const temporaryDirs: string[] = [];
afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, {recursive:true, force:true});
});
function isolatedConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-tray-launch-"));
  temporaryDirs.push(dir);
  return dir;
}

describe("SuperAgent Tray auto-launch guard", () => {
  it("launches on Windows for an interactive or server owner by default", () => {
    expect(shouldAutoLaunchTray({}, "win32")).toBe(true);
    expect(shouldAutoLaunchTray({ SUPERAGENT_TRAY_AUTOSTART: "1" }, "win32")).toBe(true);
    // Generic CI=1 is also set by the local SuperAgent connector process.
    expect(shouldAutoLaunchTray({ CI: "1" }, "win32")).toBe(true);
  });

  it("never starts GUI from tests, CI, core worker or non-Windows host", () => {
    for (const env of [
      { SUPERAGENT_TRAY_AUTOSTART: "0" },
      { SUPERAGENT_TRAY_CHILD: "1" },
      { SUPERAGENT_CORE_WORKER: "1" },
      { GITHUB_ACTIONS: "true" }, { TF_BUILD: "True" }, { VITEST: "true" },
      { NODE_ENV: "test" }, { BUN_TEST: "1" },
    ]) expect(shouldAutoLaunchTray(env, "win32")).toBe(false);
    expect(shouldAutoLaunchTray({}, "linux")).toBe(false);
  });

  it("honors persisted auto-launch preference with environment override precedence", () => {
    const dir = isolatedConfig();
    const file = path.join(dir, "tray-settings.json");
    expect(trayPreferencesAllowAutoLaunch(dir, {})).toBe(true);
    const pref = {
      version: 1, autoLaunchWithSuperagent: false, notificationsEnabled: true,
      closeToTray: true, runtimeScanSeconds: 20, jobsRefreshSeconds: 30,
      notificationPollSeconds: 15, startupPage: "jobs",
    };
    fs.writeFileSync(file, JSON.stringify(pref));
    expect(trayPreferencesAllowAutoLaunch(dir, {})).toBe(false);
    expect(trayPreferencesAllowAutoLaunch(dir, {SUPERAGENT_TRAY_AUTOSTART:"1"})).toBe(true);
    expect(trayPreferencesAllowAutoLaunch(dir, {SUPERAGENT_TRAY_AUTOSTART:"0"})).toBe(false);
    pref.autoLaunchWithSuperagent = true;
    fs.writeFileSync(file, JSON.stringify(pref));
    expect(trayPreferencesAllowAutoLaunch(dir, {})).toBe(true);
    fs.writeFileSync(file, "not json");
    expect(trayPreferencesAllowAutoLaunch(dir, {})).toBe(false);
    fs.writeFileSync(file, JSON.stringify({...pref, command:"shutdown"}));
    expect(trayPreferencesAllowAutoLaunch(dir, {})).toBe(false);
    fs.writeFileSync(file, " ".repeat(4097));
    expect(trayPreferencesAllowAutoLaunch(dir, {})).toBe(false);
  });

  it("resolves explicit executable then per-user installed path, release and debug", () => {
    const root = path.resolve("G:/project/superagent");
    const config = isolatedConfig();
    const explicit = path.resolve("C:/Tools/superagent-tray.exe");
    const candidates = trayExecutableCandidates(root, config, explicit);
    expect(candidates[0]).toBe(explicit);
    expect(candidates).toContain(path.join(config, "bin", "superagent-tray.exe"));
    expect(candidates).toContain(path.join(root, "apps", "superagent-tray", "src-tauri", "target", "release", "superagent-tray.exe"));
    expect(candidates).toContain(path.join(root, "apps", "superagent-tray", "src-tauri", "target", "debug", "superagent-tray.exe"));
    expect(candidates.indexOf(explicit)).toBeLessThan(candidates.indexOf(path.join(config, "bin", "superagent-tray.exe")));
    expect(candidates.indexOf(path.join(config, "bin", "superagent-tray.exe"))).toBeLessThan(
      candidates.indexOf(path.join(root, "apps", "superagent-tray", "src-tauri", "target", "release", "superagent-tray.exe"))
    );
    expect(trayExecutableCandidates(root, config, "relative.exe")).not.toContain("relative.exe");
  });
});
