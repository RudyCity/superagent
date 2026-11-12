import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = (file: string) => readFileSync(file, "utf8");

describe("Unix AppImage and extension publication", () => {
  it("requires AppImage and DEB together before publication", () => {
    const ci = source(".github/workflows/release-unix-extensions.yml");
    expect(ci).toContain("file musl");
    expect(ci).toContain("echo 'NO_STRIP=true' >> \"$GITHUB_ENV\"");
    expect(ci).toContain("echo 'APPIMAGE_EXTRACT_AND_RUN=1' >> \"$GITHUB_ENV\"");
    expect(ci).toContain("Build macOS DMG or Linux DEB and AppImage");
    expect(ci).not.toContain("SUPERAGENT_UNIX_BUNDLE_OVERRIDE:");
    expect(ci).toContain('REQUIRE_APPIMAGE: "1"');
    expect(ci).toContain("bundle/appimage/*.AppImage");
    const smoke = source("scripts/verify-packaged-standalone-unix.sh");
    expect(smoke).toContain("--appimage-extract");
    expect(smoke).toContain("AppImage CLI version mismatch");
    expect(smoke).toContain("Linux standalone AppImage CLI PASS");
    expect(ci).toContain('for pattern in "*.dmg" "*.deb" "*.AppImage"');
    expect(ci).toContain('[[ "$(find downloaded-assets -type f | wc -l)" -eq 7 ]]');
    expect(ci).toContain("appimages=(release-assets/*.AppImage)");
  });

  it("does not publish previous Delegate versions from the shared build output", () => {
    const ci = source(".github/workflows/release-unix-extensions.yml");
    expect(ci).toContain("scripts/stage-release-extensions.mjs");
    expect(ci).toContain("build/release-extension-upload/*");
    expect(ci).not.toContain("build/releases/superagent-delegate-*.zip");
    const stage = source("scripts/stage-release-extensions.mjs");
    expect(stage).toContain('"chrome-extension-delegate"');
    expect(stage).toContain('"chrome-extension"');
    expect(stage).toContain("manifest.version");
    expect(stage).toContain("COPYFILE_EXCL");
    expect(stage).toContain("readdirSync(destination).length");
    expect(source(".gitignore")).toContain("/build/release-extension-upload/");
  });
});
