/** A private, bounded, metadata-only lifecycle audit timeline. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {getRootConfigDir} from "../config/paths.js";
import {MANAGED_SERVICE_NAMES,type ManagedServiceName} from "./serviceManagerTypes.js";

export type LifecycleEvent={
  at:number;service:ManagedServiceName;action:string;
  outcome:"planned"|"succeeded"|"replayed"|"blocked"|"uncertain"|"reconciled"|"observed";
  operationHashPrefix?:string;port?:number;ownerPid?:number;
  durationMs?:number;buildDigestPrefix?:string;errorCode?:string;
};
const known=new Set<string>(MANAGED_SERVICE_NAMES);
const safeText=/^[a-zA-Z0-9_:.\-]{1,64}$/;
export const timelineFile=(root=getRootConfigDir())=>path.join(root,"lifecycle-events.jsonl");
export function operationHashPrefix(id:string){
  return crypto.createHash("sha256").update(id).digest("hex").slice(0,16);
}
export function validateLifecycleEvent(item:LifecycleEvent){
  if(!item||!known.has(item.service)||!Number.isSafeInteger(item.at)||
     item.at<1||!safeText.test(item.action)||
     !["planned","succeeded","replayed","blocked","uncertain","reconciled","observed"].includes(item.outcome)||
     (item.operationHashPrefix!==undefined&&!/^[a-f0-9]{16}$/.test(item.operationHashPrefix))||
     (item.buildDigestPrefix!==undefined&&!/^[a-f0-9]{12,16}$/.test(item.buildDigestPrefix))||
     (item.errorCode!==undefined&&!safeText.test(item.errorCode))||
     (item.ownerPid!==undefined&&(!Number.isSafeInteger(item.ownerPid)||item.ownerPid<0))||
     (item.port!==undefined&&(!Number.isSafeInteger(item.port)||item.port<1024||item.port>65535))||
     (item.durationMs!==undefined&&(!Number.isFinite(item.durationMs)||item.durationMs<0||item.durationMs>3600000)))
    throw new Error("LIFECYCLE_EVENT_INVALID_METADATA");
}
export function recordLifecycleEvent(item:LifecycleEvent,root=getRootConfigDir()){
  validateLifecycleEvent(item);
  const file=timelineFile(root),dir=path.dirname(file);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if(fs.lstatSync(dir).isSymbolicLink())throw new Error("LIFECYCLE_EVENT_DIRECTORY_UNSAFE");
  const lock=file+".guard";
  let fd:number;
  try{fd=fs.openSync(lock,"wx",0o600);}
  catch{throw new Error("LIFECYCLE_EVENT_WRITER_BUSY_OR_STALE");}
  try{
    let previous=false;
    try{
      const stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink())throw new Error("LIFECYCLE_EVENT_FILE_UNSAFE");
      previous=stat.size>512*1024;
    }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    if(previous){
      const older=file+".1";
      if(fs.existsSync(older))fs.rmSync(older,{force:true});
      fs.renameSync(file,older);
    }
    const out=fs.openSync(file,"a",0o600);
    try{
      fs.writeSync(out,JSON.stringify(item)+"\n");
      fs.fsyncSync(out);
    }finally{fs.closeSync(out);}
  }finally{fs.closeSync(fd);try{fs.rmSync(lock,{force:true});}catch{}}
}
export function readLifecycleEvents(options:{
  service?:ManagedServiceName;limit?:number;
}={},root=getRootConfigDir()):LifecycleEvent[]{
  const limit=options.limit??50;
  if(!Number.isSafeInteger(limit)||limit<1||limit>200)
    throw new Error("LIFECYCLE_EVENT_LIMIT_INVALID");
  if(options.service&&!known.has(options.service))
    throw new Error("LIFECYCLE_EVENT_SERVICE_INVALID");
  const paths=[timelineFile(root)+".1",timelineFile(root)];
  const entries:LifecycleEvent[]=[];
  for(const file of paths){
    let data:string;
    try{
      const stat=fs.lstatSync(file);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>600000)
        throw new Error("LIFECYCLE_EVENT_LOG_UNSAFE");
      data=fs.readFileSync(file,"utf8");
    }catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")continue;throw e;}
    for(const line of data.split("\n")){
      if(!line)continue;
      const item=JSON.parse(line) as LifecycleEvent;
      validateLifecycleEvent(item);
      if(!options.service||item.service===options.service)entries.push(item);
    }
  }
  return entries.slice(-limit).reverse();
}
