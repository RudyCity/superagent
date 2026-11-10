/**
 * Two-party approval for a SINGLE recorded browser click. The agent may
 * prepare, but ONLY the authenticated local native operator can approve.
 * No selectors, URLs, typed values, browser contents or tokens are persisted.
 * Execution is one-shot and must run under withCdpTargetWrite with revision
 * and live target revalidation; consumed-before-dispatch is fail-closed.
 */
import {createHash,randomUUID} from "node:crypto";
import {readFile,readdir,mkdir,writeFile,rename,rm} from "node:fs/promises";
import {join} from "node:path";
import {cdpGatewayRoot,listCdpSessions,withCdpTargetCoordination} from "./chromeCdpSessionManager.js";

type Decision="pending"|"approved"|"denied"|"consumed";
type Approval = {
 id:string; port:number; targetId:string; actorId:string;
 generation:string; recordingId:string; sequence:number;
 selectorHash:string; urlHash:string; revision:number;
 createdAt:number; expiresAt:number; status:Decision;
};
const MAX=48, TTL=120000;
const root=()=>join(cdpGatewayRoot(),"replay-approvals");
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
const filename=(id:string)=>join(root(),id+".json");
const validId=(id:unknown)=>typeof id==="string"&&/^[0-9a-f-]{36}$/.test(id);
const validActor=(actor:unknown)=>typeof actor==="string" &&
  /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,95}$/.test(actor);
const validTarget=(target:unknown)=>typeof target==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(target);
const validSelector=(selector:unknown)=>typeof selector==="string"&&
  selector.length>0&&selector.length<=500&&!/[\u0000-\u001f\u007f]/.test(selector);
const publicFields=(a:Approval)=>({
  approvalId:a.id, port:a.port,targetId:a.targetId,actorId:a.actorId,
  action:"click" as const,recordingId:a.recordingId,sequence:a.sequence,
  revision:a.revision,createdAt:a.createdAt,expiresAt:a.expiresAt,status:a.status,
  // Never disclose a CSS selector or URL. An operator must inspect the live tab.
  warning:"One-time browser click. Review the exact visible managed tab before approving.",
});
async function read(id:string):Promise<Approval|null>{
 if(!validId(id))throw Error("Invalid approval identifier.");
 try {
   const raw=await readFile(filename(id),"utf8");
   if(raw.length>2300)throw Error("Invalid approval metadata.");
   const obj=JSON.parse(raw) as Approval;
   if(obj.id!==id||!validTarget(obj.targetId)||!validActor(obj.actorId)||
      !Number.isInteger(obj.port)||obj.port<1024||obj.port>65535||
      !validId(obj.generation)||!validId(obj.recordingId)||
      !Number.isSafeInteger(obj.sequence)||obj.sequence<1||
      !/^[a-f0-9]{64}$/.test(obj.selectorHash)||!/^[a-f0-9]{64}$/.test(obj.urlHash)||
      !Number.isSafeInteger(obj.revision)||obj.revision<0||
      !Number.isSafeInteger(obj.expiresAt)||!["pending","approved","denied","consumed"].includes(obj.status))
     throw Error("Invalid approval metadata.");
   return obj;
 }catch(e:any){if(e?.code==="ENOENT")return null;throw Error("Replay approval state unavailable; denied.");}
}
async function save(a:Approval):Promise<void>{
 await mkdir(root(),{recursive:true,mode:0o700});
 const temp=filename(a.id)+"."+randomUUID()+".tmp";
 try{await writeFile(temp,JSON.stringify(a),{flag:"wx",mode:0o600});await rename(temp,filename(a.id));}
 finally{await rm(temp,{force:true}).catch(()=>{});}
}
async function current(a:Approval){
 const session=(await listCdpSessions()).find(s=>s.port===a.port&&s.targetId===a.targetId);
 if(!session||session.generation!==a.generation||session.revision!==a.revision||
     session.paused===true||!session.participants.some(p=>p.agentId===a.actorId))
   throw Error("Replay target lease/revision changed; approval denied.");
 if(a.expiresAt<=Date.now())throw Error("Replay approval expired.");
}
export async function prepareReplayClick(input:{
 port:number;targetId:string;actorId:string;generation:string;recordingId:string;
 sequence:number;selector:string;targetUrl:string;revision:number;
}){
 if(!Number.isInteger(input.port)||input.port<1024||input.port>65535||
   !validTarget(input.targetId)||!validActor(input.actorId)||
   !validId(input.generation)||!validId(input.recordingId)||
   !Number.isSafeInteger(input.sequence)||input.sequence<1||
   !validSelector(input.selector)||typeof input.targetUrl!=="string"||
   !input.targetUrl||input.targetUrl.length>4096||
   !Number.isSafeInteger(input.revision)||input.revision<0)throw Error("Invalid replay proposal.");
 const existing=await readdir(root()).catch((error:any)=>{
   if(error?.code==="ENOENT")return [] as string[];throw error;
 });
 if(existing.filter(x=>x.endsWith(".json")).length>=MAX)
   throw Error("Replay approval capacity reached.");
 const now=Date.now();
 const a:Approval={id:randomUUID(),port:input.port,targetId:input.targetId,
   actorId:input.actorId,generation:input.generation,recordingId:input.recordingId,
   sequence:input.sequence,selectorHash:digest(input.selector),urlHash:digest(input.targetUrl),
   revision:input.revision,createdAt:now,expiresAt:now+TTL,status:"pending"};
 await current(a);
 await save(a);
 return publicFields(a);
}
export async function listPendingReplayApprovals(){
 const ids=(await readdir(root()).catch((e:any)=>{
   if(e?.code==="ENOENT")return [] as string[];throw e;
 })).filter(x=>/^[0-9a-f-]{36}.json$/.test(x)).slice(0,MAX);
 const active:ReturnType<typeof publicFields>[]=[];
 for(const file of ids){
   let a:Approval|null=null;
   try{a=await read(file.slice(0,-5));if(!a||a.status!=="pending")continue;await current(a);}
   catch{continue;}
   active.push(publicFields(a));
 }
 return active.sort((a,b)=>a.createdAt-b.createdAt).slice(0,24);
}
/** LOCAL OPERATOR ONLY; caller route must verify native bearer, loopback and no Origin. */
export async function reviewReplayApproval(id:string,decision:"approve"|"deny"){
 if(decision!=="approve"&&decision!=="deny")throw Error("Invalid operator approval decision.");
 const initial=await read(id);
 if(!initial)throw Error("Replay approval unavailable.");
 // Serialize the operator's decision with the same exclusive CDP target gate as
 // the agent execution. Re-read under the lock to stop concurrent approvals.
 return withCdpTargetCoordination(initial.port,initial.targetId,async()=>{
   const a=await read(id);
   if(!a||a.status!=="pending")throw Error("Replay approval already resolved or unavailable.");
   await current(a);
   const next:Approval={...a,status:decision==="approve"?"approved":"denied"};
   await save(next);
   return publicFields(next);
 });
}
/** Invalidate every pending/approved replay when the native human-control
 * authority changes. Caller must own the existing target coordination lock. */
export async function revokeReplayApprovalsForTarget(port:number,targetId:string):Promise<number>{
 const files=(await readdir(root()).catch((e:any)=>{
   if(e?.code==="ENOENT")return [] as string[];throw e;
 })).filter(name=>/^[0-9a-f-]{36}\.json$/.test(name));
 let count=0;
 for(const filename of files){
   const a=await read(filename.slice(0,-5));
   if(!a||a.port!==port||a.targetId!==targetId||
      (a.status!=="pending"&&a.status!=="approved"))continue;
   await save({...a,status:"denied"});
   count++;
 }
 return count;
}

/** Must be invoked INSIDE the existing exclusive CDP target write lock. */
export async function consumeApprovedReplayClick(input:{
 approvalId:string;port:number;targetId:string;actorId:string;generation:string;
 recordingId:string;sequence:number;revision:number;selector:string;targetUrl:string;
}){
 const a=await read(input.approvalId);
 if(!a||a.status!=="approved")throw Error("Explicit local operator approval required or already consumed.");
 if(a.port!==input.port||a.targetId!==input.targetId||a.actorId!==input.actorId||
    a.generation!==input.generation||a.recordingId!==input.recordingId||
    a.sequence!==input.sequence||a.revision!==input.revision||
    !validSelector(input.selector)||digest(input.selector)!==a.selectorHash||
    typeof input.targetUrl!=="string"||digest(input.targetUrl)!==a.urlHash)
   throw Error("Replay context changed; operator approval does not match.");
 await current(a);
 // Persist consumed BEFORE issuing an irreversible CDP input. If CDP fails, do NOT retry.
 await save({...a,status:"consumed"});
 return {approvalId:a.id,consumed:true};
}
