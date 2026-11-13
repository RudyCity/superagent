import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve("apps/superagent-lan-android/app/src/main");
const src = path.join(root, "java/click/superagent/lanclient");
const load = (name: string) => fs.readFileSync(path.join(src, name + ".java"), "utf8");
const manifest = fs.readFileSync(path.join(root, "AndroidManifest.xml"), "utf8");
const server = load("LanClientServer");
const service = load("TunnelForegroundService");
const activity = load("MainActivity");
const relay = load("TunnelRelayClient");
const diagnostics = load("AndroidDiagnostics");

describe("Android internet Device Tunnel foreground service contract", () => {
  it("accepts cellular/Internet tunnel traffic through pinned TLS on loopback only", () => {
    expect(server).toContain("public Info startTunnelLoopback()");
    expect(server).toContain('listener.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 8)');
    expect(server).toContain('loopbackOnly = true;');
    expect(server).toContain('if (loopbackOnly) return "127.0.0.1".equals(remoteIp) && "127.0.0.1".equals(localIp);');
    expect(server).toContain("private boolean permitsPeer(");
    expect(server).toContain("LanNetwork.permitsPeer(context, link, remoteIp)");
    expect(service).toContain('local.startTunnelLoopback()');
    expect(service).toContain('client.start(request.setup, "127.0.0.1"');
    expect(service).not.toContain("new DatagramSocket(");
    expect(server).toContain("approval.ask(\"pair\"");
    expect(server).toContain("approval.ask(\"session\"");
  });

  it("owns the tunnel independently of Activity lifecycle with a visible STOP notification", () => {
    expect(manifest).toContain('android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE');
    expect(manifest).toContain('android:foregroundServiceType="connectedDevice"');
    expect(manifest).toContain('android:name=".TunnelForegroundService"');
    expect(manifest).toContain('android:exported="false"');
    expect(manifest).toContain('android:stopWithTask="false"');
    expect(service).toContain("startForeground(NOTIFICATION_ID, notification");
    expect(service).toContain('"STOP SHARING", stopAction');
    expect(service).toContain("START_NOT_STICKY");
    expect(service).toContain("active.getAndSet(false)");
    expect(activity).toContain("if (!requestingCapture && !ScreenProjectionService.isActive()) stopDirectSharing()");
    expect(activity).toContain("TunnelForegroundService.requestStop(this)");
    expect(activity).not.toContain("private volatile TunnelRelayClient tunnelRelay;");
  });

  it("denies background approvals, and keeps screen and input opt-in", () => {
    expect(activity).toContain("if (owner == null || !owner.visible || owner.isFinishing()) return false;");
    expect(service).toContain("MainActivity::requestTunnelApproval");
    expect(service).toContain("MainActivity::executeTunnelApprovedAction");
    expect(server).toContain("RemoteControlPermit.canView()");
    expect(server).toContain("RemoteControlPermit.canControl()");
    expect(server).toContain("ControlledAccessibilityService.enabled()");
    expect(service).toContain("RemoteControlPermit.revoke()");
    expect(service).toContain("ScreenProjectionService.stop(this)");
  });

  it("reports pairing failure without a false connected state and reconnects boundedly", () => {
    expect(relay).toContain("Device Tunnel enrolled; waiting for on-phone QR pairing approval.");
    expect(relay).toContain("QR pairing failed:");
    expect(relay).toContain("Check Full YOLO permission and scan a fresh Connect QR.");
    expect(relay).toContain("Device Tunnel HTTPS connection restored.");
    expect(relay).toContain("Math.min(10_000L, 500L << Math.min(5, failures))");
    expect(service).toContain("QR pairing failed:");
    expect(diagnostics).toContain('"outbound HTTPS tunnel"');
    expect(diagnostics).toContain("manager.getActiveNetwork()");
  });
});
