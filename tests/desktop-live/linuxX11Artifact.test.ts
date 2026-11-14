import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveLinuxX11ArtifactDirectory, verifyLinuxX11ArtifactPair,
  locateVerifiedLinuxX11Helper,
} from "../../src/core/desktopUi/adapters/linuxX11Artifact.js";

describe("Linux exact-active-window X11 helper integrity", () => {
  it("pins source, built and installed layout without accepting a caller path override", () => {
    const root = path.resolve("safe-linux-x11-layout");
    const relative = path.join("core", "desktopUi", "adapters", "linuxX11Artifact.js");
    expect(resolveLinuxX11ArtifactDirectory(path.join(root, "src", relative)))
      .toBe(path.join(root, "dist", "native", "desktop-live-x11"));
    expect(resolveLinuxX11ArtifactDirectory(path.join(root, "dist", relative)))
      .toBe(path.join(root, "dist", "native", "desktop-live-x11"));
    expect(resolveLinuxX11ArtifactDirectory(path.join(root, "standalone", "dist", relative)))
      .toBe(path.join(root, "standalone", "dist", "native", "desktop-live-x11"));
    expect(() => resolveLinuxX11ArtifactDirectory(path.join(root, "other", "module.js")))
      .toThrow(/module layout/);
  });

  it("rejects missing, malformed, symlinked or tampered window-only helper", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-linux-x11-"));
    const source = path.join(dir, "linuxCapture.py");
    const receipt = path.join(dir, "linuxCapture.sha256");
    const script = Buffer.from("#!/usr/bin/env python3\n" +
      "# A bounded fixture with static input only.\n".repeat(120), "utf8");
    try {
      expect(verifyLinuxX11ArtifactPair(source, receipt)).toBeNull();
      await fs.writeFile(source, script);
      expect(() => verifyLinuxX11ArtifactPair(source, receipt)).toThrow(/Incomplete/);
      const sha = crypto.createHash("sha256").update(script).digest("hex");
      await fs.writeFile(receipt, sha + "\n");
      expect(verifyLinuxX11ArtifactPair(source, receipt)).toBe(source);
      if (process.platform !== "win32") {
        const link = path.join(dir, "linked.py");
        await fs.symlink(source, link);
        expect(() => verifyLinuxX11ArtifactPair(link, receipt)).toThrow(/regular file/);
      }
      script[100] = 33;
      await fs.writeFile(source, script);
      expect(() => verifyLinuxX11ArtifactPair(source, receipt)).toThrow(/checksum mismatch/);
      const other = Buffer.from(script);
      other[0] = 42;
      await fs.writeFile(source, other);
      await fs.writeFile(receipt, crypto.createHash("sha256").update(other).digest("hex") + "\n");
      expect(() => verifyLinuxX11ArtifactPair(source, receipt)).toThrow(/header invalid/);
      if (process.platform !== "linux") expect(locateVerifiedLinuxX11Helper()).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not provide monitor capture or shell execution fallback", async () => {
    const script = await fs.readFile(
      path.join("native", "desktop-live-x11", "linuxCapture.py"), "utf8");
    expect(script).toContain('"/usr/bin/import", "-quiet", "-window", hex(xid), "png:-"');
    expect(script).toContain('["/usr/bin/wmctrl", "-lpG"]');
    expect(script).toContain('["/usr/bin/xprop", "-root", "_NET_ACTIVE_WINDOW"]');
    expect(script).toContain('process_start(target["pid"])');
    expect(script).toContain("deadline = started + SESSION_SECONDS");
    expect(script).toContain("verify_atspi_window(target)");
    expect(script).not.toContain("shell=True");
    expect(script).not.toContain('"root"');
    expect(script).not.toContain('"-screen"');
  });
});
