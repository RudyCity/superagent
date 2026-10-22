import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
const mockGetJob=vi.hoisted(()=>vi.fn());
vi.mock("../src/core/tools/cliBridgeDelegateJobs.js",()=>({getDelegateJob:mockGetJob}));
import { createBrainSession } from "../src/core/brain/brainWorkspace.js";
import { createBrainTask,claimBrainTask,recordBrainTaskDelegation,resumeBrainTask } from "../src/core/brain/brainTasks.js";
import { reconcileBrainTask } from "../src/core/brain/brainTaskReconciler.js";
const roots:string[]=[];
function fixture() {
 const config=fs.mkdtempSync(path.join(os.tmpdir(),"brain-reconcile-"));roots.push(config);
 process.env.SUPERAGENT_CONFIG_DIR=config;
 const owner="oauth:reconcile",sessionId="test_session";
 const session=createBrainSession(owner,sessionId);
 const task=createBrainTask(owner,sessionId,"Reconcile generated report",["agy"]);
 const {scratchPath}=claimBrainTask(owner,sessionId,task.taskId,"agy");
 const jobId="clj_1792638000000_abcd1234";
 recordBrainTaskDelegation(owner,sessionId,task.taskId,"agy","agy",jobId);
 return {config,session,owner,sessionId,task,scratchPath,jobId};
}
afterEach(()=>{mockGetJob.mockReset();delete process.env.SUPERAGENT_CONFIG_DIR;for(const r of roots.splice(0))fs.rmSync(r,{force:true,recursive:true})});
describe("Brain CLI Bridge task lifecycle reconciliation",()=>{
 it("automatically promotes verified nested artifact, checkpoints result and marks complete",async()=>{
  const {owner,sessionId,session,task,scratchPath,jobId}=fixture();
  const bytes=Buffer.from("bridge-proof");
  fs.writeFileSync(path.join(scratchPath,"result.txt"),bytes);
  mockGetJob.mockResolvedValue({jobId,cwd:scratchPath,status:"succeeded",completionState:"artifacts_verified",
    artifactEvidence:[{path:"result.txt",state:"created",bytes:bytes.length,sha256:crypto.createHash("sha256").update(bytes).digest("hex")}]});
  const completed=await reconcileBrainTask(owner,sessionId,task.taskId);
  expect(completed.status).toBe("completed");
  expect(completed.artifactPath).toBe("artifacts/result.txt");
  expect(fs.readFileSync(path.join(session.artifactsPath,"result.txt"))).toEqual(bytes);
  const resumed=resumeBrainTask(owner,sessionId,task.taskId);
  expect(resumed.checkpoint?.artifactPaths).toContain("artifacts/result.txt");
  expect((await reconcileBrainTask(owner,sessionId,task.taskId)).updated).toBe(false);
 });
 it("discovers and promotes multiple verified outputs from task-local scratch",async()=>{
  const {owner,sessionId,task,scratchPath,jobId,session}=fixture();
  const files=["first.txt","second.csv"];
  for(const name of files)fs.writeFileSync(path.join(scratchPath,name),"proof "+name);
  mockGetJob.mockResolvedValue({jobId,cwd:scratchPath,status:"succeeded",completionState:"artifacts_verified",
    artifactEvidence:files.map(name=>({path:name,state:"created",bytes:Buffer.byteLength("proof "+name),
      sha256:crypto.createHash("sha256").update("proof "+name).digest("hex")}))});
  const completed=await reconcileBrainTask(owner,sessionId,task.taskId);
  expect(completed.status).toBe("completed");
  expect(completed.artifactPaths).toHaveLength(2);
  for(const artifact of completed.artifactPaths||[])expect(fs.existsSync(path.join(session.path,artifact))).toBe(true);
  expect(resumeBrainTask(owner,sessionId,task.taskId).checkpoint?.artifactPaths).toHaveLength(2);
 });
 it("blocks unsuccessful jobs and never promotes unverified output",async()=>{
  const {owner,sessionId,task,scratchPath,jobId,session}=fixture();
  fs.writeFileSync(path.join(scratchPath,"output.txt"),"unverified");
  mockGetJob.mockResolvedValue({jobId,cwd:scratchPath,status:"failed",completionState:"failed",artifactEvidence:[]});
  const state=await reconcileBrainTask(owner,sessionId,task.taskId);
  expect(state.status).toBe("blocked");
  expect(fs.readdirSync(session.artifactsPath)).toEqual([]);
 });
 it("never claims a live persisted CLI status is complete",async()=>{
  const {owner,sessionId,task,scratchPath,jobId}=fixture();
  mockGetJob.mockResolvedValue({jobId,cwd:scratchPath,status:"running",completionState:"pending"});
  expect((await reconcileBrainTask(owner,sessionId,task.taskId)).updated).toBe(false);
  mockGetJob.mockResolvedValue(null);
  expect((await reconcileBrainTask(owner,sessionId,task.taskId)).reason).toMatch(/review/);
 });
});
