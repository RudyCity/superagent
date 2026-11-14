import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveWindowsWgcArtifactDirectory, verifyWindowsWgcArtifactPair,
} from "../../src/core/desktopUi/adapters/windowsWgcArtifact.js";

describe("bundled native Windows Graphics Capture artifact integrity",()=>{
  it("resolves only the source, built, and installed Core layouts", () => {
    const root = path.resolve("synthetic-wgc-root");
    const source = path.join(root, "src", "core", "desktopUi", "adapters", "windowsWgcArtifact.ts");
    const compiled = path.join(root, "dist", "core", "desktopUi", "adapters", "windowsWgcArtifact.js");
    const installed = path.join(root, "standalone", "dist", "core", "desktopUi", "adapters", "windowsWgcArtifact.js");
    expect(resolveWindowsWgcArtifactDirectory(source))
      .toBe(path.join(root, "dist", "native", "desktop-live-wgc"));
    expect(resolveWindowsWgcArtifactDirectory(compiled))
      .toBe(path.join(root, "dist", "native", "desktop-live-wgc"));
    expect(resolveWindowsWgcArtifactDirectory(installed))
      .toBe(path.join(root, "standalone", "dist", "native", "desktop-live-wgc"));
    expect(() => resolveWindowsWgcArtifactDirectory(path.join(root,"random","module.js")))
      .toThrow(/module layout/);
  });
  it("loads the checksum-pinned helper from an isolated standalone/dist layout", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-wgc-standalone-"));
    try {
      const stage = path.join(dir, "standalone", "dist");
      const packagedDir = path.join(stage, "native", "desktop-live-wgc");
      await fs.mkdir(packagedDir, { recursive: true });
      const executable = path.join(packagedDir, "wgc.exe");
      const receipt = path.join(packagedDir, "wgc.sha256");
      const fake = Buffer.alloc(131072);
      fake.write("MZ", 0, "ascii");
      fake.writeUInt32LE(0x80, 0x3c);
      fake.write("PE\0\0", 0x80, "ascii");
      fake.writeUInt16LE(0x8664, 0x84);
      fake.writeUInt16LE(0x20b, 0x98);
      await fs.writeFile(executable, fake);
      await fs.writeFile(receipt, crypto.createHash("sha256").update(fake).digest("hex") + "\n");
      const compiledPath = path.join(stage, "core", "desktopUi", "adapters", "windowsWgcArtifact.js");
      expect(resolveWindowsWgcArtifactDirectory(compiledPath)).toBe(packagedDir);
      expect(verifyWindowsWgcArtifactPair(executable, receipt)).toBe(executable);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed and mismatched binaries without executing them",async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),"superagent-wgc-integrity-"));
    const exe=path.join(dir,"wgc.exe");
    const sha=path.join(dir,"wgc.sha256");
    try {
      expect(verifyWindowsWgcArtifactPair(exe,sha)).toBeNull();
      const fake=Buffer.alloc(131072);
      fake.write("MZ",0,"ascii");
      fake.writeUInt32LE(0x80,0x3c);
      fake.write("PE\0\0",0x80,"ascii");
      fake.writeUInt16LE(0x8664,0x84); // x64 machine
      fake.writeUInt16LE(0x20b,0x98); // PE32+ header
      await fs.writeFile(exe,fake);
      expect(()=>verifyWindowsWgcArtifactPair(exe,sha)).toThrow(/incomplete/);
      await fs.writeFile(sha,crypto.createHash("sha256").update(fake).digest("hex")+"\n");
      expect(verifyWindowsWgcArtifactPair(exe,sha)).toBe(exe);
      fake[1000]=42;
      await fs.writeFile(exe,fake);
      expect(()=>verifyWindowsWgcArtifactPair(exe,sha)).toThrow(/checksum mismatch/);
      await fs.writeFile(sha,crypto.createHash("sha256").update(fake).digest("hex")+"\n");
      fake.write("NO",0,"ascii");
      await fs.writeFile(exe,fake);
      await fs.writeFile(sha,crypto.createHash("sha256").update(fake).digest("hex")+"\n");
      expect(()=>verifyWindowsWgcArtifactPair(exe,sha)).toThrow(/Windows x64 executable/);
      await fs.writeFile(sha,"not a checksum");
      expect(()=>verifyWindowsWgcArtifactPair(exe,sha)).toThrow(/size bounds|checksum/);
    } finally {
      await fs.rm(dir,{recursive:true,force:true});
    }
  });
});