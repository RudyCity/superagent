import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyWindowsWgcArtifactPair } from "../../src/core/desktopUi/adapters/windowsWgcArtifact.js";

describe("bundled native Windows Graphics Capture artifact integrity",()=>{
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