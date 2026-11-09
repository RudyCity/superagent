import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ANDROID_READONLY_DIAGNOSTICS, ANDROID_APPROVED_ACTIONS,
  isAllowedAndroidLanCommand, requiresAndroidOwnerActionApproval,
} from "../src/core/lanRemote/androidCapabilities.js";

const javaDir = "apps/superagent-lan-android/app/src/main/java/click/superagent/lanclient/";
const java = (name: string) => fs.readFileSync(javaDir + name + ".java", "utf8");
const diagnostics = java("AndroidDiagnostics");
const health = java("AndroidHealthSnapshot");
const server = java("LanClientServer");
const permit = java("RemoteControlPermit");
const tray = fs.readFileSync("apps/superagent-tray/ui/lan-devices.js", "utf8");
const trayHtml = fs.readFileSync("apps/superagent-tray/ui/index.html", "utf8");
const build = fs.readFileSync("apps/superagent-lan-android/app/build.gradle", "utf8");
const manifest = fs.readFileSync("apps/superagent-lan-android/app/src/main/AndroidManifest.xml", "utf8");

function javaAllowlist(source: string): string[] {
  const start = source.indexOf("ALLOWED = List.of(");
  const end = source.indexOf(");", start);
  expect(start).toBeGreaterThan(-1);
  return Array.from(source.slice(start, end).matchAll(/"([^"]+)"/g), (match) => match[1]);
}

describe("Android health snapshot and owner consent contract", () => {
  it("keeps on-phone, controller and Tray allowlists synchronized", () => {
    expect(javaAllowlist(diagnostics).sort()).toEqual([...ANDROID_READONLY_DIAGNOSTICS].sort());
    expect(new Set([...ANDROID_READONLY_DIAGNOSTICS, ...ANDROID_APPROVED_ACTIONS]).size)
      .toBe(ANDROID_READONLY_DIAGNOSTICS.length + ANDROID_APPROVED_ACTIONS.length);
    for (const command of ["android.health", "android.support_status"]) {
      expect(isAllowedAndroidLanCommand(command)).toBe(true);
      expect(requiresAndroidOwnerActionApproval(command)).toBe(false);
      expect(diagnostics).toContain('case "' + command + '"');
      expect(tray).toContain('"' + command + '"');
    }
    expect(isAllowedAndroidLanCommand("android.health; shell")).toBe(false);
  });
  it("only reuses existing bounded Android API diagnostics", () => {
    for (const section of ["android.info", "android.battery", "android.memory", "android.storage",
      "android.network_details", "android.power", "android.app"]) {
      expect(health).toContain('section(context, "' + section + '", link)');
    }
    expect(health).toContain('new JSONObject(AndroidDiagnostics.run(context, command, link))');
    expect(health).toContain('.put("unavailable", true)');
    expect(health).toContain('.put("partial", unavailableCount > 0)');
    expect(health).toContain('.put("schemaVersion", 1)');
    expect(health).toContain('countWarnings(signals)');
    for (const code of ["LOW_BATTERY", "WARM_BATTERY", "LOW_MEMORY", "LOW_STORAGE",
      "NETWORK_NOT_VALIDATED", "BATTERY_SAVER"]) expect(health).toContain('"' + code + '"');
    expect(server).toContain("output.getBytes(StandardCharsets.UTF_8).length > 64 * 1024");
    expect(health).not.toMatch(/new ProcessBuilder\s*\(|Runtime\.getRuntime\s*\(/);
  });
  it("reports authorization state without exposing session secrets or enabling control", () => {
    expect(health).toContain("RemoteControlPermit.hasApprovedSession()");
    expect(health).toContain("RemoteControlPermit.canView()");
    expect(health).toContain("RemoteControlPermit.canControl()");
    expect(health).toContain("ControlledAccessibilityService.enabled()");
    expect(health).toContain("ScreenProjectionService.isActive()");
    for (const field of ["sessionApproved", "screenSharing", "accessibilityEnabled",
      "remoteInputAllowed", "notificationsEnabled", "ownerCanStop"]) expect(health).toContain('"' + field + '"');
    expect(permit).toContain("userEnabledInput = enabled && screenCaptureActive && approvedSession");
    expect(health).not.toMatch(/inputConsent\s*\(|session\s*\(true\)|projection\s*\(true\)|\.put\("pairToken"|\.put\("sessionToken"/);
  });
  it("renders two shortcuts only for selected Android support sessions", () => {
    for (const id of ["lan-android-quick-actions", "lan-health-quick", "lan-support-quick"]) {
      expect(trayHtml).toContain('id="' + id + '"');
      expect(tray).toContain(id);
    }
    expect(tray).toContain('platform !== "android"');
    expect(tray).toContain('selected.platform !== "android" || state.busy');
    expect(tray).toContain('void operation("exec", { deviceId: selected.id, command }');
    expect(tray).toContain('if (!selected || selected.platform !== "android" || state.busy) return;');
    expect(trayHtml).toContain("owner"); // Consent is explicit in the panel.
  });
  it("does not add dangerous Android permissions or new transport", () => {
    for (const restricted of ["REQUEST_INSTALL_PACKAGES", "QUERY_ALL_PACKAGES",
      "MANAGE_EXTERNAL_STORAGE", "WRITE_SECURE_SETTINGS", "DEVICE_ADMIN"])
      expect(manifest).not.toContain(restricted);
    expect(health).not.toContain("TelephonyManager");
    expect(health).not.toContain("getInstalledPackages");
    expect(health).not.toContain("getScanResults");
    expect(health).not.toContain("MediaProjectionManager");
    expect(health).not.toContain("getRootInActiveWindow");
  });
  it("bumps APK version so old 0.6.0 install does not mask this build", () => {
    expect(build).toContain("versionCode 14");
    expect(build).toContain("versionName '0.9.1-qr-scan-fix'");
  });
});
