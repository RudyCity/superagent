import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

describe("Windows standalone installer and safe release contracts", () => {
  it("uses Windows-specific Tauri resource mapping without changing other platforms", () => {
    const standalone = JSON.parse(read("apps/superagent-tray/src-tauri/tauri.standalone.conf.json"));
    const base = JSON.parse(read("apps/superagent-tray/src-tauri/tauri.conf.json"));
    expect(standalone.bundle.resources["resources/standalone/"]).toBe("standalone/");
    expect(standalone.bundle.externalBin).toEqual(["binaries/bun"]);
    expect(standalone.bundle.windows.nsis.compression).toBe("zlib");
    expect(base.bundle.active).toBe(true);
    expect(base.bundle.externalBin).toBeUndefined();
  });
  it("aligns Core and Tray version and supplies a native CLI alongside the Tray", () => {
    const version = JSON.parse(read("package.json")).version;
    expect(JSON.parse(read("apps/superagent-tray/src-tauri/tauri.conf.json")).version).toBe(version);
    expect(read("apps/superagent-tray/src-tauri/Cargo.toml")).toContain('name = "superagent"');
    expect(read("apps/superagent-tray/src-tauri/Cargo.toml")).toContain(`version = "${version}"`);
    const cli = read("apps/superagent-tray/src-tauri/src/cli_launcher.rs");
    expect(cli).toContain('exe_dir.join("standalone").join("dist").join("cli.js")');
    expect(cli).toContain('exe_dir.join(if cfg!(windows) { "bun.exe" }');
  });
  it("includes typescript as a production dependency for standalone syntax verification", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.dependencies.typescript).toBeDefined();
    expect(pkg.devDependencies?.typescript).toBeUndefined();
  });
  it("does not discard a user PATH entry during uninstall or duplicate it on install", () => {
    const hooks = read("apps/superagent-tray/src-tauri/nsis_hooks.nsh");
    expect(hooks).toContain("NSIS_HOOK_PREINSTALL");
    expect(hooks).toContain("NSIS_HOOK_POSTINSTALL");
    expect(hooks).toContain("NSIS_HOOK_PREUNINSTALL");
    expect(hooks).toContain("NSIS_HOOK_POSTUNINSTALL");
    expect(hooks).toContain("taskkill.exe");
    expect(hooks).toContain("AddedPath");
  });
  it("uses prerelease-only tag gates and requires all three platform assets before GitHub prerelease publishing", () => {
    const workflow = read(".github/workflows/release-windows-standalone.yml");
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("v*-rc.*");
    expect(workflow).toContain("--verify-tag --prerelease");
    expect(workflow).toContain("SHA256SUMS.txt");
    expect(workflow).toContain("bun run installer:verify");
    expect(workflow).toContain("bun run installer:package");
    expect(workflow).toContain("macos-arm64");
    expect(workflow).toContain("linux-x64");
    expect(workflow).toContain("needs: [build, build-extensions, build-android, build-lan-windows]");
    expect(workflow).toContain("bun run installer:package:unix");
    expect(read(".github/workflows/tray-build.yml")).toContain("superagent-standalone-windows-x64");
  });
  it("requires installed WGC integrity to be rechecked on the disposable Windows runner", () => {
    const installed = read("scripts/verify-installed-standalone-windows.ps1");
    const psVerifier = read("scripts/verify-installed-wgc.ps1");
    const jsVerifier = read("scripts/verify-installed-wgc.mjs");
    expect(installed).toContain('verify-installed-wgc.ps1');
    expect(psVerifier).toContain('verify-installed-wgc.mjs');
    expect(psVerifier).not.toContain('-e $verify');
    expect(jsVerifier).toContain('windowsWgcArtifact.js');
    expect(jsVerifier).toContain('locateVerifiedWindowsWgcHelper');
    expect(jsVerifier).toContain('INSTALLED_WGC_INTEGRITY_PASS');
    for (const file of [
      ".github/workflows/release-windows-standalone.yml",
      ".github/workflows/release-windows-only.yml",
      ".github/workflows/tray-build.yml",
    ]) {
      const workflow = read(file);
      expect(workflow).toContain('tests/desktop-live/windowsInstalledBundleSmoke.test.ts');
      expect(workflow).toContain('verify-installed-standalone-windows.ps1');
    }
  });
  it("verifies installed WGC through the packaged Core, not the checkout or inline JS eval", () => {
    const installed = read("scripts/verify-installed-standalone-windows.ps1");
    const script = read("scripts/verify-installed-wgc.ps1");
    const verifier = read("scripts/verify-installed-wgc.mjs");
    expect(installed).toContain('verify-installed-wgc.ps1');
    expect(script).toContain('verify-installed-wgc.mjs');
    expect(script).not.toContain('-e $verify');
    expect(verifier).toContain('windowsWgcArtifact.js');
    expect(verifier).toContain('locateVerifiedWindowsWgcHelper');
    expect(verifier).toContain('INSTALLED_WGC_INTEGRITY_PASS');
    for (const workflow of [
      ".github/workflows/release-windows-only.yml",
      ".github/workflows/release-windows-standalone.yml",
      ".github/workflows/tray-build.yml",
    ]) {
      const content = read(workflow);
      expect(content).toContain('tests/desktop-live/windowsInstalledBundleSmoke.test.ts');
      expect(content).toContain('verify-installed-standalone-windows.ps1');
    }
  });

  it("builds and verifies the exact-window WGC helper before every Windows installer", () => {
    const prepare = read("scripts/prepare-standalone-windows.ts");
    const verify = read("scripts/verify-standalone-windows.ts");
    expect(prepare).toContain("verifyWindowsWgcArtifactPair");
    expect(prepare).toContain('path.join(stage, "dist", wgcRelative)');
    expect(verify).toContain("verifyWindowsWgcArtifactPair");
    expect(verify).toContain('path.join(stage, "dist", "native", "desktop-live-wgc")');
    for (const workflowName of [
      ".github/workflows/release-windows-standalone.yml",
      ".github/workflows/release-windows-only.yml",
      ".github/workflows/tray-build.yml",
    ]) {
      const workflow = read(workflowName);
      expect(workflow).toContain("./scripts/build-desktop-live-wgc.ps1");
      expect(workflow.indexOf("Build and verify opt-in Windows Graphics Capture helper"))
        .toBeLessThan(workflow.indexOf("installer:prepare"));
      expect(workflow).toContain("tests/desktop-live/windowsWgcArtifact.test.ts");
    }
    const builder = read("scripts/build-desktop-live-wgc.ps1");
    expect(builder).toContain("vswhere.exe");
    expect(builder).toContain("Get-FileHash");
    expect(builder).toContain('"dist\\native\\desktop-live-wgc"');
  });
  it("never commits runtime executables or bundled third-party dependencies", () => {
    const ignore = read(".gitignore");
    expect(ignore).toContain("/apps/superagent-tray/src-tauri/binaries/");
    expect(ignore).toContain("/apps/superagent-tray/src-tauri/resources/standalone/");
  });
  it("anchors both standalone packagers to the Tray directory, not sibling LAN GUI", () => {
    for (const filename of ["scripts/build-standalone-windows.ts", "scripts/build-standalone-unix.ts"]) {
      const script = read(filename);
      expect(script).toContain('path.join(root, "apps", "superagent-tray")');
      expect(script).toContain("cwd: trayRoot");
      expect(script).toContain("src-tauri/tauri.conf.json");
      expect(script).not.toContain("cwd: root");
    }
    const release = read(".github/workflows/release-windows-only.yml");
    expect(release).toContain("v*-windows.*");
    expect(release).toContain("needs: [build-windows]");
    expect(release).toContain("verify-installed-standalone-windows.ps1");
    expect(release).toContain("--verify-tag --prerelease");
    expect(release).toContain("SHA256SUMS.txt");
  });
});
