/**
 * Checksummed GitHub prerelease selection and fail-closed, non-executing
 * side-by-side backend extraction. No owner, tunnel or Core mutation.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import {getRootConfigDir} from "../config/paths.js";
import {inspectCoreBuild} from "./coreBuildIdentity.js";
import {backendReleaseDirectory,verifyMcpBackendRelease} from "./mcpBackendReleasePolicy.js";

const REPO = "RudyCity/superagent";
const TAG = /^v(\d+\.\d+\.\d+)-rc\.\d+$/;
const DIGEST = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const MAX_COMPRESSED = 1_500_000_000;
const MAX_UNPACKED = 5_000_000_000;
export type ReleaseAsset = {
  name:string; size:number; browser_download_url:string;
  digest?:string|null;
};
export type GitHubRelease = {
  tag_name:string; draft:boolean; prerelease:boolean;
  assets:ReleaseAsset[];
};
export type BackendCandidate = {
  tag:string; version:string; asset:ReleaseAsset; checksums:ReleaseAsset;
};
export function backendBundleName(version:string):string {
  if(!/^\d+\.\d+\.\d+$/.test(version))throw Error("MCP_BACKEND_RELEASE_VERSION_INVALID");
  return "SuperAgent-MCP-Backend-"+version+"-windows-x64.tgz";
}
export function selectOfficialBackendRelease(
  releases:GitHubRelease[], requestedTag?:string,
):BackendCandidate {
  if(!Array.isArray(releases) || (requestedTag!==undefined && !TAG.test(requestedTag)))
    throw Error("MCP_BACKEND_RELEASE_TAG_INVALID");
  for(const r of releases){
    if(!r || r.draft || r.prerelease!==true || !TAG.test(r.tag_name) ||
       !Array.isArray(r.assets) || requestedTag && r.tag_name!==requestedTag)continue;
    const version=TAG.exec(r.tag_name)![1];
    const file=backendBundleName(version);
    const assets=r.assets.filter(a=>a.name===file);
    const sums=r.assets.filter(a=>a.name==="SHA256SUMS.txt");
    if(assets.length!==1 || sums.length!==1)continue;
    const asset=assets[0],checksums=sums[0];
    if(!Number.isSafeInteger(asset.size)||asset.size<1000||asset.size>MAX_COMPRESSED||
       !Number.isSafeInteger(checksums.size)||checksums.size<65||checksums.size>65536)continue;
    return {tag:r.tag_name,version,asset,checksums};
  }
  throw Error("MCP_BACKEND_RELEASE_PUBLISHED_ARTIFACT_NOT_FOUND");
}
export function officialAssetUrl(tag:string,asset:ReleaseAsset):string {
  if(!TAG.test(tag)||!(/^[a-zA-Z0-9._-]+$/.test(asset.name)))
    throw Error("MCP_BACKEND_RELEASE_ASSET_NAME_INVALID");
  const u=new URL(asset.browser_download_url);
  const expected="/"+REPO+"/releases/download/"+tag+"/"+asset.name;
  if(u.protocol!=="https:"||u.host!=="github.com"||u.pathname!==expected||
     u.search||u.hash)throw Error("MCP_BACKEND_RELEASE_UNTRUSTED_ASSET_URL");
  return u.href;
}
export function exactChecksum(manifest:string,filename:string):string {
  let found:string|undefined;
  for(const line of manifest.split(/\r?\n/)){
    const match=/^([a-f0-9A-F]{64})\s+\*?(\S+)$/.exec(line.trim());
    if(!match)continue;
    if(match[2]!==filename&&match[2]!=="./"+filename)continue;
    if(found)throw Error("MCP_BACKEND_RELEASE_DUPLICATE_CHECKSUM");
    found=match[1].toLowerCase();
  }
  if(!found)throw Error("MCP_BACKEND_RELEASE_MISSING_CHECKSUM");
  return found;
}
function statRegular(file:string):fs.Stats{
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)
    throw Error("MCP_BACKEND_RELEASE_UNSAFE_FILE");
  return stat;
}
function insistDir(dir:string){
  const st=fs.lstatSync(dir);
  if(!st.isDirectory()||st.isSymbolicLink())throw Error("MCP_BACKEND_RELEASE_UNSAFE_DIRECTORY");
}
const roots=new Set(["package.json","bun.lock","dist","node_modules","scripts","patches","mcp-backend-bundle.json"]);
export function isSafeMcpBundleArchivePath(name:string):boolean{
  const cleaned=name.replace(/\/+$/,"");
  if(!cleaned||cleaned.startsWith("/")||cleaned.includes("\\")||
      cleaned.includes(":")||/[^\x20-\x7e]/.test(cleaned)||
      cleaned.split("/").some(p=>p==="."||p===".."||p==="")||
      !roots.has(cleaned.split("/")[0]))return false;
  return true;
}
export async function stageVerifiedBackendArchive(input:{
  archivePath:string; sha256:string; size:number; tag:string;
  sourceCommit:string; configDir?:string;
}):Promise<{digest:string;directory:string;tag:string;sourceCommit:string;assetSha256:string}>{
  if(!DIGEST.test(input.sha256)||!TAG.test(input.tag)||!COMMIT.test(input.sourceCommit)||
     !Number.isSafeInteger(input.size)||input.size<1||input.size>MAX_COMPRESSED)
    throw Error("MCP_BACKEND_RELEASE_UNVERIFIED_PROVENANCE");
  const version=TAG.exec(input.tag)![1];
  if(process.platform!=="win32"||process.arch!=="x64")
    throw Error("MCP_BACKEND_RELEASE_WINDOWS_X64_REQUIRED");
  if(statRegular(input.archivePath).size!==input.size)
    throw Error("MCP_BACKEND_RELEASE_ARCHIVE_SIZE_MISMATCH");
  const hash=crypto.createHash("sha256");
  for await(const chunk of fs.createReadStream(input.archivePath))hash.update(chunk);
  if(hash.digest("hex")!==input.sha256)
    throw Error("MCP_BACKEND_RELEASE_ARCHIVE_HASH_MISMATCH");

  const config=path.resolve(input.configDir??getRootConfigDir());
  fs.mkdirSync(config,{recursive:true,mode:0o700});
  insistDir(config);
  const releases=path.join(config,"mcp-backend-releases");
  fs.mkdirSync(releases,{recursive:true,mode:0o700});
  insistDir(releases);
  const temporary=fs.mkdtempSync(path.join(releases,".incoming-"));
  let moved=false;
  try{
    let count=0,total=0,unsafe=false;
    const paths=new Set<string>();
    await tar.t({file:input.archivePath,onReadEntry(entry){
      const name=entry.path.replace(/\/+$/,"");
      total+=entry.size;
      count++;
      if(!isSafeMcpBundleArchivePath(name)||
         (entry.type!=="File"&&entry.type!=="Directory")||
         !Number.isSafeInteger(entry.size)||entry.size<0||
         total>MAX_UNPACKED||count>150_000||paths.has(name.toLowerCase()))
        unsafe=true;
      else paths.add(name.toLowerCase());
      entry.resume();
    }});
    if(unsafe)throw Error("MCP_BACKEND_RELEASE_UNSAFE_ARCHIVE_MEMBER");
    for(const required of ["package.json","dist/cli.js","dist/core-build-identity.json",
      "bun.lock","mcp-backend-bundle.json"])
      if(!paths.has(required))throw Error("MCP_BACKEND_RELEASE_ARCHIVE_INCOMPLETE");
    await tar.x({file:input.archivePath,cwd:temporary,strict:true,preservePaths:false,
      filter:(name,entry)=>{
        const kind="type" in entry ? entry.type :
          entry.isFile() ? "File" : entry.isDirectory() ? "Directory" : "Other";
        return isSafeMcpBundleArchivePath(name)&&(kind==="File"||kind==="Directory");
      }});
    const metaFile=path.join(temporary,"mcp-backend-bundle.json");
    const info=statRegular(metaFile);
    if(info.size>4096)throw Error("MCP_BACKEND_RELEASE_BAD_MANIFEST");
    const meta=JSON.parse(fs.readFileSync(metaFile,"utf8"));
    if(meta.schemaVersion!==1||meta.repository!==REPO||meta.tag!==input.tag||
       meta.sourceCommit!==input.sourceCommit||meta.version!==version||
       meta.platform!=="win32"||meta.arch!=="x64"||!DIGEST.test(meta.compiledDigest)||
       !DIGEST.test(meta.sourceDigest))
      throw Error("MCP_BACKEND_RELEASE_MANIFEST_MISMATCH");
    if(JSON.parse(fs.readFileSync(path.join(temporary,"package.json"),"utf8")).version!==version)
      throw Error("MCP_BACKEND_RELEASE_VERSION_MISMATCH");
    const build=inspectCoreBuild(path.join(temporary,"dist/cli.js"),{requireFreshCompiled:true});
    if(build.mode!=="compiled"||build.digest!==meta.compiledDigest||
       build.sourceDigest!==meta.sourceDigest)throw Error("MCP_BACKEND_RELEASE_BUILD_MISMATCH");
    if(!fs.existsSync(path.join(temporary,"node_modules/ink")) ||
       !fs.existsSync(path.join(temporary,"node_modules/r-memory"))||
       !fs.existsSync(path.join(temporary,"node_modules/sharp")))
      throw Error("MCP_BACKEND_RELEASE_DEPENDENCIES_MISSING");
    const destination=backendReleaseDirectory(build.digest,config);
    if(fs.existsSync(destination)){
      const existing=verifyMcpBackendRelease(build.digest,config);
      const record=JSON.parse(fs.readFileSync(path.join(destination,"mcp-backend-release-receipt.json"),"utf8"));
      if(record.assetSha256!==input.sha256||record.tag!==input.tag||
         record.sourceCommit!==input.sourceCommit)
        throw Error("MCP_BACKEND_RELEASE_ALREADY_STAGED_DIFFERENT");
      return {digest:existing.digest,directory:destination,tag:input.tag,
        sourceCommit:input.sourceCommit,assetSha256:input.sha256};
    }
    fs.writeFileSync(path.join(temporary,"mcp-backend-release-receipt.json"),JSON.stringify({
      schemaVersion:1,tag:input.tag,sourceCommit:input.sourceCommit,
      assetSha256:input.sha256,compressedBytes:input.size,compiledDigest:build.digest,
      stagedAt:new Date().toISOString(),
    },null,2)+"\n",{flag:"wx",mode:0o600});
    fs.renameSync(temporary,destination);
    moved=true;
    verifyMcpBackendRelease(build.digest,config);
    return {digest:build.digest,directory:destination,tag:input.tag,
      sourceCommit:input.sourceCommit,assetSha256:input.sha256};
  }finally{
    if(!moved&&fs.existsSync(temporary))fs.rmSync(temporary,{recursive:true,force:true});
  }
}
