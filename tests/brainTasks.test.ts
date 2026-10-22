import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
vi.mock("../src/core/tools/cliBridgeTool.js", () => ({
 cliBridgeTool: { execute: vi.fn(async ()=> "Started background CLI delegation: clj_1792654000000_deadbeef") },
}));
import { dispatchBrainMcpTool } from "../src/core/mcp/tools/brainMcpTools.js";
import { createBrainSession } from "../src/core/brain/brainWorkspace.js";
import {
 createBrainTask,listBrainTasks,inspectBrainTask,claimBrainTask,transferBrainTask,
 checkpointBrainTask,handoffBrainArtifact,resumeBrainTask,updateBrainTask
} from "../src/core/brain/brainTasks.js";
const roots:string[]=[];
function init() {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"brain-multi-agent-"));roots.push(dir);
 process.env.SUPERAGENT_CONFIG_DIR=dir;return dir;
}
afterEach(()=>{delete process.env.SUPERAGENT_CONFIG_DIR;for(const r of roots.splice(0)) fs.rmSync(r,{force:true,recursive:true});});
const call=async(principal:string,action:string,more:Record<string,unknown>={})=>{
 const answer=await dispatchBrainMcpTool("superagent_brain",{action,sessionId:"session_alpha",...more},principal);
 if(answer?.isError)return {error:answer.content[0].text};
 try{return JSON.parse(answer!.content[0].text);}
 catch{return answer!.content[0].text;}
};
describe("Brain task coordination and MCP security",()=>{
 it("creates exclusive task ownership, checkpoints and durable restart/resume",()=>{
  init();const session=createBrainSession("owner:one","session_alpha");
  const task=createBrainTask("owner:one","session_alpha","Review generated results",["agy","claude"]);
  expect(listBrainTasks("owner:one","session_alpha")).toHaveLength(1);
  const {scratchPath}=claimBrainTask("owner:one","session_alpha",task.taskId,"agy");
  expect(scratchPath.startsWith(session.scratchPath)).toBe(true);
  expect(fs.existsSync(scratchPath)).toBe(true);
  expect(()=>claimBrainTask("owner:one","session_alpha",task.taskId,"claude")).toThrow(/claimed/);
  const artifact=path.join(session.artifactsPath,"report.txt");
  fs.writeFileSync(artifact,"verified report");
  const checkpoint=checkpointBrainTask("owner:one","session_alpha",task.taskId,"agy",
    "Research completed","Claude review report",["artifacts/report.txt"]);
  expect(checkpoint.checkpoint.version).toBe(1);
  expect(()=>checkpointBrainTask("owner:one","session_alpha",task.taskId,"claude","fake","")).toThrow(/assigned/);
  const handed=handoffBrainArtifact("owner:one","session_alpha",task.taskId,"agy","claude","artifacts/report.txt");
  expect(handed.record.sha256).toBe(crypto.createHash("sha256").update("verified report").digest("hex"));
  expect(fs.readFileSync(path.join(session.path,handed.record.inbox),"utf8")).toBe("verified report");
  expect(()=>handoffBrainArtifact("owner:one","session_alpha",task.taskId,"claude","agy","artifacts/report.txt")).toThrow(/owner/);
  const transferred=transferBrainTask("owner:one","session_alpha",task.taskId,"agy","claude");
  expect(transferred.task.assignedTo).toBe("claude");
  const next=checkpointBrainTask("owner:one","session_alpha",task.taskId,"claude","Validated result","Mark complete",[]);
  expect(next.checkpoint.version).toBe(2);
  expect(resumeBrainTask("owner:one","session_alpha",task.taskId).checkpoint?.agentId).toBe("claude");
  expect(inspectBrainTask("owner:one","session_alpha",task.taskId).checkpoints).toHaveLength(2);
  updateBrainTask("owner:one","session_alpha",task.taskId,"claude","completed");
  expect(()=>claimBrainTask("owner:one","session_alpha",task.taskId,"agy")).toThrow(/completed/);
 });
 it("isolates task state by authenticated principal and rejects path traversal",async()=>{
  init();createBrainSession("owner:a","session_alpha");createBrainSession("owner:b","session_alpha");
  const t=await call("owner:a","task.create",{title:"Build docs",agentIds:["agy","claude"]});
  expect(t.taskId).toMatch(/^task_/);
  expect((await call("owner:b","task.get",{taskId:t.taskId})).error).toBeTruthy();
  expect(JSON.stringify(await call("owner:a","task.get",{taskId:t.taskId}))).not.toContain(t.credentials.agy);
  expect(await call("owner:b","task.list")).toEqual([]);
  expect((await call("owner:a","task.claim",{taskId:t.taskId,agentId:"../escape"})).error).toBeTruthy();
  expect((await call("owner:a","task.claim",{taskId:t.taskId,agentId:"agy"})).error).toMatch(/capability/i);
  expect((await call("owner:a","task.claim",{taskId:t.taskId,agentId:"agy",agentCredential:t.credentials.claude})).error).toMatch(/mismatch/i);
  const result=await call("owner:a","task.claim",{taskId:t.taskId,agentId:"agy",agentCredential:t.credentials.agy});
  expect(result.task.assignedTo).toBe("agy");
  expect((await call("owner:a","task.delegate.start",{taskId:t.taskId,agentId:"claude",agentCredential:t.credentials.claude,cli:"agy",prompt:"run"})).error).toMatch(/claimed/);
  const delegated=await call("owner:a","task.delegate.start",{taskId:t.taskId,agentId:"agy",agentCredential:t.credentials.agy,cli:"agy",prompt:"Create a draft"});
  expect(JSON.stringify(delegated)).toContain("clj_");
  const persisted=await call("owner:a","task.resume",{taskId:t.taskId});
  expect(persisted.delegationJobs).toHaveLength(1);
  expect(persisted.delegationJobs[0].agentId).toBe("agy");
  const invalid=await call("owner:a","task.handoff",{taskId:t.taskId,agentId:"agy",agentCredential:t.credentials.agy,toAgent:"claude",filePath:"artifacts/../secret.txt"});
  expect(invalid.error).toBeTruthy();
  const automatic=await call("owner:a","task.autostart",{cli:"claude",prompt:"Analyze customer issue"});
  expect(automatic.taskId).toMatch(/^task_/);
  const resumed=await call("owner:a","task.resume",{taskId:automatic.taskId});
  expect(automatic.agentCredential).toMatch(/^bag_[a-f0-9]{64}$/);
  expect(resumed.assignedTo).toBe("claude");
  expect(resumed.delegationJobs[0].jobId).toMatch(/^clj_/);
 });
 it("keeps collaboration inside one owner's namespace without granting cross-principal OAuth access",()=>{
  init();createBrainSession("oauth:first","session_alpha");createBrainSession("oauth:second","session_alpha");
  const task=createBrainTask("oauth:first","session_alpha","Isolated data",["worker"]);
  expect(()=>inspectBrainTask("oauth:second","session_alpha",task.taskId)).toThrow();
  expect(()=>claimBrainTask("oauth:second","session_alpha",task.taskId,"worker")).toThrow();
  expect(()=>createBrainTask("oauth:first","session_alpha","bad member",[".."])).toThrow(/Invalid/);
 });
});
