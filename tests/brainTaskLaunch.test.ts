import {afterEach,describe,it,expect} from "vitest";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import {createBrainSession} from "../src/core/brain/brainWorkspace.js";
import {createBrainTask,claimBrainTask,recordBrainTaskDelegation,reserveBrainTaskLaunch,finishBrainTaskLaunch} from "../src/core/brain/brainTasks.js";
const dirs:string[]=[];
afterEach(()=>{delete process.env.SUPERAGENT_CONFIG_DIR;for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
describe("Brain task launch reservations",()=>{
 it("blocks second concurrent launch until an acknowledged delegation is recorded",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"brain-launch-reserve-"));dirs.push(root);
  process.env.SUPERAGENT_CONFIG_DIR=root;
  const owner="oauth:launch",sessionId="launch_session";
  createBrainSession(owner,sessionId);
  const task=createBrainTask(owner,sessionId,"One child",["agy"]);
  claimBrainTask(owner,sessionId,task.taskId,"agy");
  const first=reserveBrainTaskLaunch(owner,sessionId,task.taskId,"agy");
  expect(()=>reserveBrainTaskLaunch(owner,sessionId,task.taskId,"agy")).toThrow();
  const jobId="clj_1792658000000_abcdef12";
  recordBrainTaskDelegation(owner,sessionId,task.taskId,"agy","agy",jobId);
  expect(()=>finishBrainTaskLaunch(owner,sessionId,task.taskId,"agy","forged",jobId)).toThrow();
  expect(finishBrainTaskLaunch(owner,sessionId,task.taskId,"agy",first,jobId).launchFinalized).toBe(true);
  expect(()=>reserveBrainTaskLaunch(owner,sessionId,task.taskId,"agy")).toThrow(/already has a delegation/i);
 });
});
