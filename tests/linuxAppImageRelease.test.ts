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
      expect(workflow).toContain("if: runner.os == 'Linux'");
      expect(workflow).toContain("echo 'NO_STRIP=true' >> \"$GITHUB_ENV\"");
      expect(workflow).toContain("echo 'APPIMAGE_EXTRACT_AND_RUN=1' >> \"$GITHUB_ENV\"");
      expect(workflow).not.toContain("NO_STRIP: ${{ runner.os");
      expect(workflow).not.toContain("APPIMAGE_EXTRACT_AND_RUN: ${{ runner.os");
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
