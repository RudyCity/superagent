import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe,expect,it} from "vitest";
import {writeCoreBuildManifest,attestWindowsStandaloneCoreBuild} from "../src/core/runtime/coreBuildIdentity.js";
import {packageMcpBackendRelease} from "../scripts/package-mcp-backend-release.js";
import {stageVerifiedBackendArchive} from "../src/core/runtime/mcpBackendReleaseStager.js";

describe.skipIf(process.platform!=="win32")("CI backend asset producer and release stager compatibility",()=>{
  it("packages a pinned standalone bundle and roundtrips through the real safe extractor",async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"mcp-backend-producer-"));
    const stage=path.join(root,"standalone"),outputDir=path.join(root,"artifacts"),configDir=path.join(root,"config");
    const tag="v1.14.88-rc.17",sourceCommit="b".repeat(40);
    try{
      for(const d of ["dist","src","node_modules/ink","node_modules/r-memory","node_modules/sharp"])
        fs.mkdirSync(path.join(stage,d),{recursive:true});
      fs.writeFileSync(path.join(stage,"src/cli.ts"),"export default 42;");
      fs.writeFileSync(path.join(stage,"dist/cli.js"),"export default 42;");
      fs.writeFileSync(path.join(stage,"package.json"),JSON.stringify({version:"1.14.88",name:"superagent"}));
      fs.writeFileSync(path.join(stage,"bun.lock"),"fixture");
      fs.writeFileSync(path.join(stage,".superagent-generated-standalone"),"fixture");
      fs.writeFileSync(path.join(stage,"node_modules/ink/seed.bin"),crypto.randomBytes(3500));
      const build=writeCoreBuildManifest(stage);
      const opts={stage,outputDir,tag,sourceCommit,version:"1.14.88"};
      const artifact=await packageMcpBackendRelease(opts);
      expect(artifact.digest).toBe(build.digest);
      expect(artifact.size).toBeGreaterThan(1000);
      expect(fs.existsSync(path.join(stage,"mcp-backend-bundle.json"))).toBe(false);
      await expect(packageMcpBackendRelease(opts)).rejects.toThrow("MCP_BUNDLE_REFUSE_OVERWRITE");
      const staged=await stageVerifiedBackendArchive({
        archivePath:artifact.file,sha256:artifact.sha256,size:artifact.size,
        tag,sourceCommit,configDir,
      });
      expect(staged.digest).toBe(build.digest);
      expect(fs.existsSync(path.join(staged.directory,"node_modules/ink/seed.bin"))).toBe(true);
      const tampered=fs.readFileSync(artifact.file);
      fs.appendFileSync(artifact.file,"tampered");
      await expect(stageVerifiedBackendArchive({
        archivePath:artifact.file,sha256:artifact.sha256,size:tampered.length+8,
        tag,sourceCommit,configDir,
      })).rejects.toThrow("MCP_BACKEND_RELEASE_ARCHIVE_HASH_MISMATCH");
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  },40_000);
  it("packages an attested Windows UIA relocation without weakening MCP bundle freshness",async()=>{
    const base=fs.mkdtempSync(path.join(os.tmpdir(),"mcp-backend-relocated-"));
    const source=path.join(base,"source"),stage=path.join(base,"standalone");
    const outputDir=path.join(base,"artifacts"),configDir=path.join(base,"config");
    const tag="v1.14.88-rc.18",sourceCommit="c".repeat(40);
    try{
      fs.mkdirSync(path.join(source,"src"),{recursive:true});
      fs.mkdirSync(path.join(source,"dist","native","desktop-live-windows-input"),{recursive:true});
      fs.writeFileSync(path.join(source,"src","cli.ts"),"export default 42;");
      fs.writeFileSync(path.join(source,"dist","cli.js"),"export default 42;");
      fs.writeFileSync(path.join(source,"package.json"),JSON.stringify({version:"1.14.88",name:"superagent"}));
      const native=path.join(source,"dist","native","desktop-live-windows-input");
      fs.writeFileSync(path.join(native,"winremote.dll"),"test-dll");
      fs.writeFileSync(path.join(native,"winremote.sha256"),"test-sha");
      fs.writeFileSync(path.join(native,"winremote.provenance.json"),'{"runnerOS":"Windows"}\n');
      const sourceBuild=writeCoreBuildManifest(source);
      fs.mkdirSync(stage,{recursive:true});
      fs.cpSync(path.join(source,"dist"),path.join(stage,"dist"),{recursive:true});
      fs.copyFileSync(path.join(source,"package.json"),path.join(stage,"package.json"));
      fs.copyFileSync(path.join(source,"package.json"),path.join(stage,"bun.lock"));
      fs.writeFileSync(path.join(stage,".superagent-generated-standalone"),"fixture");
      for(const d of ["ink","r-memory","sharp"]){
        fs.mkdirSync(path.join(stage,"node_modules",d),{recursive:true});
      }
      fs.writeFileSync(path.join(stage,"node_modules","ink","seed.bin"),crypto.randomBytes(3500));
      fs.cpSync(native,path.join(stage,"native","desktop-live-windows-input"),{recursive:true});
      fs.rmSync(path.join(stage,"dist","native","desktop-live-windows-input"),{recursive:true});
      const build=attestWindowsStandaloneCoreBuild(source,stage);
      expect(build.digest).not.toBe(sourceBuild.digest);
      const artifact=await packageMcpBackendRelease({
        stage,outputDir,version:"1.14.88",tag,sourceCommit,
      });
      expect(artifact.digest).toBe(build.digest);
      const installed=await stageVerifiedBackendArchive({
        archivePath:artifact.file,sha256:artifact.sha256,size:artifact.size,
        tag,sourceCommit,configDir,
      });
      expect(installed.digest).toBe(build.digest);
      expect(fs.existsSync(path.join(installed.directory,"dist","native","desktop-live-windows-input"))).toBe(false);
      expect(fs.existsSync(path.join(stage,"native","desktop-live-windows-input","winremote.dll"))).toBe(true);
    }finally{fs.rmSync(base,{recursive:true,force:true});}
  },40_000);
});
