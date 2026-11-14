/**
 * Deterministic content fingerprint for source-mode and compiled Core workers.
 * Hashes actual entry tree bytes, not a Git commit label or process PID.
 * Compiled mode additionally requires a postbuild manifest matching CURRENT sources.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type CoreBuildIdentity = {
  mode: "source" | "compiled";
  digest: string;
  fileCount: number;
  sourceDigest: string;
  builtAt?: number;
  fresh: boolean;
};

function inside(root: string, test: string): boolean {
  const rel = path.relative(root,test);
  return rel !== "" && !rel.startsWith(".."+path.sep) && !path.isAbsolute(rel);
}
function collect(dir:string,base:string,extensions:ReadonlySet<string>,items:string[],omittedDirectory?:string) {
  const entries=fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,"en"));
  for (const entry of entries) {
    const file=path.join(dir,entry.name);
    if (entry.isSymbolicLink()) throw new Error("CORE_BUILD_SYMLINK_NOT_ALLOWED");
    if (entry.isDirectory()) {
      if (file!==omittedDirectory && !["node_modules",".git","__tests__"].includes(entry.name))
        collect(file,base,extensions,items,omittedDirectory);
    } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      if (entry.name.endsWith(".map")) continue;
      items.push(file);
    }
  }
}
function treeDigest(root:string,mode:"source"|"compiled",omittedDirectory?:string) {
  const dir=path.join(root,mode==="source"?"src":"dist");
  if (!fs.statSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink())
    throw new Error("CORE_BUILD_UNSAFE_TREE");
  const files:string[]=[];
  collect(dir,root,mode==="source"
    ? new Set([".ts",".tsx",".js",".json"]) : new Set([".js",".json"]),files,omittedDirectory);
  files.sort((a,b)=>path.relative(root,a).localeCompare(path.relative(root,b),"en"));
  const hasher=crypto.createHash("sha256");
  for(const file of files) {
    if(path.basename(file)==="core-build-identity.json") continue;
    const info=fs.lstatSync(file);
    if(!info.isFile() || info.isSymbolicLink() || info.size > 20*1024*1024)
      throw new Error("CORE_BUILD_UNSAFE_FILE");
    hasher.update(path.relative(root,file).split(path.sep).join("/")+"\0");
    hasher.update(crypto.createHash("sha256").update(fs.readFileSync(file)).digest());
  }
  const extras = mode === "source" ? ["package.json", "tsconfig.json"] : ["package.json"];
  for(const extra of extras) {
    const f=path.join(root,extra);
    if(fs.existsSync(f)) {
      if(fs.lstatSync(f).isSymbolicLink())throw new Error("CORE_BUILD_UNSAFE_CONFIG");
      hasher.update(extra+"\0");
      hasher.update(crypto.createHash("sha256").update(fs.readFileSync(f)).digest());
    }
  }
  if(files.length<1)throw new Error("CORE_BUILD_EMPTY_TREE");
  return {digest:hasher.digest("hex"),fileCount:files.length};
}
export function inspectCoreBuild(entry:string,options:{requireFreshCompiled?:boolean}={}):CoreBuildIdentity {
  const full=path.resolve(entry);
  let ancestor=path.dirname(full);
  let root="";
  for(let n=0;n<8;n++) {
    if(fs.existsSync(path.join(ancestor,"package.json")) &&
       (inside(path.join(ancestor,"src"),full)||inside(path.join(ancestor,"dist"),full))) {
      root=ancestor;break;
    }
    const parent=path.dirname(ancestor);
    if(parent===ancestor)break;
    ancestor=parent;
  }
  if(!root)throw new Error("CORE_BUILD_ENTRY_OUTSIDE_PROJECT");
  const mode:"source"|"compiled"=inside(path.join(root,"src"),full)?"source":"compiled";
  const selected=treeDigest(root,mode);
  if(mode==="source") {
    const source=selected;
    return {...selected,sourceDigest:source.digest,mode,fresh:true};
  }
  const srcDir=path.join(root,"src");
  const hasSource=fs.existsSync(srcDir);
  const file=path.join(root,"dist","core-build-identity.json");
  let builtAt: number|undefined;
  let fresh=false;
  let sourceDigest="";
  if(hasSource) {
    const source=treeDigest(root,"source");
    sourceDigest=source.digest;
    try {
      const stat=fs.lstatSync(file);
      if(!stat.isFile() || stat.isSymbolicLink() || stat.size>2048)throw new Error();
      const manifest=JSON.parse(fs.readFileSync(file,"utf8"));
      builtAt=manifest.builtAt;
      fresh=manifest.version===1 && manifest.mode==="compiled" &&
        manifest.sourceDigest===sourceDigest && manifest.digest===selected.digest;
    }catch{}
  } else {
    try {
      const stat=fs.lstatSync(file);
      if(!stat.isFile() || stat.isSymbolicLink() || stat.size>2048)throw new Error();
      const manifest=JSON.parse(fs.readFileSync(file,"utf8"));
      builtAt=manifest.builtAt;
      sourceDigest=typeof manifest.sourceDigest==="string"?manifest.sourceDigest:"";
      fresh=manifest.version===1 && manifest.mode==="compiled" &&
        manifest.digest===selected.digest;
    }catch{}
  }
  if(options.requireFreshCompiled && !fresh)
    throw new Error("CORE_BUILD_STALE_OR_UNVERIFIED: run bun run build first");
  return {...selected,sourceDigest,mode,fresh,builtAt};
}
/**
 * Attest the exact Windows standalone redistribution, not an arbitrary stale
 * compiled tree. The verified native UIA files move from dist/native to
 * standalone/native so their Windows DLL is not part of the MCP backend.
 * Recompute only after validating that this is the *sole* difference between
 * source and standalone compiled bytes and the relocated files are identical.
 * The original source digest remains bound to a previously fresh build.
 */
export function attestWindowsStandaloneCoreBuild(sourceRoot:string,stageRoot:string):CoreBuildIdentity {
  const original=path.resolve(sourceRoot),staged=path.resolve(stageRoot);
  if(original===staged || fs.existsSync(path.join(staged,"src")))
    throw new Error("CORE_STANDALONE_UNSAFE_STAGING_ROOT");
  const source=inspectCoreBuild(path.join(original,"dist","cli.js"),{requireFreshCompiled:true});
  if(source.mode!=="compiled" || !/^[a-f0-9]{64}$/.test(source.sourceDigest))
    throw new Error("CORE_STANDALONE_SOURCE_NOT_VERIFIED");
  const relative=path.join("native","desktop-live-windows-input");
  const movedFrom=path.join(original,"dist",relative);
  const movedTo=path.join(staged,relative);
  if(!fs.existsSync(movedFrom) || fs.existsSync(path.join(staged,"dist",relative)))
    throw new Error("CORE_STANDALONE_RELOCATION_NOT_EXACT");
  const names=["winremote.dll","winremote.provenance.json","winremote.sha256"];
  if(fs.readdirSync(movedFrom).sort().join("|")!==names.join("|") ||
     fs.readdirSync(movedTo).sort().join("|")!==names.join("|"))
    throw new Error("CORE_STANDALONE_NATIVE_FILES_UNEXPECTED");
  for(const name of names){
    const src=path.join(movedFrom,name),dst=path.join(movedTo,name);
    const a=fs.lstatSync(src),b=fs.lstatSync(dst);
    if(!a.isFile() || !b.isFile() || a.isSymbolicLink() || b.isSymbolicLink() ||
       a.size!==b.size || !fs.readFileSync(src).equals(fs.readFileSync(dst)))
      throw new Error("CORE_STANDALONE_NATIVE_RELOCATION_MISMATCH");
  }
  const expected=treeDigest(original,"compiled",movedFrom);
  const actual=treeDigest(staged,"compiled");
  if(expected.digest!==actual.digest || expected.fileCount!==actual.fileCount)
    throw new Error("CORE_STANDALONE_COMPILED_BYTES_MISMATCH");
  const identity:CoreBuildIdentity={
    mode:"compiled",...actual,sourceDigest:source.sourceDigest,fresh:true,builtAt:Date.now(),
  };
  const target=path.join(staged,"dist","core-build-identity.json");
  const stat=fs.lstatSync(target);
  if(!stat.isFile() || stat.isSymbolicLink())
    throw new Error("CORE_STANDALONE_MANIFEST_UNSAFE");
  fs.writeFileSync(target,JSON.stringify({version:1,...identity},null,2)+"\n");
  inspectCoreBuild(path.join(staged,"dist","cli.js"),{requireFreshCompiled:true});
  return identity;
}
export function writeCoreBuildManifest(root:string):CoreBuildIdentity {
  const entry=path.resolve(root,"dist","cli.js");
  if(!fs.existsSync(entry))throw new Error("CORE_BUILD_DIST_MISSING");
  const compiled=treeDigest(root,"compiled"),source=treeDigest(root,"source");
  const identity:CoreBuildIdentity={mode:"compiled",...compiled,sourceDigest:source.digest,fresh:true,builtAt:Date.now()};
  const target=path.join(root,"dist","core-build-identity.json");
  fs.writeFileSync(target,JSON.stringify({version:1,...identity},null,2)+"\n");
  return identity;
}
