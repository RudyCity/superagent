import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const app = path.resolve("apps/superagent-lan-android/app");
const mainRoot = path.join(app, "src/main");
const pkg = path.join(mainRoot, "java/click/superagent/lanclient");
const load = (name: string) => fs.readFileSync(path.join(pkg, name + ".java"), "utf8");
const manifest = fs.readFileSync(path.join(mainRoot, "AndroidManifest.xml"), "utf8");
const activity = load("MainActivity");
const tv = load("AndroidTvUi");
const ui = load("AndroidUiKit");
const terminal = load("AndroidLocalTerminalUi");
const shell = load("LocalAndroidShell");
const server = load("LanClientServer");
const tunnel = load("TunnelRelayClient");
const gradle = fs.readFileSync(path.join(app, "build.gradle"), "utf8");

describe("Android TV and local terminal release contract", () => {
  it("advertises a real TV launcher with no touchscreen or camera requirement", () => {
    expect(manifest).toContain('android.intent.category.LEANBACK_LAUNCHER');
    expect(manifest).toContain('android.intent.category.LAUNCHER');
    expect(manifest).toContain('android:name="android.software.leanback" android:required="false"');
    expect(manifest).toContain('android:name="android.hardware.touchscreen" android:required="false"');
    expect(manifest).toContain('android:name="android.hardware.camera" android:required="false"');
    expect(manifest).toContain('android:name="android.hardware.screen.portrait" android:required="false"');
    expect(manifest).toContain('android:banner="@drawable/tv_banner"');
    const banner = fs.readFileSync(path.join(mainRoot, "res/drawable-xhdpi/tv_banner.png"));
    expect(banner.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect([banner.readUInt32BE(16), banner.readUInt32BE(20)]).toEqual([320, 180]);
    expect(gradle).toContain("minSdk 29");
    expect(gradle).toContain("versionCode 19");
  });

  it("uses a distinct D-pad-friendly TV rail while preserving touch navigation", () => {
    expect(tv).toContain("Configuration.UI_MODE_TYPE_TELEVISION");
    expect(tv).toContain("PackageManager.FEATURE_LEANBACK");
    expect(tv).toContain("workspace.setOrientation(LinearLayout.HORIZONTAL)");
    expect(tv).toContain("root.addView(pageHost, new LinearLayout.LayoutParams(-1, 0, 1f))");
    expect(ui).toContain("android.R.attr.state_focused");
    expect(ui).toContain("shape(SURFACE_HIGH, ACCENT, 14, ctx)");
    expect(activity).toContain('String[] labels = { "Home", "Connect", "Control", "Files", "Terminal" };');
    expect(activity).toContain("AndroidTvUi.addTab(this, navigation, tabButtons[i], tv)");
    expect(activity).toContain("if (tv) tabButtons[0].requestFocus()");
    expect(activity).toContain("if (AndroidTvUi.isTv(this) && selectedTab != 0) showTab(0)");
  });

  it("pairs TV without a camera but keeps all native approvals", () => {
    expect(activity).toContain('section(connectPage, "TV PAIRING · NO CAMERA")');
    expect(activity).toContain('segmentInput.setText("support-tv")');
    expect(activity).toContain('tunnelScan.setVisibility(View.GONE)');
    expect(activity).toContain('manualSetupPanel.setVisibility(View.VISIBLE)');
    expect(activity).toContain('connectPage.addView(tvPairingCard, 2)');
    expect(activity).toContain('connectPage.addView(sharingCard, 3)');
    expect(activity).toContain('this::startSharing');
    expect(server).toContain('approval.ask("pair"');
    expect(server).toContain('approval.ask("session"');
    expect(activity).toContain("RemoteControlPermit.canView()");
    expect(activity).toContain("RemoteControlPermit.canControl()");
    expect(tunnel).not.toContain("new ProcessBuilder");
  });

  it("runs only owner-entered commands in the Android app sandbox, never via RPC", () => {
    expect(terminal).toContain('AndroidUiKit.panel(page, "ON-DEVICE SHELL")');
    expect(terminal).toContain('input.getText().toString().trim()');
    expect(terminal).toContain('new InputFilter.LengthFilter(512)');
    expect(terminal).toContain('shell.execute(command)');
    expect(terminal).toContain("RemoteControlPermit.hasApprovedSession()");
    expect(terminal).toContain("ScreenProjectionService.isActive()");
    expect(terminal).toContain("executor.shutdownNow()");
    expect(shell).toContain('new ProcessBuilder("/system/bin/sh", "-c", command)');
    expect(shell).toContain("builder.directory(app.getFilesDir())");
    expect(shell).toContain("current.waitFor(10, TimeUnit.SECONDS)");
    expect(shell).toContain("private static final int MAX_OUTPUT = 24 * 1024");
    expect(shell).toContain("current.destroyForcibly()");
    expect(shell).toContain("stopRequested.get()");
    expect(activity).toContain("if (terminalUi != null) terminalUi.stopRunningCommand()");
    expect(shell).not.toContain("su -c");
    expect(server).not.toContain("LocalAndroidShell");
    expect(tunnel).not.toContain("LocalAndroidShell");
    expect(activity).toContain("if (terminalUi != null) terminalUi.close()");
  });
});
