import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

describe("Unix standalone and browser extensions release contract", () => {
  it("keeps Chrome Delegate and SidePanel as independent MV3 extension packages", () => {
    const delegate = JSON.parse(read("chrome-extension-delegate/manifest.json"));
    const sidepanel = JSON.parse(read("chrome-extension/manifest.json"));
    expect(delegate.manifest_version).toBe(3);
    expect(sidepanel.manifest_version).toBe(3);
    expect(delegate.action.default_popup).toBe("popup.html");
    expect(sidepanel.side_panel.default_path).toBe("sidepanel.html");
    expect(read("scripts/release-delegate.mjs")).toContain("JSZip");
    const script = read("scripts/release-sidepanel.mjs");
    expect(script).toContain("JSZip");
    expect(script).toContain('"sidepanel.src.css"');
    expect(script).toContain("icons/icon128.png");
    expect(read("scripts/verify-release-extensions.mjs")).toContain("EXTENSION_RELEASE_VERIFIED");
  });
  it("limits DEB fallback to explicit Linux release channel", () => {
    const build = read("scripts/build-standalone-unix.ts");
    expect(build).toContain('process.platform === "darwin" ? "dmg" : "deb,appimage"');
    expect(build).toContain("SUPERAGENT_UNIX_BUNDLE_OVERRIDE");
    expect(build).toContain('override === "deb"');
    const verify = read("scripts/verify-packaged-standalone-unix.sh");
    expect(verify).toContain('hdiutil attach');
    expect(verify).toContain('hdiutil detach');
    expect(verify).toContain("REQUIRE_APPIMAGE:-1");
    expect(verify).toContain("Contents/Resources/standalone/dist/cli.js");
    expect(verify).toContain("PATH=/usr/bin:/bin");
  });
  it("publishes macOS DMG, Linux DEB and both Chrome extension ZIPs behind independent gates", () => {
    const workflow = read(".github/workflows/release-unix-extensions.yml");
    for (const expected of [
      "v*-unix.*", "macos-arm64", "linux-x64",
      "installer:prepare:unix", "installer:verify:unix", "installer:package:unix",
      "SUPERAGENT_UNIX_BUNDLE_OVERRIDE", "REQUIRE_APPIMAGE",
      "release-delegate.mjs", "release-sidepanel.mjs", "verify-release-extensions.mjs",
      "needs: [build-unix, build-extensions]", "SHA256SUMS.txt", "--verify-tag --prerelease",
    ]) expect(workflow).toContain(expected);
  });
});
