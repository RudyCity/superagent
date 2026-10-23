/**
 * Bounded Brain recovery when an owner session is reopened.
 * Never dispatches or retries a CLI job. Only reconciles persisted evidence,
 * verifies artifacts, and marks uncertain work for operator review.
 */
import { listBrainTasks } from "./brainTasks.js";
import { inspectBrainSession } from "./brainWorkspace.js";
import { withBrainSessionLock } from "./brainSessionLock.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { recoverBrainArtifactPromotion } from "./brainArtifactTransaction.js";
import { reconcileBrainTask } from "./brainTaskReconciler.js";

const inflight=new Map<string,Promise<RecoverySummary>>();
const lastRun=new Map<string,number>();
const COOLDOWN_MS=30000;
export type RecoverySummary = {
  sessionId:string; scanned:number; reconciled:number; active:number;
  needsReview:number; skipped:number; recoveredTransaction:string;
  partial:boolean; nextCursor:string|null;
};
export async function reconcileBrainSessionJobs(owner:string,sessionId:string,limit=8):Promise<RecoverySummary>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>16)throw new Error("Invalid bounded Brain recovery size.");
  const key=owner+"\n"+sessionId;
  const prior=inflight.get(key);if(prior)return prior;
  const run=(async()=>{
    const transaction=recoverBrainArtifactPromotion(owner,sessionId);
    const tasks=listBrainTasks(owner,sessionId);
    const candidates=tasks.filter(t=>t.status==="running"&&!!t.delegationJobs?.length)
      .sort((a,b)=>a.taskId.localeCompare(b.taskId));
    const dir=inspectBrainSession(owner,sessionId).path;
    const cursorFile=path.join(dir,".tasks","recovery-cursor.json");
    let cursor="";
    try {
      const stat=fs.lstatSync(cursorFile);
      if(!stat.isFile()||stat.nlink!==1||stat.size>300)throw new Error("Invalid Brain recovery cursor.");
      const stored=JSON.parse(fs.readFileSync(cursorFile,"utf8"));
      if(typeof stored.taskId==="string"&&/^task_[a-f0-9]{20}$/.test(stored.taskId))cursor=stored.taskId;
    }catch(error:any){if(error?.code!=="ENOENT")throw error;}
    const start=candidates.findIndex(t=>t.taskId>cursor);
    const ordered=start<0?candidates:[...candidates.slice(start),...candidates.slice(0,start)];
    const page=ordered.slice(0,limit);
    const result:RecoverySummary={sessionId,scanned:0,reconciled:0,active:0,needsReview:0,
      skipped:tasks.length-candidates.length,recoveredTransaction:transaction.status,
      partial:candidates.length>page.length,nextCursor:null};
    for(const task of page){
      result.scanned++;
      try{
        const state=await reconcileBrainTask(owner,sessionId,task.taskId);
        if(state.updated)result.reconciled++;
        else if(state.reason==="job-not-terminal")result.active++;
        else if(state.reason?.includes("review"))result.needsReview++;
      }catch{result.needsReview++;}
    }
    if(page.length) {
      const lastId=page[page.length-1].taskId;
      withBrainSessionLock(dir,()=>{
        fs.mkdirSync(path.dirname(cursorFile),{recursive:true,mode:0o700});
        const temp=cursorFile+"."+crypto.randomBytes(6).toString("hex")+".tmp";
        try {fs.writeFileSync(temp,JSON.stringify({taskId:lastId,updatedAt:Date.now()}),{flag:"wx",mode:0o600});fs.renameSync(temp,cursorFile);}
        finally {if(fs.existsSync(temp))fs.unlinkSync(temp);}
      });
      result.nextCursor=result.partial?lastId:null;
    }
    return result;
  })();
  inflight.set(key,run);
  try{return await run;}finally{inflight.delete(key);}
}
export function recoverBrainSessionOnResume(owner:string,sessionId:string){
  const key=owner+"\n"+sessionId,now=Date.now();
  if(now-(lastRun.get(key)??0)<COOLDOWN_MS)return;
  lastRun.set(key,now);
  void reconcileBrainSessionJobs(owner,sessionId).catch(()=>{ /* Operational recovery must never interrupt chat startup. */ });
}
