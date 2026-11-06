import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve("apps/superagent-lan-android");
const java = (name: string) => fs.readFileSync(
  path.join(root, "app/src/main/java/click/superagent/lanclient", name + ".java"), "utf8",
);
const diagnostics = java("AndroidDiagnostics");
const health = java("AndroidHealthSnapshot");
const permit = java("RemoteControlPermit");
const androidBuild = fs.readFileSync(path.join(root, "app/build.gradle"), "utf8");
const manifest = fs.readFileSync(path.join(root, "app/src/main/AndroidManifest.xml"), "utf8");

describe("Android 0.7 standalone health and consent contract", () => {
  it("registers exactly two additional read-only diagnostics", () => {
    for (const command of ["android.health", "android.support_status"]) {
      expect(diagnostics).toContain('"' + command + '"');
      expect(diagnostics).toContain('case "' + command + '"');
    }
    expect(diagnostics).toContain("AndroidHealthSnapshot.health(context, link)");
    expect(diagnostics).toContain("AndroidHealthSnapshot.supportStatus(context)");
    expect(diagnostics).toContain("if (!allowed(command))");
  });
  it("reuses Android API-backed diagnostics, with no arbitrary shell", () => {
    for (const existing of ["android.info", "android.battery", "android.memory", "android.storage",
      "android.network_details", "android.power", "android.app"]) {
      expect(health).toContain('section(context, "' + existing + '", link)');
    }
    for (const signal of ["LOW_BATTERY", "WARM_BATTERY", "LOW_MEMORY", "LOW_STORAGE",
      "NETWORK_NOT_VALIDATED", "BATTERY_SAVER"]) expect(health).toContain('"' + signal + '"');
    expect(health).toContain('.put("partial", unavailableCount > 0)');
    expect(health).not.toMatch(/Runtime\.getRuntime\(|new ProcessBuilder\s*\(/);
  });
  it("reads ephemeral permissions without granting new privileges", () => {
    for (const read of ["RemoteControlPermit.hasApprovedSession()",
      "RemoteControlPermit.canView()", "RemoteControlPermit.canControl()",
      "ScreenProjectionService.isActive()", "ControlledAccessibilityService.enabled()"]) {
      expect(health).toContain(read);
    }
    expect(permit).toContain("userEnabledInput = enabled && screenCaptureActive && approvedSession");
    expect(health).not.toContain("inputConsent(true)");
    expect(health).not.toContain("projection(true)");
  });
  it("maintains Android restricted-permission exclusions", () => {
    for (const forbidden of ["REQUEST_INSTALL_PACKAGES", "MANAGE_EXTERNAL_STORAGE",
      "QUERY_ALL_PACKAGES", "WRITE_SECURE_SETTINGS", "DEVICE_ADMIN"]) {
      expect(manifest).not.toContain(forbidden);
    }
    expect(androidBuild).toContain("versionCode 8");
    expect(androidBuild).toContain("versionName '0.7.1-routed-lan-preview'");
    expect(fs.existsSync(path.join(root, "gradle/wrapper/gradle-wrapper.jar"))).toBe(true);
  });
});
