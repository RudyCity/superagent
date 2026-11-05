import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import { readProcessStartIdentity } from "../tools/cliBridgeProcessIdentity.js";

type LeaseRecord={
  version:1;
  tokenHash:string;
  pid:number;
  processIdentity:string;
  acquiredAt:number;
};

function tokenHash(token:string){
  return crypto.createHash("sha256").update(token).digest("hex").slice(0,24);
}
function leasePath(hash:string){
  return path.join(getRootConfigDir(),"telegram-poll-owner-"+hash+".json");
}
function readLease(file:string):LeaseRecord|null{
  try{
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096) throw new Error("TELEGRAM_POLL_LEASE_UNSAFE");
    const value=JSON.parse(fs.readFileSync(file,"utf8")) as LeaseRecord;
    if(value?.version!==1||!Number.isSafeInteger(value.pid)||value.pid<1||
       !/^[a-f0-9]{24}$/.test(value.tokenHash)||typeof value.processIdentity!=="string")
      throw new Error("TELEGRAM_POLL_LEASE_INVALID");
    return value;
  }catch(error){
    if((error as NodeJS.ErrnoException).code==="ENOENT") return null;
    throw error;
  }
}

export async function inspectTelegramPollingOwner(token:string){
  const hash=tokenHash(token),file=leasePath(hash),lease=readLease(file);
  if(!lease) return {active:false,tokenHash:hash};
  const identity=await readProcessStartIdentity(lease.pid).catch(()=>null);
  const active=Boolean(identity&&identity===lease.processIdentity);
  return {
    active,
    tokenHash:hash,
    pid:active?lease.pid:undefined,
    processIdentity:active?lease.processIdentity:undefined,
    stale:!active,
  };
}

export async function acquireTelegramPollingLease(token:string){
  if(!token) throw new Error("TELEGRAM_POLL_TOKEN_MISSING");
  const root=getRootConfigDir();
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const hash=tokenHash(token),file=leasePath(hash);
  const selfIdentity=await readProcessStartIdentity(process.pid);
  if(!selfIdentity) throw new Error("TELEGRAM_POLL_SELF_IDENTITY_UNAVAILABLE");

  const existing=readLease(file);
  if(existing){
    const liveIdentity=await readProcessStartIdentity(existing.pid).catch(()=>null);
    if(liveIdentity&&liveIdentity===existing.processIdentity){
      const error=new Error("TELEGRAM_POLL_OWNER_CONFLICT");
      (error as any).ownerPid=existing.pid;
      throw error;
    }
    try{fs.rmSync(file,{force:true})}catch{}
  }

  const record:LeaseRecord={
    version:1,tokenHash:hash,pid:process.pid,processIdentity:selfIdentity,acquiredAt:Date.now(),
  };
  try{
    fs.writeFileSync(file,JSON.stringify(record,null,2),{encoding:"utf8",mode:0o600,flag:"wx"});
  }catch{
    throw new Error("TELEGRAM_POLL_OWNER_RACE");
  }

  let released=false;
  return {
    tokenHash:hash,
    pid:process.pid,
    processIdentity:selfIdentity,
    async release(){
      if(released) return;
      released=true;
      const current=readLease(file);
      if(current&&current.pid===process.pid&&current.processIdentity===selfIdentity){
        try{fs.rmSync(file,{force:true})}catch{}
      }
    }
  };
}
