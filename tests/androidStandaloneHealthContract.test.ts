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
const tunnel = java("TunnelRelayClient");
const activity = java("MainActivity");
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
  it("supports an outbound-only HTTPS Device Tunnel without replacing local consent", () => {
    expect(activity).toContain("DEVICE TUNNEL · QR CONNECT");
    expect(activity).toContain("Scan QR & Connect");
    expect(activity).toContain("GmsBarcodeScanning.getClient");
    expect(activity).toContain("Barcode.FORMAT_QR_CODE");
    expect(activity).not.toContain("enableAutoZoom()");
    expect(activity).toContain("Hold the phone steady about 20–35 cm from the QR.");
    expect(androidBuild).toContain("play-services-code-scanner:16.1.0");
    expect(manifest).toContain("com.google.mlkit.vision.DEPENDENCIES");
    expect(manifest).toContain("barcode_ui");
    expect(activity).toContain("connectTunnelFromQr");
    expect(activity).toContain("AUTO · QR pairing");
    expect(activity).toContain("TunnelRelayClient");
    expect(tunnel).toContain('"https".equalsIgnoreCase(url.getProtocol())');
    expect(tunnel).toContain('setRequestProperty("Authorization", "Device " + authToken)');
    expect(tunnel).toContain("relayLocal(");
    expect(tunnel).toContain("/api/device-tunnel/qr-pair");
    expect(tunnel).toContain('"sat".equals(setup.optString("k", ""))');
    expect(tunnel).toContain('"superagent-device-tunnel".equals(setup.optString("kind", ""))');
    expect(tunnel).toContain("Local TLS fingerprint changed.");
    expect(tunnel).not.toContain("SUPERAGENT_SERVER_AUTH_TOKEN");
    expect(tunnel).not.toContain("x-auth-token");
  });
  it("maintains Android restricted-permission exclusions", () => {
    for (const forbidden of ["REQUEST_INSTALL_PACKAGES", "MANAGE_EXTERNAL_STORAGE",
      "QUERY_ALL_PACKAGES", "WRITE_SECURE_SETTINGS", "DEVICE_ADMIN"]) {
      expect(manifest).not.toContain(forbidden);
    }
    expect(androidBuild).toContain("versionCode 17");
    expect(androidBuild).toContain("versionName '0.10.0-native-dashboard'");
    expect(fs.existsSync(path.join(root, "gradle/wrapper/gradle-wrapper.jar"))).toBe(true);
  });
});
