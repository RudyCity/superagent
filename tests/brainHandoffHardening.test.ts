import {afterEach,describe,it,expect} from "vitest";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import {createBrainSession} from "../src/core/brain/brainWorkspace.js";
import {createBrainTask,claimBrainTask,handoffBrainArtifact,inspectBrainTask} from "../src/core/brain/brainTasks.js";
const roots:string[]=[];
afterEach(()=>{delete process.env.SUPERAGENT_CONFIG_DIR;for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function setup(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"brain-handoff-hardening-"));
 roots.push(root);process.env.SUPERAGENT_CONFIG_DIR=root;
 const owner="oauth:handoff",sessionId="test_handoff";
 const session=createBrainSession(owner,sessionId);
 const task=createBrainTask(owner,sessionId,"Handoff checked",["agy","claude"]);
 claimBrainTask(owner,sessionId,task.taskId,"agy");
 const artifact=path.join(session.artifactsPath,"proof.txt");fs.writeFileSync(artifact,"verified bytes");
 const inbox=path.join(session.scratchPath,"agents","claude",task.taskId,"inbox");
 return {owner,sessionId,session,task,artifact,inbox};
}
describe("Brain handoff storage and atomic metadata",()=>{
 it("rejects a handoff that exceeds 50 MiB session usage",()=>{
  const f=setup();
  const big=path.join(f.session.scratchPath,"large.bin");
  fs.closeSync(fs.openSync(big,"wx"));fs.truncateSync(big,50*1024*1024);
  expect(()=>handoffBrainArtifact(f.owner,f.sessionId,f.task.taskId,"agy","claude","artifacts/proof.txt")).toThrow(/quota/);
  expect(inspectBrainTask(f.owner,f.sessionId,f.task.taskId).handoffs).toHaveLength(0);
  expect(fs.existsSync(f.inbox)?fs.readdirSync(f.inbox):[]).toEqual([]);
 });
 it("never leaves an inbox copy behind after oversized metadata is rejected",()=>{
  const f=setup();
  const file=path.join(f.session.path,".tasks",f.task.taskId+".json");
  const task=JSON.parse(fs.readFileSync(file,"utf8"));
  task.padding="z".repeat(59500);
  fs.writeFileSync(file,JSON.stringify(task));
  expect(()=>handoffBrainArtifact(f.owner,f.sessionId,f.task.taskId,"agy","claude","artifacts/proof.txt")).toThrow(/metadata/);
  expect(fs.readdirSync(f.inbox)).toEqual([]);
 });
});
