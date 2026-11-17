import { describe, expect, it } from "vitest";
import fs from "node:fs";

const base = "apps/superagent-lan-android/app/src/main/java/click/superagent/lanclient/";
const service = fs.readFileSync(base + "LanTransferForegroundService.java", "utf8");
const activity = fs.readFileSync(base + "MainActivity.java", "utf8");
const server = fs.readFileSync(base + "LanClientServer.java", "utf8");
const androidV2 = fs.readFileSync(base + "LanFileExchangeV2.java", "utf8");
const manifest = fs.readFileSync("apps/superagent-lan-android/app/src/main/AndroidManifest.xml", "utf8");

describe("Owner-approved Android V2 foreground transfer lifecycle", () => {
  it("requires an actual foreground service with a visible Stop Sharing control", () => {
    expect(manifest).toContain('android:name=".LanTransferForegroundService"');
    expect(manifest).toContain('android:foregroundServiceType="connectedDevice"');
    expect(service).toContain("startForeground(NOTICE_ID");
    expect(service).toContain("FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE");
    expect(service).toContain('"STOP SHARING"');
    expect(service).toContain("START_NOT_STICKY");
    expect(service).toContain("previous.close()");
    expect(manifest).toContain('android:exported="false"');
  });
  it("only hands off after an actual phone-owner approval", () => {
    expect(server).toContain('approval.ask("file:" + description');
    expect(server).toContain("LanTransferForegroundService.requestHold(context, this)");
    expect(service).toContain("MainActivity.canShowLanTransferNotification()");
    expect(activity).toContain("owner.notificationsReady()");
    expect(activity).toContain("return owner != null && owner.visible && !owner.isFinishing()");
    expect(activity).toContain("if (owner == null || !owner.visible || owner.isFinishing()) return false");
  });
  it("continues only the approved upload and revokes sharing when the owner stops", () => {
    expect(activity).toContain("LanTransferForegroundService.isHolding(server)");
    expect(activity).toContain("LanTransferForegroundService.requestStop(this)");
    expect(service).toContain("!target.isV2TransferActive()");
    expect(server).toContain("fileExchangeV2.suspend()");
    expect(server).toContain("fileExchangeV2.purge()");
    expect(androidV2).toContain("public synchronized boolean isTransferActive()");
    expect(androidV2).toContain("generation.incrementAndGet()");
  });
});
