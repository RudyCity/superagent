import {afterEach,describe,it,expect,vi} from "vitest";
import fs from "node:fs";import os from "node:os";import path from "node:path";
const get=vi.hoisted(()=>vi.fn());
vi.mock("../src/core/tools/cliBridgeDelegateJobs.js",()=>({getDelegateJob:get}));
import {createBrainSession} from "../src/core/brain/brainWorkspace.js";
import {createBrainTask,claimBrainTask,recordBrainTaskDelegation} from "../src/core/brain/brainTasks.js";
import {reconcileBrainSessionJobs} from "../src/core/brain/brainTaskRecovery.js";
const roots:string[]=[];
afterEach(()=>{get.mockReset();delete process.env.SUPERAGENT_CONFIG_DIR;for(const r of roots.splice(0))fs.rmSync(r,{recursive:true,force:true});});
describe("Brain bounded restart recovery",()=>{
 it("recovers active jobs only and does not start, cancel or retry delegations",async()=>{
   const root=fs.mkdtempSync(path.join(os.tmpdir(),"brain-job-recovery-"));roots.push(root);
   process.env.SUPERAGENT_CONFIG_DIR=root;
   const owner="oauth:recovery",sessionId="session_resume";
   createBrainSession(owner,sessionId);
   const job=createBrainTask(owner,sessionId,"Work in progress",["agy"]);
   claimBrainTask(owner,sessionId,job.taskId,"agy");
   recordBrainTaskDelegation(owner,sessionId,job.taskId,"agy","agy","clj_1792650000000_deadbeef");
   createBrainTask(owner,sessionId,"Pending unrelated",["claude"]);
   get.mockResolvedValue(null);
   const summary=await reconcileBrainSessionJobs(owner,sessionId,8);
   expect(summary.scanned).toBe(1);
   expect(summary.reconciled).toBe(0);
   expect(summary.needsReview).toBe(1);
   expect(summary.skipped).toBe(1);
   expect(get).toHaveBeenCalledTimes(1);
   await expect(reconcileBrainSessionJobs(owner,sessionId,17)).rejects.toThrow();
 });
});
