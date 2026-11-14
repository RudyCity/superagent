import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  fs.readFileSync(path.join(process.cwd(), relative), "utf8");

describe("macOS ScreenCaptureKit native source security policy (static, host-independent)", () => {
  it("requires native Screen Recording TCC and matches exactly one CGWindowID/PID", () => {
    const swift = read("native/desktop-live-sck/macosCapture.swift");
    expect(swift).toContain("CGPreflightScreenCaptureAccess()");
    expect(swift).toContain("CGWindowListCopyWindowInfo");
    expect(swift).toContain("matches.count == 1");
    expect(swift).toContain("owner.int32Value == approved.pid");
    expect(swift).toContain("sharing.intValue != 0");
    expect(swift).toContain('text == "cg:');
    expect(swift).toContain("approved.bounds.x.isFinite");
    expect(swift).toContain('rawBounds["Width"]');
    expect(swift).toContain("window.owningApplication?.processID == approved.pid");
    expect(swift).toContain("windows.count == 1");
    expect(swift).not.toContain("CGRequestScreenCaptureAccess()");
  });

  it("captures only the exact window, rechecks consent/expiry and never falls back", () => {
    const swift = read("native/desktop-live-sck/macosCapture.swift");
    expect(swift).toContain("SCContentFilter(desktopIndependentWindow: window)");
    expect(swift).toContain("SCScreenshotManager.captureImage");
    expect(swift).toContain("true, onScreenWindowsOnly: true");
    expect(swift).toContain("verifyCoreGraphics()");
    expect(swift.match(/Date\(\)\.timeIntervalSince\(started\) <= 300/g)).toHaveLength(2);
    expect(swift).toContain("@MainActor");
    expect(swift).not.toContain("SCContentFilter(display:");
    expect(swift).not.toContain("SCContentFilter(excludingApplications:");
    expect(swift).not.toContain("CGWindowListCreateImage");
    expect(swift).not.toContain("FileManager.default.createFile");
  });

  it("builds a single pinned arm64 helper with no download or display capture", () => {
    const script = read("scripts/build-desktop-live-sck.sh");
    expect(script).toContain('$(uname -s)');
    expect(script).toContain('$(uname -m)');
    expect(script).toContain("-parse-as-library -target arm64-apple-macos14.0");
    expect(script).toContain('-framework UniformTypeIdentifiers');
    expect(script).toContain('test "$(lipo -archs "$SCRATCH/sck")" = "arm64"');
    expect(script).toContain("shasum -a 256");
    expect(script).toContain("sck.sha256");
    expect(script).not.toContain("curl ");
    expect(script).not.toContain("wget ");
  });
});
