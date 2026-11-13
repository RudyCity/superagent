import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectCoreBuild, writeCoreBuildManifest } from "../src/core/runtime/coreBuildIdentity.js";

describe("Core source/dist build attestation", () => {
  it("detects stale compiled output, changed sources and code changes during deployment",()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"core-build-identity-"));
    try {
      fs.mkdirSync(path.join(root,"src"));fs.mkdirSync(path.join(root,"dist"));
      fs.writeFileSync(path.join(root,"package.json"),'{"name":"core-fingerprint"}');
      fs.writeFileSync(path.join(root,"tsconfig.json"),'{"compilerOptions":{}}');
      const source=path.join(root,"src","cli.tsx"),compiled=path.join(root,"dist","cli.js");
      fs.writeFileSync(source,"const version = 1;");
      fs.writeFileSync(compiled,"var version=1;");
      const first=inspectCoreBuild(source);
      expect(first.mode).toBe("source");
      expect(first.fresh).toBe(true);
      expect(inspectCoreBuild(compiled).fresh).toBe(false);
      const manifest=writeCoreBuildManifest(root);
      expect(inspectCoreBuild(compiled,{requireFreshCompiled:true}).digest).toBe(manifest.digest);
      fs.writeFileSync(source,"const version = 2;");
      expect(inspectCoreBuild(compiled).fresh).toBe(false);
      expect(()=>inspectCoreBuild(compiled,{requireFreshCompiled:true})).toThrow("CORE_BUILD_STALE");
      fs.writeFileSync(compiled,"var version=2;");
      writeCoreBuildManifest(root);
      expect(inspectCoreBuild(compiled,{requireFreshCompiled:true}).fresh).toBe(true);
      const before=inspectCoreBuild(compiled);
      fs.writeFileSync(compiled,"var version=3;");
      expect(inspectCoreBuild(compiled).digest).not.toBe(before.digest);
      expect(inspectCoreBuild(compiled).fresh).toBe(false);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });
  it("never fingerprints an arbitrary entry outside a recognized SuperAgent project",()=>{
    expect(()=>inspectCoreBuild(path.join(os.tmpdir(),"invalid-entry","cli.js"))).toThrow("ENTRY_OUTSIDE_PROJECT");
  });
  it("attests fresh compiled standalone build when src directory is omitted",()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"core-build-standalone-"));
    try {
      fs.mkdirSync(path.join(root,"src"));fs.mkdirSync(path.join(root,"dist"));
      fs.writeFileSync(path.join(root,"package.json"),'{"name":"core-standalone"}');
      fs.writeFileSync(path.join(root,"tsconfig.json"),'{"compilerOptions":{}}');
      const source=path.join(root,"src","cli.tsx"),compiled=path.join(root,"dist","cli.js");
      fs.writeFileSync(source,"const version = 1;");
      fs.writeFileSync(compiled,"var version=1;");
      const manifest=writeCoreBuildManifest(root);
      // Simulate standalone packaging where src/ is deleted
      fs.rmSync(path.join(root,"src"),{recursive:true,force:true});
      const standalone=inspectCoreBuild(compiled,{requireFreshCompiled:true});
      expect(standalone.mode).toBe("compiled");
      expect(standalone.fresh).toBe(true);
      expect(standalone.digest).toBe(manifest.digest);
      expect(standalone.sourceDigest).toBe(manifest.sourceDigest);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });
});
