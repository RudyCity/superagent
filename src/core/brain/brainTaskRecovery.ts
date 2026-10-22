/**
 * Bounded Brain recovery when an owner session is reopened.
 * Never dispatches or retries a CLI job. Only reconciles persisted evidence,
 * verifies artifacts, and marks uncertain work for operator review.
 */
import { listBrainTasks } from "./brainTasks.js";
import { recoverBrainArtifactPromotion } from "./brainArtifactTransaction.js";
import { reconcileBrainTask } from "./brainTaskReconciler.js";

const inflight=new Map<string,Promise<RecoverySummary>>();
const lastRun=new Map<string,number>();
const COOLDOWN_MS=30000;
export type RecoverySummary = {
  sessionId:string; scanned:number; reconciled:number; active:number;
  needsReview:number; skipped:number; recoveredTransaction:string;
};
export async function reconcileBrainSessionJobs(owner:string,sessionId:string,limit=8):Promise<RecoverySummary>{
  if(!Number.isSafeInteger(limit)||limit<1||limit>16)throw new Error("Invalid bounded Brain recovery size.");
  const key=owner+"\n"+sessionId;
  const prior=inflight.get(key);if(prior)return prior;
  const run=(async()=>{
    const transaction=recoverBrainArtifactPromotion(owner,sessionId);
    const tasks=listBrainTasks(owner,sessionId);
    const result:RecoverySummary={sessionId,scanned:0,reconciled:0,active:0,needsReview:0,skipped:0,
      recoveredTransaction:transaction.status};
    for(const task of tasks){
      if(result.scanned>=limit)break;
      if(task.status!=="running"||!(task.delegationJobs?.length)){result.skipped++;continue;}
      result.scanned++;
      try{
        const state=await reconcileBrainTask(owner,sessionId,task.taskId);
        if(state.updated)result.reconciled++;
        else if(state.reason==="job-not-terminal")result.active++;
        else if(state.reason?.includes("review"))result.needsReview++;
      }catch{result.needsReview++;}
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
