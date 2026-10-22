/**
 * Lazy, fail-closed Bridge -> Brain task reconciliation.
 * This is invoked explicitly by the owner on resume/status; it never presumes
 * the persisted "running" field proves a process is still alive.
 */
import { getDelegateJob } from "../tools/cliBridgeDelegateJobs.js";
import { inspectBrainTask, checkpointBrainTask, updateBrainTask } from "./brainTasks.js";
import { promoteBrainDelegationBatch } from "./brainDelegationArtifacts.js";

export async function reconcileBrainTask(owner:string,sessionId:string,taskId:string) {
  const task=inspectBrainTask(owner,sessionId,taskId);
  const last=task.delegationJobs?.at(-1);
  if(!last) return { taskId, updated:false, reason:"no-delegation", status:task.status };
  const job=await getDelegateJob(last.jobId);
  if(!job) return { taskId, updated:false, reason:"job-not-found-requires-review", status:task.status };
  if(task.status==="completed"||task.status==="cancelled") {
    return {taskId,updated:false,reason:"already-terminal",status:task.status,jobStatus:job.status};
  }
  if(task.assignedTo!==last.agentId) {
    return {taskId,updated:false,reason:"task-owner-changed-requires-review",status:task.status,jobStatus:job.status};
  }
  const running=["starting","running","cancelling"].includes(job.status);
  if(running) return {taskId,updated:false,reason:"job-not-terminal",status:task.status,jobStatus:job.status};
  if(job.status==="succeeded"&&job.completionState==="artifacts_verified") {
    try {
      const evidence=job.artifactEvidence;
      if(!Array.isArray(evidence)||!evidence.length||evidence.length>10)throw new Error("Invalid verified artifact manifest.");
      const promoted=await promoteBrainDelegationBatch(owner,sessionId,last.jobId);
      const paths=promoted.files.map(file=>file.filePath);
      if(task.status==="running") checkpointBrainTask(owner,sessionId,taskId,last.agentId,
        "Verified "+paths.length+" delegated artifact(s).","Review results before publishing.",paths);
      const updated=updateBrainTask(owner,sessionId,taskId,last.agentId,"completed");
      return {taskId,updated:true,status:updated.status,jobStatus:job.status,artifactPath:paths[0],artifactPaths:paths};
    } catch(error:any) {
      // Do not mark successful completion when promotion did not happen.
      if(task.status!=="blocked") updateBrainTask(owner,sessionId,taskId,last.agentId,"blocked");
      return {taskId,updated:true,status:"blocked",jobStatus:job.status,reason:"artifact-promotion-requires-review"};
    }
  }
  const next=job.status==="cancelled"?"cancelled":"blocked";
  if(task.status!==next) updateBrainTask(owner,sessionId,taskId,last.agentId,next);
  return {taskId,updated:true,status:next,jobStatus:job.status,reason:"delegation-needs-review"};
}
