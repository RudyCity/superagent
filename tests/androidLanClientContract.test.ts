import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve("apps/superagent-lan-android");
const src = path.join(root, "app/src/main/java/click/superagent/lanclient");
const load = (name: string) => fs.readFileSync(path.join(src, name + ".java"), "utf8");
const manifest = fs.readFileSync(path.join(root, "app/src/main/AndroidManifest.xml"), "utf8");
const protocol = load("LanClientServer");
const activity = load("MainActivity");
const diagnostics = load("AndroidDiagnostics");
const network = load("LanNetwork");
const identity = load("LanIdentity");
const tray = fs.readFileSync(path.resolve("apps/superagent-tray/ui/lan-devices.js"), "utf8");
const controller = fs.readFileSync(path.resolve("src/core/lanRemote/controller.ts"), "utf8");

describe("Android LAN Client source and wire-protocol contract", () => {
  it("uses an explicitly consented foreground MediaProjection service and no covert capabilities", () => {
    expect(manifest).toContain('android.permission.INTERNET');
    expect(manifest).toContain('android.permission.ACCESS_NETWORK_STATE');
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:usesCleartextTraffic="false"');
    for (const disallowed of ["DEVICE_ADMIN", "SYSTEM_ALERT_WINDOW",
      "REQUEST_INSTALL_PACKAGES", "QUERY_ALL_PACKAGES", "WRITE_SECURE_SETTINGS",
      "MANAGE_EXTERNAL_STORAGE", "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"])
      expect(manifest).not.toContain(disallowed);
    expect(manifest).toContain('android:foregroundServiceType="mediaProjection"');
    expect(manifest).toContain('android:stopWithTask="true"');
    expect(manifest).toContain('android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE"');
    expect(manifest).toContain('android:exported="false"');
    expect(manifest).toContain('android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION');
    expect(manifest).toContain('android.permission.POST_NOTIFICATIONS');
    expect(activity).toContain("onStop()");
    expect(activity).toContain("stopSharing()");
    expect(activity).toContain('setPositiveButton("APPROVE"');
    expect(activity).toContain('setNegativeButton("DENY"');
  });

  it("uses an ephemeral per-sharing P-256 TLS 1.3 identity and independently pinned fingerprint", () => {
    // OEM Keymaster rejected handshake signing. The current implementation
    // uses a fresh process-local key/certificate and never persists a private key.
    expect(identity).toContain('KeyPairGenerator.getInstance("EC")');
    expect(identity).toContain('new ECGenParameterSpec("secp256r1")');
    expect(identity).toContain('KeyStore.getInstance("PKCS12")');
    expect(identity).toContain('store.load(null, password)');
    expect(identity).toContain('SSLContext.getInstance("TLSv1.3")');
    expect(identity).toContain('MessageDigest.getInstance("SHA-256")');
    expect(protocol).toContain('setEnabledProtocols(new String[] {"TLSv1.3"})');
    expect(protocol).not.toContain("TrustManager[]"); // No disabled TLS validation on the target.
    expect(tray).toContain('"lan-verified").checked');
  });

  it("enforces on-link Wi-Fi/Ethernet, short-lived pairing and explicit sessions", () => {
    expect(network).toContain("TRANSPORT_WIFI");
    expect(network).toContain("TRANSPORT_ETHERNET");
    expect(network).toContain("TRANSPORT_VPN");
    expect(network).not.toContain("TRANSPORT_CELLULAR");
    expect(protocol).toContain("LanNetwork.permitsPeer");
    expect(protocol).toContain("PAIR_MS = 120_000");
    expect(protocol).toContain("attempts >= 5");
    expect(protocol).toContain('approval.ask("pair"');
    expect(protocol).toContain('approval.ask("session"');
    expect(protocol).toContain('expires = 0; // Pair code is single-use');
    expect(protocol).toContain("SESSION_IDLE_MS = 600_000");
    expect(protocol).toContain("SESSION_MAX_MS = 3_600_000");
    expect(protocol).toContain("MAX_REQUEST_BYTES = 8192");
  });

  it("matches Windows controller reply and LAN discovery envelopes", () => {
    for (const key of ["pairId", "pairToken", "sessionId", "sessionToken", "fingerprint", "platform"]) {
      expect(protocol).toContain('"' + key + '"');
    }
    expect(protocol).toContain('"SUPERAGENT_LAN_DISCOVER_2:"');
    expect(protocol).toContain('"segmentTag"');
    expect(protocol).toContain('"android"');
    expect(controller).toContain('reply.platform === "android"');
    expect(controller).toContain('platform: device.platform');
  });

  it("only supports whitelisted read-only diagnostics and no general shell", () => {
    for (const command of ["android.info", "android.network", "android.battery", "android.storage",
      "id", "uname -a", "getprop ro.product.model", "getprop ro.build.version.release"]) {
      expect(diagnostics).toContain('"' + command + '"');
      expect(tray).toContain('"' + command + '"');
    }
    expect(diagnostics).toContain("if (!allowed(command))");
    expect(protocol).toContain("AndroidDiagnostics.run");
    expect(protocol).not.toContain("new ProcessBuilder(");
    expect(protocol).not.toContain("Runtime.getRuntime()");
    expect(diagnostics).not.toContain("new ProcessBuilder(");
    expect(diagnostics).not.toContain("Runtime.getRuntime()");
  });

  it("keeps Android APK build reproducible with a Gradle wrapper", () => {
    expect(fs.existsSync(path.join(root, "gradlew.bat"))).toBe(true);
    expect(fs.existsSync(path.join(root, "gradle/wrapper/gradle-wrapper.jar"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "gradle/wrapper/gradle-wrapper.properties"), "utf8"))
      .toContain("gradle-9.6.1-bin.zip");
    expect(fs.readFileSync(path.join(root, "app/build.gradle"), "utf8"))
      .toContain("minSdk 29");
  });
});
