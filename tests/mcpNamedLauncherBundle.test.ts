import {afterAll,beforeAll,describe,expect,it} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  BUNDLES,verifyMcpNamedLauncherArtifacts,
} from "../scripts/build-mcp-named-launchers.js";

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
let fixture="";
function copyFixture():string{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"named-release-bundle-test-"));
  const target=path.join(root,"dist","scripts");
  fs.mkdirSync(target,{recursive:true});
  fs.copyFileSync(path.join(repo,"package.json"),path.join(root,"package.json"));
  for(const name of [...BUNDLES,"mcp-named-launchers.json"]){
    fs.copyFileSync(path.join(repo,"dist","scripts",name),path.join(target,name));
  }
  fs.mkdirSync(path.join(root,"dist"),{recursive:true});
  fs.writeFileSync(path.join(root,"dist","cli.js"),"/* private test CLI fixture */ ".repeat(100));
  return root;
}
describe("Release Named MCP launcher bundle (SHA-256 and version gates)",()=>{
  beforeAll(()=>{fixture=copyFixture();});
  afterAll(()=>{if(fixture)fs.rmSync(fixture,{recursive:true,force:true});});
  it("requires two independently SHA-256-pinned Bun entrypoints",()=>{
    expect(verifyMcpNamedLauncherArtifacts(fixture)).toMatchObject({
      schemaVersion:1,package:"superagent",target:"bun",
      scripts:{
        "mcp-tunnel-anchor.js":expect.stringMatching(/^[a-f0-9]{64}$/),
        "mcp-named-owner.js":expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });
  it("rejects one tampered launcher without running it",()=>{
    const root=copyFixture();
    try{
      fs.appendFileSync(path.join(root,"dist/scripts/mcp-named-owner.js"),"//tampered\n");
      expect(()=>verifyMcpNamedLauncherArtifacts(root)).toThrow(
        "MCP_NAMED_LAUNCHER_SHA256_MISMATCH");
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  });
  it("rejects a substituted version even if hashes still match",()=>{
    const root=copyFixture();
    try{
      const pkg=path.join(root,"package.json");
      const value=JSON.parse(fs.readFileSync(pkg,"utf8"));
      value.version="0.0.1";
      fs.writeFileSync(pkg,JSON.stringify(value));
      expect(()=>verifyMcpNamedLauncherArtifacts(root)).toThrow(
        "MCP_NAMED_LAUNCHER_MANIFEST_VERSION_OR_SCHEMA_MISMATCH");
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  });
  it("rejects an unauthorized script entry in the manifest",()=>{
    const root=copyFixture();
    try{
      const file=path.join(root,"dist/scripts/mcp-named-launchers.json");
      const manifest=JSON.parse(fs.readFileSync(file,"utf8"));
      manifest.scripts["unexpected.js"]="0".repeat(64);
      fs.writeFileSync(file,JSON.stringify(manifest));
      expect(()=>verifyMcpNamedLauncherArtifacts(root)).toThrow(
        "MCP_NAMED_LAUNCHER_MANIFEST_VERSION_OR_SCHEMA_MISMATCH");
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  });
  it("rejects a missing bundled file",()=>{
    const root=copyFixture();
    try{
      fs.rmSync(path.join(root,"dist/scripts/mcp-tunnel-anchor.js"));
      expect(()=>verifyMcpNamedLauncherArtifacts(root)).toThrow();
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  });
});
