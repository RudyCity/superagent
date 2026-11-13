import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import {afterEach,describe,expect,it,vi} from "vitest";
import {writeCoreBuildManifest} from "../src/core/runtime/coreBuildIdentity.js";
import {resolveGithubBackendCandidate,downloadAndStageGithubBackend}
  from "../src/core/runtime/mcpBackendGithubRelease.js";
import {backendBundleName} from "../src/core/runtime/mcpBackendReleaseStager.js";

const version="1.14.88",tag="v1.14.88-rc.9",commit="a".repeat(40);
const fileName=backendBundleName(version);
const assetUrl="https://github.com/RudyCity/superagent/releases/download/"+tag+"/"+fileName;
const checksumUrl="https://github.com/RudyCity/superagent/releases/download/"+tag+"/SHA256SUMS.txt";
const resultUrl="https://release-assets.githubusercontent.com/verified-backend";

describe.skipIf(process.platform!=="win32")("Official GitHub backend staged release integration",()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it("verifies remote tag, SHA-256 and archive provenance, and stages without activation",async()=>{
    const base=fs.mkdtempSync(path.join(os.tmpdir(),"mcp-github-integration-"));
    const src=path.join(base,"src-bundle"),config=path.join(base,"config");
    try{
      for(const folder of ["src","dist","node_modules/ink","node_modules/r-memory","node_modules/sharp"])
        fs.mkdirSync(path.join(src,folder),{recursive:true});
      fs.writeFileSync(path.join(src,"package.json"),JSON.stringify({name:"superagent",version}));
      fs.writeFileSync(path.join(src,"bun.lock"),"fixture");
      fs.writeFileSync(path.join(src,"src/cli.ts"),"export const value=1;");
      fs.writeFileSync(path.join(src,"dist/cli.js"),"export const value=1;");
      fs.writeFileSync(path.join(src,"node_modules/ink/random.bin"),crypto.randomBytes(8192));
      const built=writeCoreBuildManifest(src);
      const metadata={schemaVersion:1,repository:"RudyCity/superagent",tag,
        sourceCommit:commit,version,platform:"win32",arch:"x64",
        compiledDigest:built.digest,sourceDigest:built.sourceDigest};
      fs.writeFileSync(path.join(src,"mcp-backend-bundle.json"),JSON.stringify(metadata));
      const archive=path.join(base,"verified.tgz");
      await tar.c({cwd:src,file:archive,gzip:true},
        ["package.json","bun.lock","dist","node_modules","mcp-backend-bundle.json"]);
      const data=fs.readFileSync(archive);
      const hash=crypto.createHash("sha256").update(data).digest("hex");
      const manifest=hash+"  "+fileName+"\n";
      const release={
        tag_name:tag,draft:false,prerelease:true,
        assets:[
          {name:fileName,size:data.length,browser_download_url:assetUrl,digest:"sha256:"+hash},
          {name:"SHA256SUMS.txt",size:Buffer.byteLength(manifest),
            browser_download_url:checksumUrl,digest:"sha256:"+crypto.createHash("sha256").update(manifest).digest("hex")},
        ],
      };
      let tagLookups=0,binaryDownloads=0;
      vi.stubGlobal("fetch",vi.fn(async(input:URL|string, options?:RequestInit)=>{
        const url=String(input);
        let body:Buffer|string;
        let final=url;
        if(url.endsWith("/releases?per_page=30"))body=JSON.stringify([release]);
        else if(url.endsWith("/git/ref/tags/"+tag)){
          tagLookups++;
          body=JSON.stringify({ref:"refs/tags/"+tag,object:{type:"commit",sha:commit}});
        }else if(url===checksumUrl){body=manifest;final=resultUrl;}
        else if(url===assetUrl){binaryDownloads++;body=data;final=resultUrl;}
        else throw Error("Unexpected network target: "+url);
        if((url.startsWith("https://api.github.com")||url.startsWith("https://github.com"))&&
            options?.headers&&typeof options.headers==="object"&&
            "Authorization" in options.headers)
          throw Error("No test credentials should be used");
        const response=new Response(body,{status:200});
        Object.defineProperty(response,"url",{value:final});
        return response;
      }));
      const selected=await resolveGithubBackendCandidate(tag);
      expect(selected).toMatchObject({sourceCommit:commit,checksum:hash});
      const staged=await downloadAndStageGithubBackend(selected,config);
      expect(staged).toMatchObject({digest:built.digest,tag,sourceCommit:commit,assetSha256:hash});
      expect(tagLookups).toBe(2); // once at plan, once immediately before staging
      expect(binaryDownloads).toBe(1);
      expect(fs.existsSync(path.join(staged.directory,"dist/cli.js"))).toBe(true);
      expect(fs.readdirSync(config).some(x=>x.endsWith(".partial"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      fs.rmSync(base,{recursive:true,force:true});
    }
  },35_000);
});
