import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as tar from "tar";
import {describe,it,expect} from "vitest";
import {writeCoreBuildManifest} from "../src/core/runtime/coreBuildIdentity.js";
import {backendReleaseDirectory} from "../src/core/runtime/mcpBackendReleasePolicy.js";
import {backendBundleName,exactChecksum,officialAssetUrl,isSafeMcpBundleArchivePath,
  selectOfficialBackendRelease,stageVerifiedBackendArchive} from "../src/core/runtime/mcpBackendReleaseStager.js";

const tag="v1.14.88-rc.2",commit="e".repeat(40);
describe("Official MCP backend GitHub release selection",()=>{
  const assetName=backendBundleName("1.14.88");
  const assets=[
    {name:assetName,size:30000,browser_download_url:"https://github.com/RudyCity/superagent/releases/download/"+tag+"/"+assetName},
    {name:"SHA256SUMS.txt",size:80,browser_download_url:"https://github.com/RudyCity/superagent/releases/download/"+tag+"/SHA256SUMS.txt"},
  ];
  it("selects exact published candidate, never installer or draft",()=>{
    const r={tag_name:tag,draft:false,prerelease:true,assets};
    expect(selectOfficialBackendRelease([r],tag).asset.name).toBe(assetName);
    expect(()=>selectOfficialBackendRelease([{...r,draft:true}])).toThrow();
    expect(()=>selectOfficialBackendRelease([{...r,prerelease:false}])).toThrow();
    expect(()=>selectOfficialBackendRelease([{...r,assets:[...assets,assets[0]]}])).toThrow();
  });
  it("rejects mismatched external URLs, duplicate or missing checksums",()=>{
    const chosen=selectOfficialBackendRelease([{tag_name:tag,draft:false,prerelease:true,assets}],tag);
    expect(officialAssetUrl(tag,chosen.asset)).toContain("github.com/RudyCity/superagent");
    for(const address of [
      "https://evil.test/RudyCity/superagent/releases/download/"+tag+"/"+assetName,
      "http://github.com/RudyCity/superagent/releases/download/"+tag+"/"+assetName,
      "https://github.com/RudyCity/superagent/releases/download/"+tag+"/"+assetName+"?x=1",
    ])expect(()=>officialAssetUrl(tag,{...chosen.asset,browser_download_url:address})).toThrow();
    const hash="a".repeat(64);
    expect(exactChecksum(hash+"  ./"+assetName,assetName)).toBe(hash);
    expect(()=>exactChecksum(hash+"  "+assetName+"\n"+hash+"  ./"+assetName,assetName)).toThrow();
    expect(()=>exactChecksum(hash+"  something-else.tgz",assetName)).toThrow();
  });
  it("rejects archive traversal, links and unrelated roots",()=>{
    for(const name of ["../outside","/absolute","C:/evil","dist/../outside","dist\\evil",
      "unknown/foo","dist//foo","node_modules/.bad/../evil"])
      expect(isSafeMcpBundleArchivePath(name)).toBe(false);
    expect(isSafeMcpBundleArchivePath("node_modules/@scope/pkg/index.js")).toBe(true);
  });
});

describe.skipIf(process.platform!=="win32")("Extract verified release into isolated immutable digest directory",()=>{
  it("stages valid manifest-bound archive, is idempotent and rejects tampering",async()=>{
    const base=fs.mkdtempSync(path.join(os.tmpdir(),"mcp-backend-stage-"));
    const stage=path.join(base,"source");
    const config=path.join(base,"config");
    try{
      for(const p of ["src","dist","node_modules/ink","node_modules/r-memory","node_modules/sharp"])
        fs.mkdirSync(path.join(stage,p),{recursive:true});
      fs.writeFileSync(path.join(stage,"src/cli.ts"),"export default 1;");
      fs.writeFileSync(path.join(stage,"dist/cli.js"),"export default 1;");
      fs.writeFileSync(path.join(stage,"package.json"),'{"name":"superagent","version":"1.14.88"}');
      fs.writeFileSync(path.join(stage,"bun.lock"),"test fixture");
      const built=writeCoreBuildManifest(stage);
      const manifest={schemaVersion:1,repository:"RudyCity/superagent",tag,
        sourceCommit:commit,version:"1.14.88",platform:"win32",arch:"x64",
        compiledDigest:built.digest,sourceDigest:built.sourceDigest};
      fs.writeFileSync(path.join(stage,"mcp-backend-bundle.json"),JSON.stringify(manifest));
      const archive=path.join(base,"candidate.tgz");
      await tar.c({cwd:stage,file:archive,gzip:true},[
        "dist","package.json","bun.lock","node_modules","mcp-backend-bundle.json"]);
      const bytes=fs.statSync(archive).size;
      const sum=crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
      const inputs={archivePath:archive,size:bytes,sha256:sum,tag,sourceCommit:commit,configDir:config};
      await expect(stageVerifiedBackendArchive({...inputs,sha256:"f".repeat(64)}))
        .rejects.toThrow("ARCHIVE_HASH_MISMATCH");
      await expect(stageVerifiedBackendArchive({...inputs,sourceCommit:"c".repeat(40)}))
        .rejects.toThrow("MANIFEST_MISMATCH");
      const staged=await stageVerifiedBackendArchive(inputs);
      expect(staged.digest).toBe(built.digest);
      expect(staged.directory).toBe(backendReleaseDirectory(built.digest,config));
      expect(fs.existsSync(path.join(staged.directory,"dist/cli.js"))).toBe(true);
      expect(await stageVerifiedBackendArchive(inputs)).toEqual(staged);
      const receipt=JSON.parse(fs.readFileSync(path.join(staged.directory,"mcp-backend-release-receipt.json"),"utf8"));
      expect(receipt.sourceCommit).toBe(commit);
      expect(receipt.assetSha256).toBe(sum);
    }finally{fs.rmSync(base,{recursive:true,force:true});}
  },30_000);
});
