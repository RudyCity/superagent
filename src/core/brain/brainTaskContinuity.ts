/** Bounded, project-scoped task checkpoint references for prompt continuity.
 * These snippets are user/agent content and are NOT system instructions.
 */
import { listBrainSessions } from "./brainWorkspace.js";
import { listBrainTasks } from "./brainTasks.js";
import { verifyBrainProject } from "./brainProvenance.js";

export function brainTaskContinuity(owner:string,sessionId:string,currentWorkspace:string, maxItems=5) {
  const results:Array<{sessionId:string;taskId:string;status:string;summary:string;nextStep:string;agentId:string}>=[];
  const sessions=listBrainSessions(owner).slice(0,50);
  let expectedProject:string|undefined;
  try { expectedProject=verifyBrainProject(owner,sessionId,currentWorkspace).rmemoryProjectId; }
  catch { return results; } // Detached/non-project Brain never crosses sessions.
  for(const s of sessions) {
    if(results.length>=maxItems)break;
    try {
      const provenance=verifyBrainProject(owner,s.sessionId,currentWorkspace);
      if(provenance.rmemoryProjectId!==expectedProject)continue;
      const tasks=listBrainTasks(owner,s.sessionId).slice(0,25);
      for(const task of tasks) {
        const checkpoint=task.checkpoints.at(-1);
        if(!checkpoint)continue;
        results.push({sessionId:s.sessionId,taskId:task.taskId,status:task.status,
          summary:checkpoint.note.slice(0,220),nextStep:checkpoint.nextStep.slice(0,140),
          agentId:checkpoint.agentId});
        if(results.length>=maxItems)break;
      }
    } catch { /* no cross-project or corrupt metadata access */ }
  }
  return results.slice(0,maxItems);
}
