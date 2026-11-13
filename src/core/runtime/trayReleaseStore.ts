/**
 * Content-addressed, rollbackable Tray executable deployment.
 * No in-place overwrite of a running .exe; only trusted local build output
 * is copied to immutable slot(s) under the private SuperAgent profile.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {getPackageRootDir,getRootConfigDir} from "../config/paths.js";

export type TrayReleaseState={
  version:1;revision:string;activeDigest:string|null;
  previousDigest:string|null;updatedAt:number;
};
const DIGEST=/^[a-f0-9]{64}$/;
export const releasesRoot=(root=getRootConfigDir())=>path.join(root,"bin","tray-releases");
export const releaseManifestPath=(root=getRootConfigDir())=>path.join(root,"tray-release-state.json");
export const releaseBinaryPath=(digest:string,root=getRootConfigDir())=>{
  if(!DIGEST.test(digest))throw new Error("TRAY_RELEASE_INVALID_DIGEST");
  return path.join(releasesRoot(root),"superagent-tray-"+digest+".exe");
};
export const fileSha256=(file:string)=>{
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1024||
     stat.size>200*1024*1024)throw new Error("TRAY_RELEASE_UNTRUSTED_BINARY");
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
};
function requirePrivateDirectory(dir:string){
  if(fs.existsSync(dir)){
    const st=fs.lstatSync(dir);
    if(!st.isDirectory()||st.isSymbolicLink())
      throw new Error("TRAY_RELEASE_UNSAFE_DIRECTORY");
  }else{
    requirePrivateDirectory(path.dirname(dir));
    fs.mkdirSync(dir,{mode:0o700});
  }
}
export function readTrayReleaseState(root=getRootConfigDir()):TrayReleaseState {
  const file=releaseManifestPath(root);
  try{
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>2048)
      throw new Error("TRAY_RELEASE_MANIFEST_UNSAFE");
    const x=JSON.parse(fs.readFileSync(file,"utf8")) as TrayReleaseState;
    if(x.version!==1||!/^[a-f0-9]{24}$/.test(x.revision)||
       (x.activeDigest!==null&&!DIGEST.test(x.activeDigest))||
       (x.previousDigest!==null&&!DIGEST.test(x.previousDigest))||
       !Number.isSafeInteger(x.updatedAt)||x.updatedAt<1)
      throw new Error("TRAY_RELEASE_MANIFEST_INVALID");
    // Fail closed on substituted slot content, not only on manifest syntax.
    for(const d of [x.activeDigest,x.previousDigest]){
      if(d&&fileSha256(releaseBinaryPath(d,root))!==d)
        throw new Error("TRAY_RELEASE_HASH_MISMATCH");
    }
    return x;
  }catch(e){
    if((e as NodeJS.ErrnoException).code==="ENOENT")
      return {version:1,revision:"000000000000000000000000",
        activeDigest:null,previousDigest:null,updatedAt:0};
    throw e;
  }
}
export function trustedTrayBuild(root=getPackageRootDir()):{path:string;digest:string;kind:"release"|"debug"} {
  const smoke=process.env.SUPERAGENT_TRAY_LIFECYCLE_TEST==="1"&&
    process.env.VITEST!==undefined;
  // The headless lifecycle smoke handler is compiled only in debug builds.
  // Never fall back to a release executable inside Vitest: --lifecycle-smoke
  // would be ignored and could spawn an unintended interactive Tray.
  const kinds:("release"|"debug")[]=smoke?["debug"]:["release"];
  for(const kind of kinds){
    const candidate=path.join(root,"apps","superagent-tray","src-tauri","target",kind,"superagent-tray.exe");
    if(!fs.existsSync(candidate))continue;
    if(fs.realpathSync.native(candidate)!==path.resolve(candidate))
      throw new Error("TRAY_RELEASE_UNTRUSTED_BUILD_PATH");
    return {path:candidate,digest:fileSha256(candidate),kind};
  }
  throw new Error("TRAY_RELEASE_TRUSTED_BUILD_MISSING: compile Tauri release before upgrade");
}
function writeManifest(next:TrayReleaseState,expectedRevision:string,root:string){
  const prior=readTrayReleaseState(root);
  if(prior.revision!==expectedRevision)
    throw new Error("TRAY_RELEASE_REVISION_CONFLICT");
  requirePrivateDirectory(root);
  const file=releaseManifestPath(root);
  const tmp=file+"."+crypto.randomBytes(7).toString("hex")+".tmp";
  try{
    const fd=fs.openSync(tmp,"wx",0o600);
    try{fs.writeFileSync(fd,JSON.stringify(next,null,2));fs.fsyncSync(fd);}
    finally{fs.closeSync(fd);}
    fs.renameSync(tmp,file);
  }finally{try{fs.rmSync(tmp,{force:true});}catch{}}
}
export function stageTrustedTrayRelease(source:string,expectedDigest:string,root=getRootConfigDir()){
  const trusted=trustedTrayBuild();
  if(path.resolve(source)!==path.resolve(trusted.path)||
     trusted.digest!==expectedDigest)
    throw new Error("TRAY_RELEASE_BUILD_CHANGED_SINCE_PLAN");
  requirePrivateDirectory(releasesRoot(root));
  const destination=releaseBinaryPath(expectedDigest,root);
  if(fs.existsSync(destination)){
    if(fileSha256(destination)!==expectedDigest)
      throw new Error("TRAY_RELEASE_SLOT_HASH_MISMATCH");
    return destination;
  }
  const tmp=destination+"."+crypto.randomBytes(6).toString("hex")+".tmp";
  try{
    fs.copyFileSync(source,tmp,fs.constants.COPYFILE_EXCL);
    if(fileSha256(tmp)!==expectedDigest)
      throw new Error("TRAY_RELEASE_COPY_VERIFY_FAILED");
    fs.renameSync(tmp,destination);
  }finally{try{fs.rmSync(tmp,{force:true});}catch{}}
  return destination;
}
/** Only an already-verified installed Tray binary can become fallback. */
export function stageInstalledTrayFallback(source:string,expectedDigest:string,
    root=getRootConfigDir()) {
  const file=fs.realpathSync.native(source);
  const allowed=[
    path.join(root,"bin","superagent-tray.exe"),
    path.join(getPackageRootDir(),"apps","superagent-tray","src-tauri","target","release","superagent-tray.exe"),
    path.join(getPackageRootDir(),"apps","superagent-tray","src-tauri","target","debug","superagent-tray.exe"),
  ].filter(x=>fs.existsSync(x)).map(x=>fs.realpathSync.native(x));
  if(!allowed.some(x=>process.platform==="win32"?
    x.toLowerCase()===file.toLowerCase():x===file)||
     fileSha256(file)!==expectedDigest)
    throw new Error("TRAY_RELEASE_FALLBACK_NOT_TRUSTED");
  requirePrivateDirectory(releasesRoot(root));
  const destination=releaseBinaryPath(expectedDigest,root);
  if(!fs.existsSync(destination)){
    const tmp=destination+"."+crypto.randomBytes(6).toString("hex")+".tmp";
    try{
      fs.copyFileSync(file,tmp,fs.constants.COPYFILE_EXCL);
      if(fileSha256(tmp)!==expectedDigest)
        throw new Error("TRAY_RELEASE_FALLBACK_COPY_MISMATCH");
      fs.renameSync(tmp,destination);
    }finally{try{fs.rmSync(tmp,{force:true});}catch{}}
  }
  if(fileSha256(destination)!==expectedDigest)
    throw new Error("TRAY_RELEASE_FALLBACK_INVALID");
  return destination;
}
function promoteTrayReleaseUnsafe(digest:string,expectedRevision:string,
    root=getRootConfigDir(),fallbackDigest?:string){
  if(!DIGEST.test(digest)||fileSha256(releaseBinaryPath(digest,root))!==digest)
    throw new Error("TRAY_RELEASE_TARGET_UNVERIFIED");
  const prior=readTrayReleaseState(root);
  const next:TrayReleaseState={version:1,
    revision:crypto.randomBytes(12).toString("hex"),updatedAt:Date.now(),
    activeDigest:digest,
    previousDigest:prior.activeDigest===digest?prior.previousDigest:
      (prior.activeDigest??(fallbackDigest&&fallbackDigest!==digest?fallbackDigest:null))};
  writeManifest(next,expectedRevision,root);
  return next;
}
/** Restore the previous pointer after failed launch. Immutable slot files stay. */
function restoreTrayReleaseStateUnsafe(previous:TrayReleaseState,
    expectedRevision:string,root=getRootConfigDir()){
  const current=readTrayReleaseState(root);
  if(current.revision!==expectedRevision)
    throw new Error("TRAY_RELEASE_CHANGED_DURING_RECOVERY");
  const target:TrayReleaseState={...previous,
    revision:crypto.randomBytes(12).toString("hex"),updatedAt:Date.now()};
  writeManifest(target,expectedRevision,root);
  return target;
}
export function switchTrayReleaseBack(expectedRevision:string,root=getRootConfigDir()){
  const prior=readTrayReleaseState(root);
  if(!prior.previousDigest)throw new Error("TRAY_RELEASE_NO_ROLLBACK_TARGET");
  return promoteTrayRelease(prior.previousDigest,expectedRevision,root);
}
export function getActiveReleaseBinary(root=getRootConfigDir()):string|null {
  const state=readTrayReleaseState(root);
  return state.activeDigest?releaseBinaryPath(state.activeDigest,root):null;
}

function withTrayReleaseGuard<T>(root:string,fn:()=>T):T {
  requirePrivateDirectory(root);
  const lock=releaseManifestPath(root)+".guard";
  let fd:number;
  try{fd=fs.openSync(lock,"wx",0o600);}
  catch{throw new Error("TRAY_RELEASE_CONCURRENT_OR_ORPHAN_LOCK");}
  try{return fn();}
  finally{
    fs.closeSync(fd);
    try{fs.rmSync(lock,{force:true});}catch{}
  }
}
export function promoteTrayRelease(digest:string,expectedRevision:string,
    root=getRootConfigDir(),fallbackDigest?:string){
  return withTrayReleaseGuard(root,()=>promoteTrayReleaseUnsafe(
    digest,expectedRevision,root,fallbackDigest));
}
export function restoreTrayReleaseState(previous:TrayReleaseState,
    expectedRevision:string,root=getRootConfigDir()){
  return withTrayReleaseGuard(root,()=>restoreTrayReleaseStateUnsafe(
    previous,expectedRevision,root));
}
