import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("Linux AppImage packaging regression", () => {
  it("disables linuxdeploy's obsolete strip binary on Ubuntu 24.04", () => {
    for (const file of [
      ".github/workflows/tray-build.yml",
      ".github/workflows/release-windows-standalone.yml",
    ]) {
      const workflow = read(file);
      expect(workflow).toContain("NO_STRIP: ${{ runner.os == 'Linux' && 'true' || '' }}");
      expect(workflow).toContain("APPIMAGE_EXTRACT_AND_RUN: ${{ runner.os == 'Linux' && '1' || '' }}");
      expect(workflow).toContain("installer:package:unix");
    }
  });
  it("preserves the full DEB + AppImage build, checks, and artifact upload", () => {
    const script = read("scripts/build-standalone-unix.ts");
    expect(script).toContain('"deb,appimage"');
    expect(read("scripts/verify-packaged-standalone-unix.sh")).toContain("REQUIRE_APPIMAGE:-1");
    expect(read(".github/workflows/tray-build.yml")).toContain("bundle/appimage/*.AppImage");
  });
});
