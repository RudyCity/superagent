import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Native packaging smoke without installing NSIS or starting a Core/Tray.
 * The same compiled module and built, checksum-pinned helper used in Windows
 * installer staging are copied into a disposable standalone/dist tree.
 */
describe.skipIf(process.platform !== "win32")("Windows WGC installed-layout smoke", () => {
  it("locates packaged WGC with the bundled Core module and fails on tampering", async () => {
    const projectRoot = process.cwd();
    const directory = await mkdtemp(path.join(os.tmpdir(), "superagent-wgc-install-layout-"));
    const dist = path.join(directory, "standalone", "dist");
    const adapterDir = path.join(dist, "core", "desktopUi", "adapters");
    const nativeDir = path.join(dist, "native", "desktop-live-wgc");
    await mkdir(adapterDir, { recursive: true });
    await mkdir(nativeDir, { recursive: true });
    const src = (name: string) => path.join(projectRoot, "dist", name);
    const executable = path.join(nativeDir, "wgc.exe");
    const checksum = path.join(nativeDir, "wgc.sha256");
    const bundledBun = path.join(directory, "bun.exe");
    const psVerifier = path.join(projectRoot, "scripts", "verify-installed-wgc.ps1");
    try {
      await copyFile(process.execPath, bundledBun);
      await copyFile(src(path.join("core", "desktopUi", "adapters", "windowsWgcArtifact.js")),
        path.join(adapterDir, "windowsWgcArtifact.js"));
      await copyFile(src(path.join("core", "desktopUi", "errors.js")),
        path.join(dist, "core", "desktopUi", "errors.js"));
      await copyFile(src(path.join("native", "desktop-live-wgc", "wgc.exe")), executable);
      await copyFile(src(path.join("native", "desktop-live-wgc", "wgc.sha256")), checksum);

      const installedVerification = [
        'const path = require("node:path");',
        'const m = await import("./standalone/dist/core/desktopUi/adapters/windowsWgcArtifact.js");',
        'const expected = path.resolve("standalone/dist/native/desktop-live-wgc/wgc.exe");',
        'const actual = m.locateVerifiedWindowsWgcHelper();',
        'if (actual !== expected) throw Error("Installed WGC path or receipt mismatch");',
        'console.log("INSTALLED_WGC_INTEGRITY_PASS");',
      ].join(" ");

      function check() {
        return spawnSync(process.execPath, ["-e", installedVerification], {
          cwd: directory, windowsHide: true, encoding: "utf8", timeout: 15_000,
          env: { ...process.env, SUPERAGENT_DESKTOP_LIVE_WGC: "1" },
        });
      }
      function verifyInstalledPowerShell() {
        return spawnSync(
          path.win32.join(process.env.SystemRoot || "C:\\Windows",
            "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
           "-File", psVerifier, "-InstallRoot", directory],
          { cwd: projectRoot, windowsHide: true, encoding: "utf8", timeout: 20_000 },
        );
      }
      const accepted = check();
      expect(accepted.error).toBeUndefined();
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stdout).toContain("INSTALLED_WGC_INTEGRITY_PASS");
      const verifiedPowerShell = verifyInstalledPowerShell();
      expect(verifiedPowerShell.error).toBeUndefined();
      expect(verifiedPowerShell.status, verifiedPowerShell.stderr).toBe(0);
      expect(verifiedPowerShell.stdout).toContain("INSTALLED_WGC_INTEGRITY_PASS");

      const bytes = await readFile(executable);
      bytes[bytes.length - 1] ^= 0x01;
      await writeFile(executable, bytes);
      const tampered = check();
      expect(tampered.status).not.toBe(0);
      expect(tampered.stderr).toMatch(/checksum mismatch/);
      const tamperedPowerShell = verifyInstalledPowerShell();
      expect(tamperedPowerShell.status).not.toBe(0);
      expect(tamperedPowerShell.stderr).toMatch(/checksum mismatch|verification failed/);
      await copyFile(src(path.join("native", "desktop-live-wgc", "wgc.exe")), executable);

      await writeFile(checksum, "0".repeat(64) + "\n", "ascii");
      const incorrectManifest = check();
      expect(incorrectManifest.status).not.toBe(0);
      expect(incorrectManifest.stderr).toMatch(/checksum mismatch/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 35_000);
});
