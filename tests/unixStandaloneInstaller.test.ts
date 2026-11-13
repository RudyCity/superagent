import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

describe("macOS ARM64 and Linux x64 portable installer contracts", () => {
  it("places compiled Core and Bun in a per-platform standalone Tauri bundle", () => {
    const conf = JSON.parse(read("apps/superagent-tray/src-tauri/tauri.standalone.unix.conf.json"));
    expect(conf.bundle.externalBin).toEqual(["binaries/bun"]);
    expect(conf.bundle.resources["resources/standalone/"]).toBe("standalone/");
    const prep = read("scripts/prepare-standalone-unix.ts");
    expect(prep).toContain("aarch64-apple-darwin");
    expect(prep).toContain("x86_64-unknown-linux-gnu");
    expect(prep).toContain("--production");
    expect(prep).toContain("--frozen-lockfile");
    expect(prep).toContain("standalone-manifest.json");
  });

  it("resolves installed native CLI resource paths instead of requiring global Node", () => {
    const launcher = read("apps/superagent-tray/src-tauri/src/cli_launcher.rs");
    expect(launcher).toContain('.join("Resources").join("standalone")');
    expect(launcher).toContain('.join("lib").join(installed_name).join("standalone")');
    expect(launcher).toContain('exe_dir.join(if cfg!(windows) { "bun.exe" } else { "bun" })');
    const verify = read("scripts/verify-standalone-unix.ts");
    expect(verify).toContain('PATH: "/usr/bin:/bin"');
    expect(verify).toContain('["--version"]');
  });

  it("produces DMG for macOS, DEB + AppImage for Linux and validates both", () => {
    const builder = read("scripts/build-standalone-unix.ts");
    expect(builder).toContain('process.platform === "darwin" ? "dmg" : "deb,appimage"');
    const verify = read("scripts/verify-packaged-standalone-unix.sh");
    expect(verify).toContain("dpkg-deb --extract");
    expect(verify).toContain("Contents/MacOS/superagent");
    expect(verify).toContain("Contents/Resources/standalone/dist/cli.js");
    expect(verify).toContain('PATH=/usr/bin:/bin');
  });

  it("publishes only when all Windows/macOS/Linux jobs and artifacts pass", () => {
    const workflow = read(".github/workflows/release-windows-standalone.yml");
    for (const item of ["windows-x64", "macos-arm64", "linux-x64",
      "needs: [build, build-extensions, build-android, build-lan-windows]",
      "scripts/verify-unified-release-assets.mjs", "release-assets/*",
      "contents: write", "--prerelease", "SHA256SUMS.txt"]) {
      expect(workflow).toContain(item);
    }
    const inventory = read("scripts/verify-unified-release-assets.mjs");
    for (const suffix of [".dmg", ".AppImage", ".deb", "_x64-setup.exe"]) {
      expect(inventory).toContain(suffix);
    }
    expect(inventory).toContain("JSON.stringify(actual)===JSON.stringify(expected)");
    expect(workflow).toContain("scripts/verify-packaged-standalone-unix.sh");
    const ci = read(".github/workflows/tray-build.yml");
    expect(ci).toContain("bun run installer:prepare:unix");
    expect(ci).toContain("bun run installer:verify:unix");
    expect(ci).toContain("bun run installer:package:unix");
  });
});
