import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyUnixDesktopLiveTree } from "../../scripts/verify-desktop-live-unix-artifacts.js";

type Platform = "darwin" | "linux";
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");

function fixture(platform: Platform) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "unix-live-artifact-audit-"));
  const standalone = path.join(repo, "apps", "superagent-tray", "src-tauri", "resources", "standalone");
  const dirName = platform === "linux" ? "desktop-live-x11" : "desktop-live-sck";
  const fileName = platform === "linux" ? "linuxCapture.py" : "sck";
  const receiptName = platform === "linux" ? "linuxCapture.sha256" : "sck.sha256";
  const buildDir = path.join(repo, "dist", "native", dirName);
  const stageDir = path.join(standalone, "dist", "native", dirName);
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(stageDir, { recursive: true });
  // Windows checkouts can rewrite Python LF to CRLF. The Linux artifact
  // fixture must represent a real Unix checkout, not weakened runtime checks.
  const contents = platform === "linux"
    ? Buffer.from(fs.readFileSync(path.join(process.cwd(), "native", "desktop-live-x11", "linuxCapture.py"), "utf8").replace(/\r\n/g, "\n"), "utf8")
    : Buffer.alloc(128 * 1024);
  if (platform === "darwin") {
    contents.writeUInt32LE(0xfeedfacf, 0);
    contents.writeUInt32LE(0x0100000c, 4);
    contents.writeUInt32LE(2, 12);
    contents.writeUInt32LE(1, 16); // one bounded synthetic Mach-O load command
    contents.writeUInt32LE(72, 20);
  } else {
    const sourceDir = path.join(repo, "native", dirName);
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, fileName), contents);
  }
  for (const dir of [buildDir, stageDir]) {
    fs.writeFileSync(path.join(dir, fileName), contents);
    fs.writeFileSync(path.join(dir, receiptName), sha(contents) + "\n");
  }
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ version: "1.2.3" }));
  fs.writeFileSync(path.join(standalone, "dist", "cli.js"), "// fixture; never executed\n");
  fs.writeFileSync(path.join(standalone, "standalone-manifest.json"), JSON.stringify({
    version: "1.2.3", platform, arch: platform === "linux" ? "x64" : "arm64",
    target: platform === "linux" ? "x86_64-unknown-linux-gnu" : "aarch64-apple-darwin",
    bunVersion: "1.4.2", entrypoint: "standalone/dist/cli.js",
  }));
  return {
    repo, standalone, buildDir, stageDir, fileName, receiptName, contents,
    close: () => fs.rmSync(repo, { recursive: true, force: true }),
  };
}

describe("Unix Desktop Live extracted artifact audit (structural fixtures only)", () => {
  for (const platform of ["linux", "darwin"] as const) {
    it(`accepts a verified, version-matched ${platform} helper + receipt`, () => {
      const f = fixture(platform);
      try {
        expect(verifyUnixDesktopLiveTree(f.repo, f.standalone, platform)).toBe(sha(f.contents));
      } finally { f.close(); }
    });

    it(`rejects omitted, corrupted, or receipt-repinned ${platform} package helpers`, () => {
      const f = fixture(platform);
      try {
        const file = path.join(f.stageDir, f.fileName);
        const receipt = path.join(f.stageDir, f.receiptName);
        fs.unlinkSync(file);
        expect(() => verifyUnixDesktopLiveTree(f.repo, f.standalone, platform)).toThrow();
        fs.writeFileSync(file, f.contents);
        fs.unlinkSync(receipt);
        expect(() => verifyUnixDesktopLiveTree(f.repo, f.standalone, platform)).toThrow();
        fs.writeFileSync(receipt, sha(f.contents) + "\n");
        const changed = Buffer.from(f.contents);
        changed[100] ^= 1;
        fs.writeFileSync(file, changed);
        expect(() => verifyUnixDesktopLiveTree(f.repo, f.standalone, platform)).toThrow(/checksum mismatch/);
        fs.writeFileSync(receipt, sha(changed) + "\n");
        expect(() => verifyUnixDesktopLiveTree(f.repo, f.standalone, platform))
          .toThrow(/differs from this CI run/);
      } finally { f.close(); }
    });

    it(`rejects symlinked ${platform} helper directories and wrong manifest target`, () => {
      const f = fixture(platform);
      try {
        const manifest = path.join(f.standalone, "standalone-manifest.json");
        const value = JSON.parse(fs.readFileSync(manifest, "utf8"));
        fs.writeFileSync(manifest, JSON.stringify({ ...value, arch: "bogus" }));
        expect(() => verifyUnixDesktopLiveTree(f.repo, f.standalone, platform))
          .toThrow(/manifest mismatch/);
        fs.writeFileSync(manifest, JSON.stringify(value));
        const name = path.join(f.stageDir, f.fileName);
        fs.unlinkSync(name);
        try {
          fs.symlinkSync(path.join(f.buildDir, f.fileName), name);
          expect(() => verifyUnixDesktopLiveTree(f.repo, f.standalone, platform)).toThrow();
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
        }
      } finally { f.close(); }
    });
  }

  it("rejects a Linux helper built from an outdated checkout source", () => {
    const f = fixture("linux");
    try {
      const source = path.join(f.repo, "native", "desktop-live-x11", "linuxCapture.py");
      fs.appendFileSync(source, "# changed after helper build\n");
      expect(() => verifyUnixDesktopLiveTree(f.repo, f.standalone, "linux"))
        .toThrow(/does not match checkout source/);
    } finally { f.close(); }
  });

  it("Unix Tauri resources map standalone Core, and release verifier checks both Linux formats", () => {
    const config = JSON.parse(fs.readFileSync(path.join(
      process.cwd(), "apps/superagent-tray/src-tauri/tauri.standalone.unix.conf.json"), "utf8"));
    expect(config.bundle.resources["resources/standalone/"]).toBe("standalone/");
    const script = fs.readFileSync(path.join(
      process.cwd(), "scripts/verify-desktop-live-unix-packages.sh"), "utf8");
    expect(script).toContain("dpkg-deb --extract");
    expect(script).toContain("--appimage-extract");
    expect(script).toContain("hdiutil attach");
    expect(script).toContain("audit_tree");
    expect(script).not.toContain("REQUIRE_APPIMAGE");
  });

  it("CI workflows run native SDK guard and enforce extraction audit before upload", () => {
    for (const name of [
      ".github/workflows/tray-build.yml",
      ".github/workflows/release-windows-standalone.yml",
    ]) {
      const workflow = fs.readFileSync(path.join(process.cwd(), name), "utf8");
      const host = workflow.indexOf("bash scripts/verify-desktop-live-unix-host.sh");
      const mac = workflow.indexOf("bash scripts/build-desktop-live-sck.sh");
      const linux = workflow.indexOf("bash scripts/build-desktop-live-x11.sh");
      const test = workflow.indexOf("tests/desktop-live/unixArtifactAudit.test.ts");
      const stage = workflow.indexOf("run: bun run installer:prepare:unix");
      const packageEnd = workflow.indexOf("run: bun run installer:package:unix");
      const extraction = workflow.indexOf("bash scripts/verify-desktop-live-unix-packages.sh");
      const upload = workflow.indexOf("name: Upload macOS");
      expect(host).toBeGreaterThan(0);
      expect(host).toBeLessThan(mac);
      expect(host).toBeLessThan(linux);
      expect(test).toBeGreaterThan(0);
      expect(test).toBeLessThan(stage);
      expect(stage).toBeLessThan(packageEnd);
      expect(extraction).toBeGreaterThan(packageEnd);
      expect(extraction).toBeLessThan(upload);
    }
  });
});
