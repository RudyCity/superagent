/**
 * CI proof that the Windows MCP backend archive is independently usable.
 * It extracts into a disposable private test-only staging profile, never
 * into the active MCP owner profile or an installed SuperAgent directory.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {backendBundleName,stageVerifiedBackendArchive} from "../src/core/runtime/mcpBackendReleaseStager.js";
import {verifyMcpBackendRelease} from "../src/core/runtime/mcpBackendReleasePolicy.js";
const root=path.resolve(import.meta.dir,"..");
const version=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8")).version;
const tag=process.env.GITHUB_REF_NAME||"";
const sourceCommit=process.env.GITHUB_SHA||"";
const archive=path.join(root,"build/release-mcp-backend",backendBundleName(version));
async function main(){
  if(process.platform!=="win32"||process.arch!=="x64")throw Error("MCP_BUNDLE_CI_WINDOWS_REQUIRED");
  if(!fs.existsSync(archive))throw Error("MCP_BUNDLE_CI_ARCHIVE_MISSING");
  const hash=crypto.createHash("sha256");
  for await(const part of fs.createReadStream(archive))hash.update(part);
  const bytes=fs.statSync(archive).size;
  const parent=path.join(os.homedir(),".superagent-local-staging");
  fs.mkdirSync(parent,{recursive:true,mode:0o700});
  const disposable=fs.mkdtempSync(path.join(parent,"mcp-bundle-ci-"));
  try{
    const staged=await stageVerifiedBackendArchive({
      archivePath:archive,sha256:hash.digest("hex"),size:bytes,
      tag,sourceCommit,configDir:disposable,
    });
    const verified=verifyMcpBackendRelease(staged.digest,disposable);
    if(verified.entry!==path.join(staged.directory,"dist/cli.js"))
      throw Error("MCP_BUNDLE_CI_ENTRY_MISMATCH");
    console.log("MCP_BACKEND_RELEASE_ASSET_VERIFIED",version,staged.digest,bytes);
  }finally{
    fs.rmSync(disposable,{recursive:true,force:true});
  }
}
if(import.meta.main)main().catch(e=>{console.error(e);process.exitCode=1;});
