import {afterEach,describe,it,expect} from "vitest";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import {createBrainSession} from "../src/core/brain/brainWorkspace.js";
import {createBrainTask,claimBrainTask,reserveBrainTaskLaunch,inspectBrainTask,updateBrainTask} from "../src/core/brain/brainTasks.js";
import {inspectBrainTaskLaunch,recoverBrainTaskLaunch} from "../src/core/brain/brainLaunchRecovery.js";
const roots:string[]=[];
afterEach(()=>{delete process.env.SUPERAGENT_CONFIG_DIR;for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"brain-phase7-"));roots.push(root);
 process.env.SUPERAGENT_CONFIG_DIR=root;
 const owner="oauth:phase7",sessionId="launch_recovery";
 const session=createBrainSession(owner,sessionId);
 const task=createBrainTask(owner,sessionId,"Evidence-bound recovery",["agy"]);
 claimBrainTask(owner,sessionId,task.taskId,"agy");
 const token=reserveBrainTaskLaunch(owner,sessionId,task.taskId,"agy");
 const jobId="clj_1792658000000_a1b2c3d4";
 const cwd=path.join(session.scratchPath,"agents","agy",task.taskId);
 const shard=path.join(root,"cli-bridge","delegations","jobs.d",jobId);
 fs.mkdirSync(shard,{recursive:true});
 function snapshot(key:string,candidateCwd=cwd,jobStatus="succeeded"){
  const name="1792658000000-0000000001-0123456789abcdef.json";
  fs.writeFileSync(path.join(shard,name),JSON.stringify({jobId,cwd:candidateCwd,status:jobStatus,
    idempotencyKey:key,cliAlias:"agy",updatedAt:Date.now(),completionState:"unverified"}));
 }
 return {root,owner,sessionId,session,task,token,jobId,cwd,shard,snapshot};
}
describe("Phase 7 Brain launch recovery",()=>{
 it("does not clear an unknown reservation and prevents premature completion",()=>{
  const f=fixture();
  expect(inspectBrainTaskLaunch(f.owner,f.sessionId,f.task.taskId).state).toBe("missing-evidence");
  expect(()=>recoverBrainTaskLaunch(f.owner,f.sessionId,f.task.taskId,f.jobId,true)).toThrow(/evidence/i);
  expect(()=>updateBrainTask(f.owner,f.sessionId,f.task.taskId,"agy","completed")).toThrow(/reservation/i);
  expect(inspectBrainTaskLaunch(f.owner,f.sessionId,f.task.taskId).state).toBe("missing-evidence");
 });
 it("attaches a uniquely evidenced job once without spawning a new process",()=>{
  const f=fixture();
  f.snapshot("brain:"+f.task.taskId+":"+f.token);
  const review=inspectBrainTaskLaunch(f.owner,f.sessionId,f.task.taskId);
  expect(review.state).toBe("verified-match");
  expect(review.matches).toHaveLength(1);
  expect(JSON.stringify(review)).not.toContain(f.token);
  expect(()=>recoverBrainTaskLaunch(f.owner,f.sessionId,f.task.taskId,f.jobId,false)).toThrow(/confirmation/);
  expect(()=>recoverBrainTaskLaunch(f.owner,f.sessionId,f.task.taskId,"clj_1792658000000_abcd1234",true)).toThrow();
  const recovered=recoverBrainTaskLaunch(f.owner,f.sessionId,f.task.taskId,f.jobId,true);
  expect(recovered).toMatchObject({recovered:true,retryDispatched:false});
  expect(inspectBrainTaskLaunch(f.owner,f.sessionId,f.task.taskId).state).toBe("clear");
  expect(inspectBrainTask(f.owner,f.sessionId,f.task.taskId).delegationJobs?.at(-1)?.jobId).toBe(f.jobId);
  const audit=fs.readFileSync(path.join(f.session.path,".tasks","launch-recovery-audit.jsonl"),"utf8");
  expect(audit).toContain(f.jobId);
  expect(audit).not.toContain(f.token);
 });
 it("rejects wrong keys and wrong working directories without releasing reservation",()=>{
  const f=fixture();
  f.snapshot("brain:"+f.task.taskId+":deadbeef");
  expect(inspectBrainTaskLaunch(f.owner,f.sessionId,f.task.taskId).state).toBe("missing-evidence");
  f.snapshot("brain:"+f.task.taskId+":"+f.token,f.session.scratchPath);
  expect(()=>inspectBrainTaskLaunch(f.owner,f.sessionId,f.task.taskId)).toThrow(/directory|escapes root/);
  expect(fs.existsSync(path.join(f.session.path,".tasks",f.task.taskId+".launch.json"))).toBe(true);
 });
});
