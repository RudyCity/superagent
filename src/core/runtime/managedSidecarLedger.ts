/**
 * Persistent operation receipts for independently owned local hosts.
 * Never replay a pending mutation or claim an unknown result as success.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import {getRootConfigDir} from "../config/paths.js";
import {validateCoreOperationId} from "./coreLifecycleLedger.js";

type State = "pending"|"completed"|"reviewed";
type Receipt = {
  operationHash:string; fingerprint:string;state:State;
  startedAt:number;completedAt?:number; afterPid?:number;
};
type File={version:1;service:string;port:number;receipts:Receipt[]};
const hash=(text:string)=>crypto.createHash("sha256").update(text).digest("hex");
export class ManagedSidecarLedger {
  readonly file:string;
  readonly lock:string;
  constructor(readonly service:"transport"|"channel_host"|"rest_tunnel"|"muse_tunnel"|"vision"|"guardian"|"daemon"|"tray",readonly port:number){
    if(!Number.isSafeInteger(port)||port<1024||port>65535)
      throw new Error("SIDECAR_LEDGER_INVALID_PORT");
    this.file=path.join(getRootConfigDir(),`service-owner-${service}-${port}.json`);
    this.lock=this.file+".lock";
  }
  private read():File {
    try{
      const st=fs.lstatSync(this.file);
      if(!st.isFile()||st.isSymbolicLink()||st.size>55000)
        throw new Error("SIDECAR_LEDGER_UNSAFE");
      const value=JSON.parse(fs.readFileSync(this.file,"utf8")) as File;
      if(value.version!==1||value.service!==this.service||value.port!==this.port||
         !Array.isArray(value.receipts)||value.receipts.length>64||
         new Set(value.receipts.map(x=>x.operationHash)).size!==value.receipts.length||
         value.receipts.some(x=>!x||!/^[a-f0-9]{64}$/.test(x.operationHash)||
           !/^[a-f0-9]{64}$/.test(x.fingerprint)||
           !["pending","completed","reviewed"].includes(x.state)||
           !Number.isSafeInteger(x.startedAt)||x.startedAt<=0||
           (x.afterPid!==undefined&&(!Number.isSafeInteger(x.afterPid)||x.afterPid<0))))
        throw new Error("SIDECAR_LEDGER_CORRUPT");
      return value;
    }catch(e){
      if((e as NodeJS.ErrnoException).code==="ENOENT")
        return {version:1,service:this.service,port:this.port,receipts:[]};
      throw e;
    }
  }
  private mutate<T>(task:(state:File)=>T):T {
    const dir=path.dirname(this.file);
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    if(fs.lstatSync(dir).isSymbolicLink())throw new Error("SIDECAR_LEDGER_UNSAFE_DIRECTORY");
    let fd:number;
    try{fd=fs.openSync(this.lock,"wx",0o600);}
    catch{throw new Error("SIDECAR_OPERATION_IN_PROGRESS_OR_ORPHAN_LOCK");}
    try{
      const state=this.read();
      const result=task(state);
      const tmp=this.file+"."+crypto.randomBytes(8).toString("hex")+".tmp";
      try{
        const data=fs.openSync(tmp,"wx",0o600);
        try{fs.writeFileSync(data,JSON.stringify(state));fs.fsyncSync(data);}
        finally{fs.closeSync(data);}
        fs.renameSync(tmp,this.file);
      }finally{try{fs.rmSync(tmp,{force:true});}catch{}}
      return result;
    }finally{fs.closeSync(fd);try{fs.rmSync(this.lock,{force:true});}catch{}}
  }
  /** Redacted operation receipts, used to reconcile uncertain outcomes. */
  inspect():Array<{hashPrefix:string;state:State;startedAt:number;completedAt?:number}> {
    return this.read().receipts.map(x=>({
      hashPrefix:x.operationHash.slice(0,16),state:x.state,
      startedAt:x.startedAt,completedAt:x.completedAt,
    }));
  }
  /**
   * Mark an ambiguous operation as manually reviewed, NEVER completed.
   * The caller must authenticate the expected service as ABSENT and obtain
   * explicit operator acknowledgement; this method never stops a process.
   */
  reconcile(id:string,ownerAbsent:boolean,confirmed:boolean){
    validateCoreOperationId(id);
    if(!ownerAbsent||confirmed!==true)
      throw new Error("SIDECAR_RECONCILE_REQUIRES_OWNER_ABSENCE_AND_APPROVAL");
    return this.mutate(state=>{
      const rec=state.receipts.find(x=>x.operationHash===hash(id));
      if(rec?.state==="reviewed")
        return {operationHashPrefix:rec.operationHash.slice(0,16),
          state:"reviewed" as const,executedAgain:false,
          note:"Previously reconciled; no process operation performed."};
      if(!rec||rec.state!=="pending")
        throw new Error("SIDECAR_NO_PENDING_OPERATION");
      if(Date.now()-rec.startedAt<120000)
        throw new Error("SIDECAR_RECONCILE_COOLDOWN_120_SECONDS");
      rec.state="reviewed";rec.completedAt=Date.now();
      return {operationHashPrefix:rec.operationHash.slice(0,16),
        state:"reviewed" as const,executedAgain:false,
        note:"Unknown outcome reviewed; no process started/stopped. Original operation ID is never replayable."};
    });
  }
  /** Read-only preflight: no ledger is created for unauthorized/mismatched owners. */
  lookup(id:string,fingerprint:string):{replayed:boolean;afterPid?:number}|null {
    validateCoreOperationId(id);
    if(!/^[a-f0-9]{64}$/.test(fingerprint))throw new Error("SIDECAR_INVALID_FINGERPRINT");
    const state=this.read(),found=state.receipts.find(x=>x.operationHash===hash(id));
    if(!found)return null;
    if(found.fingerprint!==fingerprint)throw new Error("SIDECAR_OPERATION_ID_CONFLICT");
    if(found.state==="pending")throw new Error("SIDECAR_OPERATION_UNCERTAIN_PENDING");
    if(found.state==="reviewed")throw new Error("SIDECAR_OPERATION_REVIEWED_NOT_REPLAYABLE");
    return {replayed:true,afterPid:found.afterPid};
  }
  begin(id:string,fingerprint:string):{replayed:boolean;afterPid?:number}{
    validateCoreOperationId(id);
    if(!/^[a-f0-9]{64}$/.test(fingerprint))throw new Error("SIDECAR_INVALID_FINGERPRINT");
    return this.mutate(state=>{
      const operationHash=hash(id),existing=state.receipts.find(x=>x.operationHash===operationHash);
      if(existing){
        if(existing.fingerprint!==fingerprint)throw new Error("SIDECAR_OPERATION_ID_CONFLICT");
        if(existing.state==="pending")throw new Error("SIDECAR_OPERATION_UNCERTAIN_PENDING");
        if(existing.state==="reviewed")throw new Error("SIDECAR_OPERATION_REVIEWED_NOT_REPLAYABLE");
        return {replayed:true,afterPid:existing.afterPid};
      }
      if(state.receipts.some(x=>x.state==="pending"))
        throw new Error("SIDECAR_OPERATION_UNCERTAIN_PENDING");
      const previous=state.receipts.at(-1);
      if(previous?.completedAt&&Date.now()-previous.completedAt<1000)
        throw new Error("SIDECAR_OPERATION_COOLDOWN");
      if(state.receipts.length>=64)throw new Error("SIDECAR_LEDGER_FULL_OPERATOR_REVIEW");
      state.receipts.push({operationHash,fingerprint,state:"pending",startedAt:Date.now()});
      return {replayed:false};
    });
  }
  complete(id:string,pid:number){
    validateCoreOperationId(id);
    if(!Number.isSafeInteger(pid)||pid<0)throw new Error("SIDECAR_INVALID_PID");
    this.mutate(state=>{
      const x=state.receipts.find(r=>r.operationHash===hash(id));
      if(!x||x.state!=="pending")throw new Error("SIDECAR_LEDGER_UNEXPECTED_COMPLETION");
      x.state="completed";x.afterPid=pid;x.completedAt=Date.now();
    });
  }
}
export function sidecarOperationFingerprint(data:unknown) {
  return hash(JSON.stringify(data));
}
