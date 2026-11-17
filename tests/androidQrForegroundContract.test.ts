import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const mainActivity = fs.readFileSync(path.resolve(
  "apps/superagent-lan-android/app/src/main/java/click/superagent/lanclient/MainActivity.java",
), "utf8");
const scanner = fs.readFileSync("apps/superagent-lan-android/app/src/main/java/click/superagent/lanclient/AndroidQrScanner.java", "utf8");
const gradle = fs.readFileSync(path.resolve(
  "apps/superagent-lan-android/app/build.gradle",
), "utf8");

describe("Android QR scanner foreground return contract", () => {
  it("defers connecting until the scanner returns to the visible Activity", () => {
    expect(mainActivity).toContain("pendingQrPayload = raw;");
    expect(mainActivity).toContain("main.postDelayed(this::connectPendingQrWhenForeground, 700);");
    expect(mainActivity).toContain("main.postDelayed(this::connectPendingQrWhenForeground, 100);");
    expect(mainActivity).toContain("if (!visible || isFinishing() || launching || preparingFolder || pendingQrPayload == null) return;");
    expect(mainActivity).toContain("if (!visible || isFinishing()) {");
    expect(mainActivity).toContain("pendingQrPayload = setup;");
    expect(mainActivity).toContain("if (!requestingCapture && !ScreenProjectionService.isActive()) stopDirectSharing();");
    expect(mainActivity).toContain("TunnelForegroundService.requestStart(this, setup, sharedFileName, sharedFileBytes)");
  });

  it("shows QR scan progress and recovery errors beside the scanner control", () => {
    expect(mainActivity).toContain('qrScanStatus = label("Ready to scan the Connection QR');
    expect(mainActivity).toContain('qrFeedback("QR detected. Returning to SuperAgent to connect...");');
    expect(scanner).toContain("QR scanner failed (");
    expect(scanner).toContain("Use manual setup JSON instead.");
    expect(mainActivity).toContain("if (qrScanInProgress) return;");
    expect(mainActivity).toContain("qrScanInProgress = false;");
    expect(mainActivity).toContain("!AndroidQrScanner.isConnectPayload(raw)");
    expect(mainActivity).toContain("Use Create connect QR, not APK download QR.");
    expect(mainActivity).toContain("Wrong QR format. Choose Create connect QR in Tray.");
  });

  it("identifies the rebuilt Android APK with the next build number", () => {
    expect(gradle).toContain("versionCode 23");
  });
});
