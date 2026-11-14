import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveMacSckArtifactDirectory, verifyMacSckArtifactPair,
  locateVerifiedMacSckHelper,
} from "../../src/core/desktopUi/adapters/macSckArtifact.js";

describe("macOS ScreenCaptureKit fixed native artifact contract", () => {
  it("maps source and installed Core modules to the exact adjacent native payload", () => {
    const root = path.resolve("temporary-sck-module-root");
    for (const base of ["src", "dist"]) {
      const module = path.join(root, base, "core", "desktopUi", "adapters", "macSckArtifact.js");
      expect(resolveMacSckArtifactDirectory(module))
        .toBe(path.join(root, "dist", "native", "desktop-live-sck"));
    }
    expect(resolveMacSckArtifactDirectory(
      path.join(root,"standalone","dist","core","desktopUi","adapters","macSckArtifact.js"),
    )).toBe(path.join(root,"standalone","dist","native","desktop-live-sck"));
    expect(() => resolveMacSckArtifactDirectory(path.join(root,"other","file.js")))
      .toThrow(/module path/);
  });

  it("validates bounded arm64 Mach-O and receipt, and rejects corrupted or missing counterparts", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(),"superagent-sck-artifact-"));
    const binary = path.join(directory,"sck");
    const receipt = path.join(directory,"sck.sha256");
    try {
      expect(verifyMacSckArtifactPair(binary,receipt)).toBeNull();
      const bytes = Buffer.alloc(128 * 1024);
      bytes.writeUInt32LE(0xfeedfacf,0);
      bytes.writeUInt32LE(0x0100000c,4);
      bytes.writeUInt32LE(2,12);
      await fs.writeFile(binary,bytes);
      expect(() => verifyMacSckArtifactPair(binary,receipt)).toThrow(/Incomplete/);
      const sha = crypto.createHash("sha256").update(bytes).digest("hex");
      await fs.writeFile(receipt,sha+"\n");
      expect(verifyMacSckArtifactPair(binary,receipt)).toBe(binary);
      bytes[8192] = 1;
      await fs.writeFile(binary,bytes);
      expect(() => verifyMacSckArtifactPair(binary,receipt)).toThrow(/checksum mismatch/);
      bytes.writeUInt32LE(0x01000007,4);
      await fs.writeFile(binary,bytes);
      await fs.writeFile(receipt,crypto.createHash("sha256").update(bytes).digest("hex")+"\n");
      expect(() => verifyMacSckArtifactPair(binary,receipt)).toThrow(/ARM64/);
      await fs.writeFile(receipt,"bad");
      expect(() => verifyMacSckArtifactPair(binary,receipt)).toThrow(/oversized|Incomplete/);
      if (process.platform !== "darwin") expect(locateVerifiedMacSckHelper()).toBeNull();
    } finally {
      await fs.rm(directory,{recursive:true,force:true});
    }
  });
});