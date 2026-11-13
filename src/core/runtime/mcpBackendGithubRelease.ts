/**
 * Select a pinned official GitHub prerelease, verify its tag commit, checksum
 * manifest and bounded asset stream, then stage only the backend bundle.
 * No install, promotion, owner restart, Cloudflare or OAuth mutation.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {finished} from "node:stream/promises";
import {getRootConfigDir} from "../config/paths.js";
import {backendBundleName,exactChecksum,officialAssetUrl,
  selectOfficialBackendRelease,stageVerifiedBackendArchive,
  type GitHubRelease, type BackendCandidate, type ReleaseAsset} from "./mcpBackendReleaseStager.js";
const API="https://api.github.com/repos/RudyCity/superagent/";
const UA="SuperAgent-verified-mcp-backend-stager";
const SHA=/^[a-f0-9]{40}$/;
export type VerifiedGithubBackendCandidate={
  candidate:BackendCandidate; sourceCommit:string; checksum:string;
};
function authHeaders():Record<string,string>{
  const token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN;
  return {"User-Agent":UA,"Accept":"application/vnd.github+json",
    "X-GitHub-Api-Version":"2022-11-28",
    ...(token?{Authorization:"Bearer "+token}:{})};
}
async function apiJson(pathPart:string):Promise<any>{
  const u=new URL(pathPart,API);
  if(u.origin!=="https://api.github.com"||!u.pathname.startsWith("/repos/RudyCity/superagent/"))
    throw Error("MCP_BACKEND_GITHUB_API_URL_UNTRUSTED");
  const r=await fetch(u,{headers:authHeaders(),signal:AbortSignal.timeout(25_000)});
  if(!r.ok)throw Error("MCP_BACKEND_GITHUB_API_HTTP_"+r.status);
  const size=Number(r.headers.get("content-length")||0);
  if(size>1_500_000)throw Error("MCP_BACKEND_GITHUB_API_TOO_LARGE");
  let length=0;const chunks:Uint8Array[]=[];
  if(!r.body)throw Error("MCP_BACKEND_GITHUB_API_NO_BODY");
  for await(const part of r.body){
    length+=part.byteLength;
    if(length>1_500_000)throw Error("MCP_BACKEND_GITHUB_API_TOO_LARGE");
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function tagCommit(tag:string):Promise<string>{
  const ref=await apiJson("git/ref/tags/"+encodeURIComponent(tag));
  if(ref.ref!=="refs/tags/"+tag||!SHA.test(ref.object?.sha))
    throw Error("MCP_BACKEND_GITHUB_REF_UNVERIFIED");
  if(ref.object.type==="commit")return ref.object.sha;
  if(ref.object.type==="tag"){
    const annotated=await apiJson("git/tags/"+ref.object.sha);
    if(annotated.object?.type!=="commit"||!SHA.test(annotated.object.sha))
      throw Error("MCP_BACKEND_GITHUB_ANNOTATED_TAG_UNVERIFIED");
    return annotated.object.sha;
  }
  throw Error("MCP_BACKEND_GITHUB_TAG_UNSUPPORTED");
}
async function releaseResponse(candidate:BackendCandidate,asset:ReleaseAsset,timeout:number){
  const u=officialAssetUrl(candidate.tag,asset);
  // Private releases require an operator token; fetch strips Authorization on
  // cross-origin redirects. Never print or persist the token.
  const token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN;
  const r=await fetch(u,{headers:{"User-Agent":UA,
    ...(token?{Authorization:"Bearer "+token}:{})},signal:AbortSignal.timeout(timeout)});
  const final=new URL(r.url);
  if(final.protocol!=="https:"||
     !["github.com","release-assets.githubusercontent.com","objects.githubusercontent.com"].includes(final.hostname))
    throw Error("MCP_BACKEND_GITHUB_UNTRUSTED_REDIRECT");
  if(!r.ok||!r.body)throw Error("MCP_BACKEND_GITHUB_ASSET_HTTP_"+r.status);
  return r;
}
export async function resolveGithubBackendCandidate(
  requestedTag?:string,
):Promise<VerifiedGithubBackendCandidate>{
  const list=await apiJson("releases?per_page=30") as GitHubRelease[];
  const candidate=selectOfficialBackendRelease(list,requestedTag);
  const [sourceCommit,resp]=await Promise.all([
    tagCommit(candidate.tag),releaseResponse(candidate,candidate.checksums,30_000),
  ]);
  let length=0;const chunks:Uint8Array[]=[];
  for await(const part of resp.body!){
    length+=part.byteLength;
    if(length>candidate.checksums.size||length>65_536)
      throw Error("MCP_BACKEND_GITHUB_CHECKSUM_TOO_LARGE");
    chunks.push(part);
  }
  if(length!==candidate.checksums.size)
    throw Error("MCP_BACKEND_GITHUB_CHECKSUM_SIZE_MISMATCH");
  const manifest=Buffer.concat(chunks);
  if(candidate.checksums.digest){
    if(candidate.checksums.digest!=="sha256:"+crypto.createHash("sha256").update(manifest).digest("hex"))
      throw Error("MCP_BACKEND_GITHUB_CHECKSUM_ASSET_DIGEST_MISMATCH");
  }
  const checksum=exactChecksum(manifest.toString("utf8"),backendBundleName(candidate.version));
  if(candidate.asset.digest && candidate.asset.digest!=="sha256:"+checksum)
    throw Error("MCP_BACKEND_GITHUB_ASSET_DIGEST_MISMATCH");
  return {candidate,sourceCommit,checksum};
}
export async function downloadAndStageGithubBackend(
  verified:VerifiedGithubBackendCandidate,
  configDir=getRootConfigDir(),
):Promise<Awaited<ReturnType<typeof stageVerifiedBackendArchive>>>{
  if(process.platform!=="win32"||process.arch!=="x64")
    throw Error("MCP_BACKEND_GITHUB_WINDOWS_X64_REQUIRED");
  const dir=path.resolve(configDir);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if(fs.lstatSync(dir).isSymbolicLink())throw Error("MCP_BACKEND_GITHUB_UNSAFE_CONFIG_DIR");
  const temp=path.join(dir,"mcp-backend-"+crypto.randomBytes(12).toString("hex")+".partial");
  // A reviewed tag must not be retargeted between discovery and staging.
  if(await tagCommit(verified.candidate.tag)!==verified.sourceCommit)
    throw Error("MCP_BACKEND_GITHUB_TAG_CHANGED_SINCE_REVIEW");
  const response=await releaseResponse(verified.candidate,verified.candidate.asset,300_000);
  const hash=crypto.createHash("sha256");
  let bytes=0;
  const output=fs.createWriteStream(temp,{flags:"wx",mode:0o600});
  try{
    for await(const part of response.body!){
      bytes+=part.byteLength;
      if(bytes>verified.candidate.asset.size)throw Error("MCP_BACKEND_GITHUB_ASSET_TOO_LARGE");
      hash.update(part);
      if(!output.write(part))await new Promise<void>((resolve,reject)=>{
        output.once("drain",resolve);output.once("error",reject);
      });
    }
    output.end();
    await finished(output);
    if(bytes!==verified.candidate.asset.size||hash.digest("hex")!==verified.checksum)
      throw Error("MCP_BACKEND_GITHUB_ASSET_HASH_OR_SIZE_MISMATCH");
    return await stageVerifiedBackendArchive({
      archivePath:temp,sha256:verified.checksum,size:bytes,
      tag:verified.candidate.tag,sourceCommit:verified.sourceCommit,configDir:dir,
    });
  } finally {
    output.destroy();
    if(fs.existsSync(temp))fs.rmSync(temp,{force:true});
  }
}
