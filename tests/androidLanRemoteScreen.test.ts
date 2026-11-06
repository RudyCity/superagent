import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { parseTrayLanAction } from "../src/core/runtime/trayLanBridge.js";

const id = "a0b1c2d3-1234-4abc-9f00-aabbccddeeff";
const android = (name: string) => fs.readFileSync(
  "apps/superagent-lan-android/app/src/main/java/click/superagent/lanclient/" + name + ".java", "utf8");
const manifest = fs.readFileSync("apps/superagent-lan-android/app/src/main/AndroidManifest.xml", "utf8");
const rust = fs.readFileSync("apps/superagent-tray/src-tauri/src/main.rs", "utf8");
const viewer = fs.readFileSync("apps/superagent-tray/ui/lan-screen-viewer.js", "utf8");
const ui = fs.readFileSync("apps/superagent-tray/ui/index.html", "utf8");
const controller = fs.readFileSync("src/core/lanRemote/controller.ts", "utf8");

describe("Android interactive LAN control: strict, consent-gated protocol", () => {
  it("permits only a bounded screen request with a UUID device handle", () => {
    expect(parseTrayLanAction({ action: "screen", deviceId: id }).action).toBe("screen");
    for (const body of [
      { action: "screen", deviceId: id, url: "https://example.com" },
      { action: "screen", deviceId: "invalid" },
      { action: "screen", deviceId: id, token: "secret" },
      { action: "record", deviceId: id },
    ]) expect(() => parseTrayLanAction(body)).toThrow();
  });

  it("enforces precise touch and swipe bounds, no injected fields", () => {
    const valid = [
      { action: "input", deviceId: id, kind: "tap", x: 0, y: 1 },
      { action: "input", deviceId: id, kind: "swipe", x: .1, y: .9, endX: .1, endY: .1, durationMs: 320 },
      { action: "input", deviceId: id, kind: "back" },
      { action: "input", deviceId: id, kind: "home" },
      { action: "input", deviceId: id, kind: "recents" },
      { action: "input", deviceId: id, kind: "text", text: "Example authorized input" },
    ];
    for (const item of valid) expect(parseTrayLanAction(item).action).toBe("input");
    const denied = [
      { kind: "tap", x: -0.01, y: .5 },
      { kind: "tap", x: 1.01, y: .5 },
      { kind: "tap", x: "0.5", y: .5 },
      { kind: "swipe", x: 0, y: 0, endX: 1, endY: 1, durationMs: 20000 },
      { kind: "swipe", x: 0, y: 0, endX: 1, endY: 1, durationMs: 120.2 },
      { kind: "back", text: "cmd" },
      { kind: "text", text: "A".repeat(161) },
      { kind: "text", text: String.fromCharCode(10) },
      { kind: "text", text: "hello", command: "shell" },
      { kind: "clipboard", text: "password" },
    ];
    for (const input of denied) {
      expect(() => parseTrayLanAction({ action: "input", deviceId: id, ...input }))
        .toThrow();
    }
  });

  it("requires Android MediaProjection system consent + a visible foreground service", () => {
    expect(manifest).toContain("android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION");
    expect(manifest).toContain('android:foregroundServiceType="mediaProjection"');
    expect(manifest).toContain("android.permission.POST_NOTIFICATIONS");
    expect(manifest).toContain('android:stopWithTask="true"');
    expect(android("MainActivity")).toContain("createScreenCaptureIntent()");
    expect(android("MainActivity")).toContain('Manifest.permission.POST_NOTIFICATIONS');
    expect(android("ScreenProjectionService")).toContain("startForeground(NOTIFICATION_ID");
    expect(android("ScreenProjectionService")).toContain("getMediaProjection(code, data)");
    expect(android("ScreenProjectionService")).toContain("projection.registerCallback(");
    expect(android("ScreenProjectionService")).toContain("onCapturedContentResize(int width, int height)");
    expect(android("ScreenProjectionService")).toContain("STOP SHARING");
    expect(android("ScreenProjectionService")).toContain("MAX_FRAME_BYTES = 210_000");
    expect(android("ScreenProjectionService")).toContain("lastEncodeAt < 500");
    expect(android("ScreenProjectionService")).not.toContain("FileOutputStream");
    expect(android("ScreenProjectionService")).not.toContain("MediaRecorder");
  });

  it("requires manually enabled Accessibility and a second independent input consent", () => {
    const accessibility = android("ControlledAccessibilityService");
    const main = android("MainActivity");
    const policy = android("RemoteControlPermit");
    expect(manifest).toContain('android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE"');
    expect(manifest).toContain('android:exported="true"');
    expect(main).toContain("Settings.ACTION_ACCESSIBILITY_SETTINGS");
    expect(main).toContain("ALLOW REMOTE TOUCH");
    expect(main).toContain("RemoteControlPermit.inputConsent(true)");
    expect(main).toContain("ScreenProjectionService.stop(this)");
    expect(policy).toContain("return canView() && userEnabledInput");
    expect(accessibility).toContain("RemoteControlPermit.canControl()");
    expect(accessibility).toContain("dispatchGesture(");
    expect(accessibility).toContain("focused.isPassword()");
    expect(accessibility).toContain("void onAccessibilityEvent(AccessibilityEvent event)");
    expect(accessibility).toContain("Never inspect, log or persist event payloads");
    expect(accessibility).not.toContain("getText()");
    expect(accessibility).not.toContain("ClipboardManager");
  });

  it("stops screen/remote input on revoke, session end, or target screen stop", () => {
    const server = android("LanClientServer");
    expect(server).toContain('if ("screen".equals(op))');
    expect(server).toContain('if ("input".equals(op))');
    expect(server).toContain("RemoteControlPermit.revoke()");
    expect(server).toContain("RemoteControlPermit.session(false)");
    expect(server).toContain("RemoteControlPermit.session(true)");
    expect(server).toContain("ScreenProjectionService.stop(context)");
    expect(server).toContain("ControlledAccessibilityService.type(text)");
    expect(server).toContain("normalized(JSONObject request, String key)");
  });

  it("bounds JPEG data and sends no persistent screenshot URLs to the WebView", () => {
    expect(controller).toContain('op: "screen"');
    expect(controller).toContain('op: "input"');
    expect(controller).toContain("600 * 1024");
    expect(controller).toContain("frame.data.length > 290_000");
    expect(viewer).toContain('"data:image/jpeg;base64," + frame.data');
    expect(viewer).not.toContain("fetch(");
    expect(viewer).not.toMatch(/localStorage\.(?:setItem|getItem)\s*\(/);
    expect(viewer).not.toContain("MediaRecorder");
    expect(viewer).not.toContain("WebSocket");
    expect(rust).toContain('"screen", "input"');
    expect(rust).toContain('"input" => &["deviceId", "kind"');
    for (const id of ["lan-screen-image", "lan-screen-start", "lan-screen-stop",
      "lan-screen-back", "lan-screen-home", "lan-screen-recents",
      "lan-screen-text", "lan-screen-send-text", "lan-screen-disconnect"])
      expect(ui).toContain('id="' + id + '"');
  });
});
