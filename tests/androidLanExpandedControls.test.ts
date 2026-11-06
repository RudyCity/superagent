import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ANDROID_APPROVED_ACTIONS,
  ANDROID_READONLY_DIAGNOSTICS,
  isAllowedAndroidLanCommand,
  requiresAndroidOwnerActionApproval,
} from "../src/core/lanRemote/androidCapabilities.js";

const root = path.resolve("apps/superagent-lan-android/app/src/main/java/click/superagent/lanclient");
const file = (name: string) => fs.readFileSync(path.join(root, name + ".java"), "utf8");
const diagnostics = file("AndroidDiagnostics");
const actions = file("AndroidSupportActions");
const client = file("LanClientServer");
const activity = file("MainActivity");
const tray = fs.readFileSync("apps/superagent-tray/ui/lan-devices.js", "utf8");
const controller = fs.readFileSync("src/core/lanRemote/controller.ts", "utf8");
const rust = fs.readFileSync("apps/superagent-tray/src-tauri/src/main.rs", "utf8");

function javaStringConstants(list: string): string[] {
  const start = list.indexOf('ALLOWED = List.of(');
  expect(start).toBeGreaterThan(-1);
  const end = list.indexOf(');', start);
  return [...list.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe("Android expanded local support command allowlist", () => {
  it("keeps Java target, TS controller and Tray presets synchronized", () => {
    expect([...javaStringConstants(diagnostics)].sort()).toEqual([...ANDROID_READONLY_DIAGNOSTICS].sort());
    expect([...javaStringConstants(actions)].sort()).toEqual([...ANDROID_APPROVED_ACTIONS].sort());
    for (const command of [...ANDROID_READONLY_DIAGNOSTICS, ...ANDROID_APPROVED_ACTIONS]) {
      expect(tray).toContain('"' + command + '"');
      expect(isAllowedAndroidLanCommand(command)).toBe(true);
    }
    expect(new Set([...ANDROID_READONLY_DIAGNOSTICS, ...ANDROID_APPROVED_ACTIONS]).size)
      .toBe(ANDROID_READONLY_DIAGNOSTICS.length + ANDROID_APPROVED_ACTIONS.length);
  });

  it("rejects unknown commands and arbitrary shell or spoofed actions", () => {
    for (const command of ["", "sh -c id", "adb shell", "settings put system screen_brightness 255",
      "android.action.open_wifi_settings; rm -rf /", "android.action.open_developer_settings",
      "android.action.open_wifi_settings\nandroid.info", "android.action.volume_up ".trimStart().concat(" "),
      "android.info && pm list packages"]) {
      expect(isAllowedAndroidLanCommand(command)).toBe(false);
    }
    expect(controller).toContain('d.platform === "android" && !isAllowedAndroidLanCommand(command)');
    expect(client).not.toMatch(/new\s+ProcessBuilder\s*\(/);
    expect(client).not.toMatch(/\bexecRuntime\(/);
    expect(diagnostics).not.toMatch(/Runtime\.getRuntime\s*\(/);
    expect(actions).not.toContain("ACTION_APPLICATION_DEVELOPMENT_SETTINGS");
    expect(actions).not.toContain("ACTION_ACCESSIBILITY_SETTINGS");
    expect(actions).not.toContain("ACTION_MANAGE_OVERLAY_PERMISSION");
  });

  it("only the Android action catalog requires individual on-phone approval", () => {
    for (const command of ANDROID_APPROVED_ACTIONS) {
      expect(requiresAndroidOwnerActionApproval(command)).toBe(true);
    }
    for (const command of ANDROID_READONLY_DIAGNOSTICS) {
      expect(requiresAndroidOwnerActionApproval(command)).toBe(false);
    }
    expect(client).toContain('approval.ask("action:" + command');
    expect(client).toContain('isStillAuthorized(active, owner, ip)');
    expect(client).toContain("approvedAction.launch(command");
    expect(activity).toContain('kind.startsWith("action:")');
    expect(activity).toContain('AndroidSupportActions.description(kind.substring(7))');
    expect(activity).toContain('setNegativeButton("DENY"');
    expect(activity).toContain("stillAuthorized.getAsBoolean()");
  });

  it("opens only fixed system Settings intents, never changes privileged settings", () => {
    const intents = [
      "ACTION_WIFI_SETTINGS", "ACTION_BLUETOOTH_SETTINGS", "ACTION_DISPLAY_SETTINGS",
      "ACTION_BATTERY_SAVER_SETTINGS", "ACTION_INTERNAL_STORAGE_SETTINGS",
      "ACTION_APPLICATION_SETTINGS", "ACTION_APPLICATION_DETAILS_SETTINGS", "ACTION_DATE_SETTINGS",
    ];
    for (const name of intents) expect(actions).toContain("Settings." + name);
    expect(actions).toContain('context.getPackageName()');
    expect(actions).not.toMatch(/Settings\.(?:System|Secure|Global)\.put/);
    expect(actions).not.toContain("setWifiEnabled");
    expect(activity).toContain("stopSharing();");
    expect(activity).toContain("startActivity(intent);");
  });

  it("bounds non-settings control to a single media volume step and shows Android UI", () => {
    expect(actions).toContain("AudioManager.ADJUST_RAISE");
    expect(actions).toContain("AudioManager.ADJUST_LOWER");
    expect(actions).toContain("AudioManager.FLAG_SHOW_UI");
    expect(actions).toContain("isVolumeAction(command)");
    expect(tray).toContain("REQUIRES PHONE APPROVAL");
    expect(tray).toContain("window.confirm(");
    expect(tray).toContain("emergencyAccessStop");
  });

  it("does not time out while the phone owner is considering an action", () => {
    expect(controller).toContain("? 115_000 : 40_000");
    expect(rust).toContain('command.starts_with("android.action.")');
    expect(rust).toContain("Duration::from_secs(120)");
    expect(client).toContain('approval.ask("action:" + command, owner.label, ip, 90)');
    expect(controller).toContain("sessions.delete(id)");
  });
});
