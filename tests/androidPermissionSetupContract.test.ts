import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const main = fs.readFileSync(path.resolve(
  "apps/superagent-lan-android/app/src/main/java/click/superagent/lanclient/MainActivity.java",
), "utf8");

describe("Android guided permission setup", () => {
  it("shows four permission states and a user-invoked next action", () => {
    expect(main).toContain('section(layout, "REMOTE CONTROL SETUP · OWNER APPROVAL")');
    expect(main).toContain('permissionNext = action(layout, "Continue permission setup", this::continuePermissionSetup)');
    expect(main).toContain('action(layout, "Refresh permission status", this::refresh)');
    for (const title of ["Notifications:", "Accessibility:", "Screen sharing:", "Remote touch:"]) {
      expect(main).toContain(title);
    }
    expect(main).toContain("private void continuePermissionSetup()");
    expect(main).toContain("RemoteControlPermit.hasApprovedSession()");
    expect(main).toContain("beginScreenConsent()");
    expect(main).toContain("toggleRemoteInput()");
  });

  it("asks Android for notifications but opens settings when notifications are blocked", () => {
    expect(main).toContain("NOTIFICATION_SETUP_REQUEST = 9005");
    expect(main).toContain("requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_SETUP_REQUEST)");
    expect(main).toContain("Settings.ACTION_APP_NOTIFICATION_SETTINGS");
    expect(main).toContain("Settings.EXTRA_APP_PACKAGE");
    expect(main).toContain("Settings.ACTION_APPLICATION_DETAILS_SETTINGS");
    expect(main).toContain("manager.areNotificationsEnabled()");
    expect(main).toContain("code == NOTIFICATION_SETUP_REQUEST");
    expect(main).toContain("code == NOTIFICATION_REQUEST");
  });

  it("requires manual Accessibility approval and visible screen capture consent", () => {
    expect(main).toContain("Settings.ACTION_ACCESSIBILITY_SETTINGS");
    expect(main).toContain("SuperAgent cannot turn it on for you.");
    expect(main).toContain("stopSharing();");
    expect(main).toContain("createScreenCaptureIntent(");
    expect(main).toContain("RemoteControlPermit.inputConsent(true)");
    expect(main).not.toContain("WRITE_SECURE_SETTINGS");
  });
});
