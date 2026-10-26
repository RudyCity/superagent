/**
 * R2: OFFLINE, isolated-stage-only OAuth backup/restore rehearsal.
 * Not a production hot backup, keystore migration or legacy credential export.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {McpDurableOAuthStore} from "./mcpDurableOAuthStore.js";
import {readListenerOwners} from "../runtime/coreMcpOwnershipAudit.js";

type KeyMode="windows-dpapi"|"raw-test";
interface Manifest {
  version:1; issuer:string; keyMode:KeyMode;
  keySha256:string; stateSha256:string;
}
const sha=(b:Buffer)=>crypto.createHash("sha256").update(b).digest("hex");
function root():string {
  return fs.realpathSync(path.join(os.homedir(),".superagent-local-staging"));
}
function inside(rootPath:string,absolute:string):boolean {
  const rel=path.relative(rootPath,absolute);
  return rel!==""&&rel!==".."&&!rel.startsWith(".."+path.sep)&&!path.isAbsolute(rel);
}
function assertNotActivelyListening(issuer:string):void {
  const candidate=/^http:\/\/127\.0\.0\.1:(\d{4,5})$/.exec(issuer);
  if(!candidate)return; // Public TLS owner state must be attested externally.
  const owners=readListenerOwners();
  if(!owners)throw Error("Unable to verify offline OAuth staging listener");
  if(owners.has(Number(candidate[1])))
    throw Error("Staging OAuth listener is running; stop only your own test owner first");
}
function doesPathExist(file:string):boolean {
  try{fs.lstatSync(file);return true}
  catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return false;throw e}
}
function existingDir(dir:string):string {
  const p=path.resolve(dir),stageRoot=root();
  const real=fs.realpathSync(p);
  if(!inside(stageRoot,real)||!fs.lstatSync(p).isDirectory()||
     fs.lstatSync(p).isSymbolicLink())throw Error("OAuth backup requires isolated stage directory");
  return real;
}
function freshChild(dest:string):string {
  const absolute=path.resolve(dest);
  const parent=existingDir(path.dirname(absolute));
  if(!inside(root(),absolute)||path.dirname(absolute)!==parent||
     doesPathExist(absolute)||path.basename(absolute).startsWith("."))
    throw Error("OAuth backup destination must be a fresh isolated stage child");
  return absolute;
}
function verifiedFile(file:string,max:number):Buffer {
  const s=fs.lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size<1||s.size>max)
    throw Error("Unsafe OAuth backup source file");
  return fs.readFileSync(file);
}
function pairs(dir:string,keyMode:KeyMode) {
  if(fs.existsSync(path.join(dir,"oauth-state.json.writer-lock")))
    throw Error("OAuth state writer lock present; no offline backup");
  const foreign=keyMode==="windows-dpapi"?"oauth-state.key":"oauth-state.key.dpapi";
  if(fs.existsSync(path.join(dir,foreign)))throw Error("Mixed OAuth key modes");
  const name=keyMode==="windows-dpapi"?"oauth-state.key.dpapi":"oauth-state.key";
  return {
    name,key:verifiedFile(path.join(dir,name),32768),
    state:verifiedFile(path.join(dir,"oauth-state.json"),12_000_000),
  };
}
function writeNewFile(p:string,bytes:Buffer) {
  const fd=fs.openSync(p,"wx",0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
}
function writePair(stageDir:string,p:{name:string;key:Buffer;state:Buffer}) {
  writeNewFile(path.join(stageDir,p.name),p.key);
  writeNewFile(path.join(stageDir,"oauth-state.json"),p.state);
}
function keyOption(keyMode:KeyMode){return {keyMode};}
export function backupOfflineNewOAuthStageR2(input:{
  source:string;backupDestination:string;issuer:string;keyMode:KeyMode;
}):{version:1;status:"isolated_backup_created";files:3}{
  if(!["raw-test","windows-dpapi"].includes(input.keyMode))throw Error("Invalid key mode");
  const source=existingDir(input.source),destination=freshChild(input.backupDestination);
  assertNotActivelyListening(input.issuer);
  if(source===destination)throw Error("Source and backup must be distinct");
  // Verify integrity with the same store used by the issuer, never regenerate keys.
  new McpDurableOAuthStore(source,input.issuer,keyOption(input.keyMode));
  const p=pairs(source,input.keyMode);
  const verify=pairs(source,input.keyMode);
  if(!p.key.equals(verify.key)||!p.state.equals(verify.state))
    throw Error("OAuth state changed while reading; requires offline reconciliation");
  const manifest:Manifest={version:1,issuer:input.issuer,keyMode:input.keyMode,
    keySha256:sha(p.key),stateSha256:sha(p.state)};
  const temp=fs.mkdtempSync(path.join(path.dirname(destination),".oauth-backup-pending-"));
  try{
    writePair(temp,p);
    writeNewFile(path.join(temp,"manifest.json"),Buffer.from(JSON.stringify(manifest)));
    if(doesPathExist(destination))throw Error("Backup destination appeared during copy");
    fs.renameSync(temp,destination);
  }catch(e){fs.rmSync(temp,{recursive:true,force:true});throw e}
  return {version:1,status:"isolated_backup_created",files:3};
}
export function restoreOfflineNewOAuthStageR2(input:{
  backupSource:string;freshDestination:string;issuer:string;keyMode:KeyMode;
}):{version:1;status:"isolated_restore_verified";files:2}{
  if(!["raw-test","windows-dpapi"].includes(input.keyMode))throw Error("Invalid key mode");
  const source=existingDir(input.backupSource),destination=freshChild(input.freshDestination);
  const raw=verifiedFile(path.join(source,"manifest.json"),8192);
  let manifest:Manifest;
  try{manifest=JSON.parse(raw.toString("utf8"))}catch{throw Error("Invalid OAuth backup manifest")}
  if(manifest.version!==1||manifest.issuer!==input.issuer||
     manifest.keyMode!==input.keyMode||
     !/^[a-f0-9]{64}$/.test(manifest.keySha256)||
     !/^[a-f0-9]{64}$/.test(manifest.stateSha256))
    throw Error("OAuth backup issuer, format or key mode mismatch");
  const p=pairs(source,input.keyMode);
  if(sha(p.key)!==manifest.keySha256||sha(p.state)!==manifest.stateSha256)
    throw Error("OAuth backup checksum mismatch");
  // Verifies HMAC of state against unwrapped DPAPI/raw-test key and issuer.
  new McpDurableOAuthStore(source,input.issuer,keyOption(input.keyMode));
  const temp=fs.mkdtempSync(path.join(path.dirname(destination),".oauth-restore-pending-"));
  try{
    writePair(temp,p);
    new McpDurableOAuthStore(temp,input.issuer,keyOption(input.keyMode));
    if(doesPathExist(destination))throw Error("Restore destination appeared during copy");
    fs.renameSync(temp,destination);
  }catch(e){fs.rmSync(temp,{recursive:true,force:true});throw e}
  return {version:1,status:"isolated_restore_verified",files:2};
}
