/** Atomic startup lease: only one Bun process may load the large ONNX
 * model before binding the local named pipe.
 *
 * The named pipe itself remains the permanent single-instance authority.
 * A dead, expired lease can be recovered but a live/uncertain lease is NEVER
 * stolen. No agent, tunnel, MCP process or unrelated PID is killed.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sharedRegistry } from "./senopatiSharedClient.js";

export type ModelStartLease = { path:string; release:()=>void };
export const MODEL_START_LEASE_STALE_MS = 10_000;

export function modelStartLeasePath():string {
  return sharedRegistry + ".startup.lock";
}
function isOwnerAlive(pid:number):boolean {
  try { process.kill(pid,0); return true; }
  catch(error:any) { return error?.code==="EPERM"; }
}
function reclaimProvablyDeadLease(file:string,now:number):boolean {
  // Never unlink an unknown, symlinked, hard-linked, or recently written
  // lock file; this must fail closed if ownership cannot be confirmed.
  const before=fs.lstatSync(file);
  if(!before.isFile() || before.isSymbolicLink() || before.nlink!==1 ||
     before.size<35 || before.size>1024) return false;
  const payload=JSON.parse(fs.readFileSync(file,"utf8"));
  if(payload?.version!==1 ||
     !Number.isSafeInteger(payload.pid) || payload.pid<1 ||
     !Number.isSafeInteger(payload.startedAt) ||
     !/^[a-f0-9]{32}$/.test(payload.nonce||"") ||
     now-payload.startedAt<MODEL_START_LEASE_STALE_MS ||
     now<payload.startedAt) return false;
  if(isOwnerAlive(payload.pid))return false;
  const after=fs.lstatSync(file);
  if(before.size!==after.size || before.mtimeMs!==after.mtimeMs ||
     before.ino!==after.ino || after.nlink!==1) return false;
  fs.unlinkSync(file);
  return true;
}
/** True while an owner may still be loading or draining mmBERT.
 * Invalid owner metadata blocks automatic replacement rather than risking
 * simultaneous heavyweight sessions. Inspect/remove unknown files manually.
 */
export function modelStartLeaseBlocksNewModel(
  options:{file?:string;now?:()=>number}={},
):boolean{
  const file=options.file??modelStartLeasePath();
  const now=options.now??Date.now;
  let stat;
  try{stat=fs.lstatSync(file);}
  catch(error:any){return error?.code!=="ENOENT";}
  if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 ||
     stat.size<35 || stat.size>1024)return true;
  try{
    const row=JSON.parse(fs.readFileSync(file,"utf8"));
    if(row?.version!==1 || !Number.isSafeInteger(row.pid) || row.pid<1 ||
       !Number.isSafeInteger(row.startedAt) ||
       !/^[a-f0-9]{32}$/.test(row.nonce||""))return true;
    const elapsed=now()-row.startedAt;
    if(elapsed<0 || elapsed<MODEL_START_LEASE_STALE_MS)return true;
    return isOwnerAlive(row.pid);
  }catch{return true;}
}

export function acquireSenopatiModelStartLease(
  options:{ file?:string; now?:()=>number }={},
):ModelStartLease {
  const file=options.file ?? modelStartLeasePath();
  const now=options.now??Date.now;
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const nonce=crypto.randomBytes(16).toString("hex");
  const body=JSON.stringify({
    version:1,pid:process.pid,startedAt:now(),nonce,
  });
  for(let attempt=0;attempt<2;attempt++){
    try {
      const fd=fs.openSync(file,"wx",0o600);
      try { fs.writeFileSync(fd,body,{encoding:"utf8"}); }
      finally { fs.closeSync(fd); }
      let released=false;
      return {path:file,release:()=>{
        if(released)return;
        released=true;
        try {
          const st=fs.lstatSync(file);
          if(!st.isFile() || st.isSymbolicLink() || st.nlink!==1) return;
          const owned=JSON.parse(fs.readFileSync(file,"utf8"));
          if(owned?.pid===process.pid && owned?.nonce===nonce) fs.unlinkSync(file);
        } catch { /* never remove a different owner's lease */ }
      }};
    }catch(error:any){
      if(error?.code!=="EEXIST")throw error;
      let reclaimed=false;
      try { reclaimed=reclaimProvablyDeadLease(file,now()); }
      catch { /* unreadable, concurrent, or corrupt lease fails closed */ }
      if(!reclaimed)throw new Error(
        "Senopati model startup is owned by another or unverified process");
    }
  }
  throw new Error("Senopati model startup lease could not be acquired");
}
