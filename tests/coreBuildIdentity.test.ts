import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectCoreBuild, writeCoreBuildManifest, attestWindowsStandaloneCoreBuild } from "../src/core/runtime/coreBuildIdentity.js";

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
  it("requires final manifest after verified Windows native provenance is staged, and rejects tampering",()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"core-build-windows-stage-"));
    try {
      fs.mkdirSync(path.join(root,"src"));
      fs.mkdirSync(path.join(root,"dist"));
      fs.writeFileSync(path.join(root,"package.json"),'{"name":"core-native-stage"}');
      fs.writeFileSync(path.join(root,"tsconfig.json"),'{"compilerOptions":{}}');
      fs.writeFileSync(path.join(root,"src","cli.tsx"),"export const ready = true;");
      const compiled=path.join(root,"dist","cli.js");
      fs.writeFileSync(compiled,"export const ready = true;");
      const initial=writeCoreBuildManifest(root);
      expect(inspectCoreBuild(compiled,{requireFreshCompiled:true}).digest).toBe(initial.digest);
      // The trusted CI compiler stages its verified provenance after bun run build.
      const native=path.join(root,"dist","native","desktop-live-windows-input");
      fs.mkdirSync(native,{recursive:true});
      const provenance=path.join(native,"winremote.provenance.json");
      fs.writeFileSync(provenance,'{"schemaVersion":1,"runnerOS":"Windows"}\n');
      expect(inspectCoreBuild(compiled).fresh).toBe(false);
      expect(()=>inspectCoreBuild(compiled,{requireFreshCompiled:true})).toThrow("CORE_BUILD_STALE");
      const finalized=writeCoreBuildManifest(root);
      expect(finalized.digest).not.toBe(initial.digest);
      expect(inspectCoreBuild(compiled,{requireFreshCompiled:true}).digest).toBe(finalized.digest);
      fs.appendFileSync(provenance,"\n");
      expect(inspectCoreBuild(compiled).fresh).toBe(false);
      expect(()=>inspectCoreBuild(compiled,{requireFreshCompiled:true})).toThrow("CORE_BUILD_STALE");
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });
  it("finalizes Core identity after Windows helper verification in both CI workflows",()=>{
    const root=process.cwd();
    for(const workflow of [".github/workflows/tray-build.yml",".github/workflows/release-windows-standalone.yml"]){
      const content=fs.readFileSync(path.join(root,workflow),"utf8");
      const build=content.indexOf("- name: Build Core");
      const native=content.indexOf("./scripts/build-desktop-live-windows-semantic.ps1");
      const nativeTests=content.indexOf("tests/desktop-live/windowsRemoteNativePackaging.test.ts --maxWorkers=1");
      const finalize=content.indexOf("- name: Finalize compiled Core identity after verified Windows native staging");
      const refresh=content.indexOf("bun scripts/write-core-build-manifest.ts",finalize);
      const verify=content.indexOf("requireFreshCompiled:true",refresh);
      const regression=content.indexOf("- name: Core &",verify);
      expect(build).toBeGreaterThanOrEqual(0);
      expect(native).toBeGreaterThan(build);
      expect(nativeTests).toBeGreaterThan(native);
      expect(finalize).toBeGreaterThan(nativeTests);
      expect(refresh).toBeGreaterThan(finalize);
      expect(verify).toBeGreaterThan(refresh);
      expect(regression).toBeGreaterThan(verify);
      expect(content.slice(finalize,refresh)).toContain("if: runner.os == 'Windows'");
    }
  });
  it("re-attests only the exact verified Windows native relocation and rejects drift",()=>{
    const base=fs.mkdtempSync(path.join(os.tmpdir(),"core-build-relocation-"));
    const original=path.join(base,"original"),stage=path.join(base,"standalone");
    try{
      fs.mkdirSync(path.join(original,"src"),{recursive:true});
      fs.mkdirSync(path.join(original,"dist"),{recursive:true});
      fs.writeFileSync(path.join(original,"src","cli.ts"),"export default 1;");
      fs.writeFileSync(path.join(original,"dist","cli.js"),"export default 1;");
      fs.writeFileSync(path.join(original,"package.json"),'{"name":"superagent","version":"1.0.0"}');
      fs.writeFileSync(path.join(original,"tsconfig.json"),'{"compilerOptions":{}}');
      const native=path.join(original,"dist","native","desktop-live-windows-input");
      fs.mkdirSync(native,{recursive:true});
      fs.writeFileSync(path.join(native,"winremote.dll"),"fixture-dll");
      fs.writeFileSync(path.join(native,"winremote.sha256"),"fixture-sha");
      fs.writeFileSync(path.join(native,"winremote.provenance.json"),'{"runnerOS":"Windows"}\n');
      const originalIdentity=writeCoreBuildManifest(original);
      const sourceFresh=inspectCoreBuild(path.join(original,"dist","cli.js"),{requireFreshCompiled:true});
      expect(sourceFresh.digest).toBe(originalIdentity.digest);
      const stageCopied=()=>{
        fs.mkdirSync(stage,{recursive:true});
        fs.cpSync(path.join(original,"dist"),path.join(stage,"dist"),{recursive:true,force:true});
        fs.copyFileSync(path.join(original,"package.json"),path.join(stage,"package.json"));
        fs.cpSync(native,path.join(stage,"native","desktop-live-windows-input"),{recursive:true,force:true});
        fs.rmSync(path.join(stage,"dist","native","desktop-live-windows-input"),{recursive:true,force:true});
      };
      stageCopied();
      expect(inspectCoreBuild(path.join(stage,"dist","cli.js")).fresh).toBe(false);
      const stagedIdentity=attestWindowsStandaloneCoreBuild(original,stage);
      expect(stagedIdentity.digest).not.toBe(originalIdentity.digest);
      expect(stagedIdentity.sourceDigest).toBe(originalIdentity.sourceDigest);
      expect(inspectCoreBuild(path.join(stage,"dist","cli.js"),{requireFreshCompiled:true}).digest)
        .toBe(stagedIdentity.digest);
      fs.appendFileSync(path.join(stage,"dist","cli.js"),"// tampered");
      expect(inspectCoreBuild(path.join(stage,"dist","cli.js")).fresh).toBe(false);
      expect(()=>attestWindowsStandaloneCoreBuild(original,stage))
        .toThrow("CORE_STANDALONE_COMPILED_BYTES_MISMATCH");
      stageCopied();
      fs.appendFileSync(path.join(stage,"native","desktop-live-windows-input","winremote.provenance.json")," ");
      expect(()=>attestWindowsStandaloneCoreBuild(original,stage))
        .toThrow("CORE_STANDALONE_NATIVE_RELOCATION_MISMATCH");
      stageCopied();
      fs.writeFileSync(path.join(stage,"package.json"),'{"name":"superagent","version":"1.0.1"}');
      expect(()=>attestWindowsStandaloneCoreBuild(original,stage))
        .toThrow("CORE_STANDALONE_COMPILED_BYTES_MISMATCH");
      stageCopied();
      fs.appendFileSync(path.join(original,"src","cli.ts"),"// tampered source");
      expect(()=>attestWindowsStandaloneCoreBuild(original,stage))
        .toThrow("CORE_BUILD_STALE");
    }finally{fs.rmSync(base,{recursive:true,force:true});}
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
