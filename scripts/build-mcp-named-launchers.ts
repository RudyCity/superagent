#!/usr/bin/env bun
/**
 * Compile two source-only Named MCP stack launchers into portable Bun bundles.
 * No Cloudflare token, OAuth grant, runtime process or user profile is accessed.
 * The release carries the manifest alongside its version-matched binaries.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";

export const BUNDLES=["mcp-tunnel-anchor.js","mcp-named-owner.js"] as const;
export type McpNamedLauncherManifest={
  schemaVersion:1;
  package:"superagent";
  version:string;
  target:"bun";
  scripts:Record<(typeof BUNDLES)[number],string>;
};
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const STAGE=path.join(ROOT,"dist","scripts");
function requireFile(file:string,max=20_000_000,min=1024):Buffer{
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||
     stat.size<min||stat.size>max)
    throw Error("MCP_NAMED_LAUNCHER_ARTIFACT_UNSAFE");
  return fs.readFileSync(file);
}
export function digest(file:string):string{
  return crypto.createHash("sha256").update(requireFile(file)).digest("hex");
}
export function verifyMcpNamedLauncherArtifacts(root=ROOT):McpNamedLauncherManifest{
  const data=requireFile(path.join(root,"dist/scripts/mcp-named-launchers.json"),8192,100);
  const manifest=JSON.parse(data.toString("utf8")) as McpNamedLauncherManifest;
  const pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8")) as {
    name:string;version:string;
  };
  if(manifest?.schemaVersion!==1||
     manifest.package!=="superagent"||manifest.target!=="bun"||
     manifest.version!==pkg.version||pkg.name!=="superagent"||
     !manifest.scripts||Object.keys(manifest.scripts).sort().join(",")!==
        [...BUNDLES].sort().join(","))
    throw Error("MCP_NAMED_LAUNCHER_MANIFEST_VERSION_OR_SCHEMA_MISMATCH");
  for(const name of BUNDLES){
    const file=path.join(root,"dist","scripts",name);
    const sha=manifest.scripts[name];
    if(!/^[a-f0-9]{64}$/.test(sha)||digest(file)!==sha)
      throw Error("MCP_NAMED_LAUNCHER_SHA256_MISMATCH");
  }
  return manifest;
}
if(import.meta.main){
  const pkg=JSON.parse(fs.readFileSync(path.join(ROOT,"package.json"),"utf8"));
  if(pkg.name!=="superagent"||typeof pkg.version!=="string")
    throw Error("MCP_NAMED_LAUNCHER_PACKAGE_MISMATCH");
  fs.mkdirSync(STAGE,{recursive:true});
  for(const name of BUNDLES){
    const target=path.join(STAGE,name);
    if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())
      throw Error("MCP_NAMED_LAUNCHER_OUTPUT_SYMLINK");
  }
  const build=spawnSync(process.execPath,[
    "build","scripts/mcp-tunnel-anchor.ts","scripts/mcp-named-owner.ts",
    "--target=bun","--packages=external","--outdir=dist/scripts",
  ],{cwd:ROOT,encoding:"utf8",timeout:90_000,windowsHide:true,
      maxBuffer:1024*1024});
  if(build.error||build.status!==0)
    throw Error("MCP_NAMED_LAUNCHER_BUILD_FAILED");
  const scripts={
    "mcp-tunnel-anchor.js":digest(path.join(STAGE,"mcp-tunnel-anchor.js")),
    "mcp-named-owner.js":digest(path.join(STAGE,"mcp-named-owner.js")),
  };
  const result:McpNamedLauncherManifest={
    schemaVersion:1,package:"superagent",version:pkg.version,
    target:"bun",scripts,
  };
  const manifestFile=path.join(STAGE,"mcp-named-launchers.json");
  if(fs.existsSync(manifestFile)&&fs.lstatSync(manifestFile).isSymbolicLink())
    throw Error("MCP_NAMED_LAUNCHER_MANIFEST_SYMLINK");
  fs.writeFileSync(manifestFile,JSON.stringify(result,null,2)+"\n");
  verifyMcpNamedLauncherArtifacts(ROOT);
  console.log("[Named MCP] two Bun launchers bundled and SHA-256 verified, version "+pkg.version);
}
