import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const java = (name: string) => fs.readFileSync(path.resolve(
  "apps/superagent-lan-android/app/src/main/java/click/superagent/lanclient", name + ".java"
), "utf8");

const main = java("MainActivity");
const ui = java("AndroidUiKit");
const gradle = fs.readFileSync("apps/superagent-lan-android/app/build.gradle", "utf8");
const colors = fs.readFileSync("apps/superagent-lan-android/app/src/main/res/values/colors.xml", "utf8");

describe("Android native dashboard redesign", () => {
  it("uses five functional native tabs, retaining scroll position and selection", () => {
    expect(main).toContain('String[] labels = { "Home", "Connect", "Control", "Files", "Terminal" };');
    expect(main).toContain("pages = new ScrollView[]");
    expect(main).toContain("AndroidUiKit.scroll(this, homePage)");
    expect(main).toContain("AndroidUiKit.scroll(this, connectPage)");
    expect(main).toContain("AndroidUiKit.scroll(this, controlPage)");
    expect(main).toContain("AndroidUiKit.scroll(this, filesPage)");
    expect(main).toContain("private void showTab(int index)");
    expect(main).toContain("state.putInt(\"selectedTab\", selectedTab)");
    expect(main).toContain("state.getInt(\"selectedTab\", 0)");
    expect(ui).toContain("setContentDescription(button.getText()");
    expect(ui).toMatch(/button\.setMinHeight\(dp\(ctx,\s*(AndroidTvUi\.isTv\(ctx\)\s*\?\s*6[04]\s*:\s*[45][82]|4[48])\)\)/);
  });

  it("shows current connectivity and consent status rather than invented pairing claims", () => {
    expect(main).toContain("dashboardStatus.setText(tunnelOn ?");
    expect(main).toContain("RemoteControlPermit.hasApprovedSession()");
    expect(main).toMatch(/dashboardStop\s*=\s*action(In)?\([^,]+,\s*"(Stop all sharing|Stop All)",\s*this::stopSharing\)/);
    expect(main).toContain("dashboardStop.setEnabled(on || ScreenProjectionService.isActive())");
    expect(main).toContain("events = label(");
    expect(main).toContain("events.setTextIsSelectable(true)");
  });

  it("prioritizes QR, preserves manual fallback and every original pairing control", () => {
    expect(main).toContain("connectPage.addView(connectQrCard, 2)");
    expect(main).toContain("connectPage.addView(sharingCard, 3)");
    expect(main).toMatch(/tunnelScan\s*=\s*action(In)?\([^,]+,\s*"Scan (Connection )?QR( & Connect)?",\s*this::scanTunnelQr\)/);
    expect(main).toMatch(/tunnelDisconnect\s*=\s*action(In)?\([^,]+,\s*"Disconnect( tunnel)?",\s*this::disconnectTunnel\)/);
    expect(main).toContain("manualSetupPanel.setVisibility(View.GONE)");
    expect(main).toMatch(/manualSetupToggle\s*=\s*action(In)?\([^,]+,\s*"Manual [sS]etup( · Advanced)?",\s*this::toggleManualSetup\)/);
    expect(main).toMatch(/tunnelConnect\s*=\s*action(In)?\([^,]+,\s*"Connect( with manual setup)?",\s*this::connectTunnel\)/);
    for (const pattern of [/renew\s*=\s*action(In)?\(/, /revoke\s*=\s*action(In)?\(/, /copy\s*=\s*action(In)?\(/, /fingerprint\.setTextIsSelectable\(true\)/]) {
      expect(main).toMatch(pattern);
    }
  });

  it("keeps screen control and local file sharing opt-in, without hidden permissions", () => {
    expect(main).toContain("permissionNext = action(layout, \"Continue permission setup\", this::continuePermissionSetup)");
    expect(main).toMatch(/startScreen\s*=\s*action(In)?\([^,]+,\s*"Share screen",\s*this::beginScreenConsent\)/);
    expect(main).toContain("touchToggle = action(layout, \"Allow remote taps and swipes\", this::toggleRemoteInput)");
    expect(main).toMatch(/stopScreen\s*=\s*action(In)?\([^,]+,\s*"Stop screen( & revoke)?",\s*this::stopSharing\)/);
    expect(main).toContain("new Intent(Intent.ACTION_OPEN_DOCUMENT)");
    expect(main).toContain("new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)");
    expect(main).toContain("LanFileExchange.MAX_BYTES");
    expect(main).not.toContain("WRITE_SECURE_SETTINGS");
  });

  it("uses a centralized dark design system with native 48dp touch targets", () => {
    expect(ui).toContain("static final int CANVAS");
    expect(ui).toContain("static final int ACCENT");
    expect(ui).toContain("static final int SURFACE");
    expect(ui).toContain("static LinearLayout panel(");
    expect(ui).toContain("RippleDrawable");
    expect(ui).toMatch(/button\.setMinHeight\(dp\(ctx,\s*(AndroidTvUi\.isTv\(ctx\)\s*\?\s*6[04]\s*:\s*[45][82]|48)\)\)/);
    expect(ui).toContain("static void activeTab(");
    expect(ui).toMatch(/setSingleLine\((true|false)\)/);
    expect(colors).toMatch(/#(0B1422|090D16)/i);
    expect(gradle).toContain("versionCode 23");
    expect(gradle).toContain("versionName '0.10.6-device-qr'");
  });
});
