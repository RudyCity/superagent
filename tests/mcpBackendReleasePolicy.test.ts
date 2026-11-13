import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {describe,it,expect} from "vitest";
import {backendReleaseDirectory,verifyMcpBackendRelease} from "../src/core/runtime/mcpBackendReleasePolicy.js";
import {writeCoreBuildManifest} from "../src/core/runtime/coreBuildIdentity.js";

const digest=crypto.createHash("sha256").update("test").digest("hex");
const config=path.join(os.tmpdir(),"mcp-release-guard-"+process.pid);
describe("private release candidate isolation",()=>{
  it("rejects malformed digests and path traversal",()=>{
    for(const v of ["../old","A".repeat(64),"a".repeat(63),"/tmp/x"]){
      expect(()=>backendReleaseDirectory(v,config)).toThrow("MCP_BACKEND_RELEASE_INVALID_DIGEST");
    }
  });
  it("rejects missing and incomplete releases without touching live owner",()=>{
    expect(()=>verifyMcpBackendRelease(digest,config)).toThrow("MCP_BACKEND_RELEASE_UNVERIFIED");
  });
  it("never accepts staged source without verified compiled manifest and tree digest",()=>{
    const root=backendReleaseDirectory(digest,config);
    try{
      fs.mkdirSync(path.join(root,"dist"),{recursive:true});
      fs.writeFileSync(path.join(root,"package.json"),'{"name":"mcp-test","version":"1.0.0"}');
      fs.writeFileSync(path.join(root,"dist","cli.js"),"export default null;");
      expect(()=>verifyMcpBackendRelease(digest,config)).toThrow("MCP_BACKEND_RELEASE_UNVERIFIED");
      fs.writeFileSync(path.join(root,"dist","core-build-identity.json"),
        JSON.stringify({version:1,mode:"compiled",digest,sourceDigest:digest,builtAt:Date.now()}));
      expect(()=>verifyMcpBackendRelease(digest,config)).toThrow("MCP_BACKEND_RELEASE_UNVERIFIED");
    }finally{fs.rmSync(config,{recursive:true,force:true});}
  });
  it("accepts an intact manifest-addressed staged build, rejects tampering",()=>{
    const incoming=path.join(config,"incoming");
    try{
      fs.mkdirSync(path.join(incoming,"src"),{recursive:true});
      fs.mkdirSync(path.join(incoming,"dist"),{recursive:true});
      fs.writeFileSync(path.join(incoming,"package.json"),'{"name":"mcp-test","version":"1.0.0"}');
      fs.writeFileSync(path.join(incoming,"src","cli.ts"),"export default null;");
      fs.writeFileSync(path.join(incoming,"dist","cli.js"),"export default null;");
      const built=writeCoreBuildManifest(incoming);
      const destination=backendReleaseDirectory(built.digest,config);
      fs.mkdirSync(path.dirname(destination),{recursive:true});
      fs.renameSync(incoming,destination);
      expect(verifyMcpBackendRelease(built.digest,config)).toMatchObject({
        digest:built.digest,fileCount:2,entry:path.join(destination,"dist","cli.js"),
      });
      fs.appendFileSync(path.join(destination,"dist","cli.js"),"//tampered");
      expect(()=>verifyMcpBackendRelease(built.digest,config)).toThrow("MCP_BACKEND_RELEASE_UNVERIFIED");
    }finally{fs.rmSync(config,{recursive:true,force:true});}
  });
});
