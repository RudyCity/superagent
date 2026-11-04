/**
 * Durable bounded MCP backend reload receipts. An authenticated owner may
 * hot-reload its backend, never its Cloudflare ingress. Replayed operation IDs
 * return receipts, pending outcomes fail closed (even across crashes).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getRootConfigDir } from "../config/paths.js";
import { validateCoreOperationId } from "./coreLifecycleLedger.js";

type Receipt = {
  idHash:string; urlHash:string; ownerPid:number;
  state:"pending"|"completed"; backendPid?:number;
  startedAt:number; completedAt?:number;
};
type RecordFile={version:1;port:number;receipts:Receipt[]};
const digest=(s:string)=>crypto.createHash("sha256").update(s).digest("hex");
export class McpServiceReloadLedger {
  readonly file:string;
  private readonly lockFile:string;
  constructor(readonly port:number){
    if(!Number.isSafeInteger(port)||port<1024||port>65535)
      throw new Error("SERVICE_MCP_LEDGER_INVALID_PORT");
    this.file=path.join(getRootConfigDir(),"service-mcp-reload-"+port+".json");
    this.lockFile=this.file+".guard";
  }
  private read():RecordFile {
    try {
      const st=fs.lstatSync(this.file);
      if(!st.isFile()||st.isSymbolicLink()||st.size>100000)
        throw new Error("SERVICE_MCP_LEDGER_UNSAFE");
      const v=JSON.parse(fs.readFileSync(this.file,"utf8")) as RecordFile;
      if(v.version!==1||v.port!==this.port||!Array.isArray(v.receipts)||
         v.receipts.length>128||
         v.receipts.some(x=>!x||!/^[a-f0-9]{64}$/.test(x.idHash)||
           !/^[a-f0-9]{64}$/.test(x.urlHash)||
           !["pending","completed"].includes(x.state)||
           !Number.isSafeInteger(x.ownerPid)||x.ownerPid<=0||
           !Number.isSafeInteger(x.startedAt)||x.startedAt<1||
           (x.backendPid!==undefined&&(!Number.isSafeInteger(x.backendPid)||x.backendPid<=0)))||
         new Set(v.receipts.map(x=>x.idHash)).size!==v.receipts.length)
        throw new Error("SERVICE_MCP_LEDGER_CORRUPT");
      return v;
    } catch(e) {
      if((e as NodeJS.ErrnoException).code==="ENOENT")
        return {version:1,port:this.port,receipts:[]};
      throw e;
    }
  }
  private write(v:RecordFile) {
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
    const tmp=this.file+"."+crypto.randomBytes(8).toString("hex")+".tmp";
    try {
      const fd=fs.openSync(tmp,"wx",0o600);
      try {
        fs.writeFileSync(fd,JSON.stringify(v));fs.fsyncSync(fd);
      } finally {fs.closeSync(fd);}
      fs.renameSync(tmp,this.file);
    }finally{try{fs.rmSync(tmp,{force:true});}catch{}}
  }
  /** Exclusive short-lived filesystem mutex across multiple MCP owners. */
  private withGuard<T>(fn:()=>T):T {
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
    let fd:number;
    try {fd=fs.openSync(this.lockFile,"wx",0o600);}
    catch {throw new Error("SERVICE_MCP_OPERATION_IN_PROGRESS_OR_UNCERTAIN_LOCK");}
    try {
      fs.writeSync(fd,JSON.stringify({pid:process.pid,startedAt:Date.now()}));
      fs.fsyncSync(fd);
      return fn();
    } finally {
      fs.closeSync(fd);
      try{fs.unlinkSync(this.lockFile);}catch{}
    }
  }
  begin(input:{operationId:string;ownerPid:number;publicUrl:string}):
    {replayed:boolean;backendPid?:number} {
    validateCoreOperationId(input.operationId);
    if(!Number.isSafeInteger(input.ownerPid)||input.ownerPid<=0||
       !/^https:\/\/[^\s]+$/.test(input.publicUrl))
      throw new Error("SERVICE_MCP_INVALID_OPERATION");
    return this.withGuard(()=>{
      const all=this.read(),idHash=digest(input.operationId),urlHash=digest(input.publicUrl);
      const existing=all.receipts.find(x=>x.idHash===idHash);
      if(existing) {
        if(existing.ownerPid!==input.ownerPid||existing.urlHash!==urlHash)
          throw new Error("SERVICE_MCP_OPERATION_CONFLICT");
        if(existing.state==="pending")throw new Error("SERVICE_MCP_OPERATION_UNCERTAIN_PENDING");
        return {replayed:true,backendPid:existing.backendPid};
      }
      if(all.receipts.some(x=>x.state==="pending"))
        throw new Error("SERVICE_MCP_OPERATION_UNCERTAIN_PENDING");
      const newest=all.receipts.at(-1);
      if(newest?.completedAt&&Date.now()-newest.completedAt<5000)
        throw new Error("SERVICE_MCP_RELOAD_COOLDOWN");
      // Never discard a prior operation ID: eviction could permit replay.
      if(all.receipts.length>=128)throw new Error("SERVICE_MCP_LEDGER_FULL_OPERATOR_REVIEW");
      all.receipts.push({idHash,urlHash,ownerPid:input.ownerPid,
        state:"pending",startedAt:Date.now()});
      this.write(all);
      return {replayed:false};
    });
  }
  complete(id:string,backendPid:number) {
    validateCoreOperationId(id);
    if(!Number.isSafeInteger(backendPid)||backendPid<=0)
      throw new Error("SERVICE_MCP_INVALID_BACKEND_PID");
    this.withGuard(()=>{
      const all=this.read();
      const rec=all.receipts.find(x=>x.idHash===digest(id));
      if(!rec||rec.state!=="pending")
        throw new Error("SERVICE_MCP_LEDGER_UNEXPECTED_COMPLETION");
      rec.state="completed";rec.backendPid=backendPid;rec.completedAt=Date.now();
      this.write(all);
    });
  }
}
