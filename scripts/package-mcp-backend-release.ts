/**
 * Version-pinned MCP backend-only bundle, built from CI's already-verified
 * Windows standalone staging. Never touches the installed owner or tunnel.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import * as tar from "tar";
import {inspectCoreBuild} from "../src/core/runtime/coreBuildIdentity.js";
import {backendBundleName} from "../src/core/runtime/mcpBackendReleaseStager.js";

export async function packageMcpBackendRelease(input:{
  stage:string;outputDir:string;version:string;tag:string;sourceCommit:string;
}):Promise<{file:string;digest:string;sha256:string;size:number}>{
  if(process.platform!=="win32"||process.arch!=="x64")
    throw Error("MCP_BUNDLE_WINDOWS_X64_REQUIRED");
  const {version,tag,sourceCommit}=input;
  if(!/^\d+\.\d+\.\d+$/.test(version)||
     !new RegExp("^v"+version.replace(/\./g,"\\.")+"-rc\\.\\d+$").test(tag)||
     !/^[a-f0-9]{40}$/.test(sourceCommit))
    throw Error("MCP_BUNDLE_TAG_OR_COMMIT_UNVERIFIED");
  const stage=path.resolve(input.stage),out=path.resolve(input.outputDir);
  const st=fs.lstatSync(stage);
  if(!st.isDirectory()||st.isSymbolicLink()||
     !fs.existsSync(path.join(stage,".superagent-generated-standalone")))
    throw Error("MCP_BUNDLE_UNVERIFIED_INSTALLER_STAGING");
  if(JSON.parse(fs.readFileSync(path.join(stage,"package.json"),"utf8")).version!==version)
    throw Error("MCP_BUNDLE_STANDALONE_VERSION_MISMATCH");
  const build=inspectCoreBuild(path.join(stage,"dist/cli.js"),{requireFreshCompiled:true});
  if(build.mode!=="compiled")throw Error("MCP_BUNDLE_BUILD_NOT_COMPILED");
  for(const required of ["node_modules/ink","node_modules/r-memory","node_modules/sharp","bun.lock"]){
    if(!fs.existsSync(path.join(stage,required)))
      throw Error("MCP_BUNDLE_DEPENDENCY_MISSING: "+required);
  }
  const manifest={
    schemaVersion:1,repository:"RudyCity/superagent",tag,sourceCommit,version,
    platform:"win32",arch:"x64",compiledDigest:build.digest,sourceDigest:build.sourceDigest,
  };
  const metadata=path.join(stage,"mcp-backend-bundle.json");
  if(fs.existsSync(metadata))throw Error("MCP_BUNDLE_METADATA_ALREADY_EXISTS");
  fs.mkdirSync(out,{recursive:true});
  const file=path.join(out,backendBundleName(version));
  if(fs.existsSync(file))throw Error("MCP_BUNDLE_REFUSE_OVERWRITE");
  const partial=file+"."+crypto.randomBytes(8).toString("hex")+".partial";
  const entries=["package.json","bun.lock","dist","node_modules","scripts","patches",
    "mcp-backend-bundle.json"].filter(p=>p==="mcp-backend-bundle.json"||fs.existsSync(path.join(stage,p)));
  let unsafeMember:string|null=null;
  try{
    fs.writeFileSync(metadata,JSON.stringify(manifest,null,2)+"\n",{flag:"wx"});
    await tar.c({
      cwd:stage,file:partial,gzip:true,portable:true,noMtime:true,
      filter:(name,entry)=>{
        if(name.split("/").includes(".bin"))return false;
        const kind="type" in entry ? entry.type :
          entry.isFile() ? "File" : entry.isDirectory() ? "Directory" : "Other";
        if(name.includes("\\")||name.split("/").includes("..")||
           (kind!=="Directory"&&kind!=="File")){
          unsafeMember=name;
          return false;
        }
        return true;
      },
    },entries);
    if(unsafeMember)throw Error("MCP_BUNDLE_LINK_OR_DEVICE_REFUSED: "+unsafeMember);
    fs.renameSync(partial,file);
    const hash=crypto.createHash("sha256");
    for await(const part of fs.createReadStream(file))hash.update(part);
    return {file,digest:build.digest,sha256:hash.digest("hex"),size:fs.statSync(file).size};
  }finally{
    if(fs.existsSync(partial))fs.rmSync(partial,{force:true});
    fs.rmSync(metadata,{force:true});
  }
}
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
if(import.meta.main){
  const version=JSON.parse(fs.readFileSync(path.join(project,"package.json"),"utf8")).version;
  packageMcpBackendRelease({
    stage:path.join(project,"apps/superagent-tray/src-tauri/resources/standalone"),
    outputDir:path.join(project,"build/release-mcp-backend"),
    version,tag:process.env.GITHUB_REF_NAME||"",sourceCommit:process.env.GITHUB_SHA||"",
  }).then(result=>console.log("MCP_BACKEND_BUNDLE_BUILT",JSON.stringify(result)))
    .catch(error=>{console.error(error);process.exitCode=1;});
}
