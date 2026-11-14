import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(),file),"utf8");

describe("macOS and Linux Desktop Live native bundle and CI policy", () => {
  it("macOS capture filters exact SCWindow, never a display and never requests silent TCC", () => {
    const source = read("native/desktop-live-sck/macosCapture.swift");
    expect(source).toContain("SCContentFilter(desktopIndependentWindow: window)");
    expect(source).toContain("SCScreenshotManager.captureImage");
    expect(source).toContain("CGPreflightScreenCaptureAccess()");
    expect(source).toContain("CGWindowListCopyWindowInfo");
    expect(source).toContain("SCShareableContent.excludingDesktopWindows(");
    expect(source).not.toContain("SCContentFilter(display:");
    expect(source).not.toContain("CGRequestScreenCaptureAccess()");
    expect(source).not.toContain('FileManager.default.createFile');
    expect(source).toContain("timeIntervalSince(started) <= 300");
  });

  it("Linux exact-active-window worker refuses Wayland, monitors and unknown XIDs", () => {
    const source = read("native/desktop-live-x11/linuxCapture.py");
    expect(source).toMatch(/os\.environ\.get\(\s*"XDG_SESSION_TYPE"/);
    expect(source).toMatch(/\.lower\(\)\s*!=\s*"x11"/);
    expect(source).toContain('"/usr/bin/wmctrl"');
    expect(source).toContain('"/usr/bin/xprop"');
    expect(source).toContain('"/usr/bin/import"');
    expect(source).toContain("process_start(target");
    expect(source).toContain("len(candidates) != 1");
    expect(source).not.toContain("shell=True");
    expect(source).not.toContain('"-screen"');
  });

  it("Linux/macOS standalone staging enforces native helper checksum", () => {
    const prepare = read("scripts/prepare-standalone-unix.ts");
    const verify = read("scripts/verify-standalone-unix.ts");
    for (const value of [prepare,verify]) {
      expect(value).toContain("verifyMacSckArtifactPair");
      expect(value).toContain("verifyLinuxX11ArtifactPair");
      expect(value).toContain("desktop-live-sck");
      expect(value).toContain("desktop-live-x11");
    }
  });

  it("macOS ARM64 and Linux x64 CI build pinned helper before portable staging", () => {
    for (const file of [
      ".github/workflows/tray-build.yml",
      ".github/workflows/release-windows-standalone.yml",
    ]) {
      const workflow = read(file);
      const coreIndex = workflow.indexOf("run: bun run build");
      const macIndex = workflow.indexOf("bash scripts/build-desktop-live-sck.sh");
      const linuxIndex = workflow.indexOf("bash scripts/build-desktop-live-x11.sh");
      const stageIndex = workflow.indexOf("run: bun run installer:prepare:unix");
      expect(coreIndex).toBeGreaterThan(0);
      expect(macIndex).toBeGreaterThan(coreIndex);
      expect(linuxIndex).toBeGreaterThan(coreIndex);
      expect(macIndex).toBeLessThan(stageIndex);
      expect(linuxIndex).toBeLessThan(stageIndex);
      expect(workflow).toContain("tests/desktop-live/linuxPortalPolicy.test.ts");
      expect(workflow).toContain("tests/desktop-live/macSckArtifact.test.ts");
    }
  });
});