import { describe, expect, it } from "vitest";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AssistantTaskStore } from "../src/core/assistant/assistantTaskStore.js";
import { recordExecutionStep, readExecutionCheckpoint } from "../src/core/assistant/assistantExecutionSteps.js";

const owner={ownerId:"session_step_owner",workspaceId:"workspace_step"};
async function fixture(fn:(root:string, task: Awaited<ReturnType<AssistantTaskStore["create"]>>)=>Promise<void>) {
  const root=await mkdtemp(path.join(os.tmpdir(),"assistant-observed-steps-"));
  try {
    const store=new AssistantTaskStore(root,owner);
    const task=await store.create({goalId:"goal_step",title:"Research private material",
      domain:"analysis",idempotencyKey:"task_step"});
    await fn(root,task);
  } finally {await rm(root,{recursive:true,force:true});}
}
describe("detached assistant execution step evidence",()=>{
  it("records only hashed IDs, approved tool names, order and outcomes; never raw arguments",async()=>fixture(async(root,task)=>{
    const start=await recordExecutionStep(task,{callId:"PRIVATE_PROVIDER_CAPABILITY_A",tool:"read",phase:"started"},root);
    const end=await recordExecutionStep(task,{callId:"PRIVATE_PROVIDER_CAPABILITY_A",tool:"read",phase:"finished"},root);
    expect(start.seq).toBe(1);expect(end.seq).toBe(2);
    expect(start.callRef).toMatch(/^[a-f0-9]{24}$/);
    expect(end.callRef).toBe(start.callRef);
    expect(end.outcome).toBe("completed");
    const again=await readExecutionCheckpoint(task,root);
    expect(again.incomplete).toBe(0);
    expect(again.manualReviewRequired).toBe(false);
    expect(again.executionResumptionSupported).toBe(false);
    const folder=path.join(root,"assistant-execution-steps");
    const content=await readFile(path.join(folder,(await readdir(folder))[0]),"utf8");
    expect(content).not.toContain("PRIVATE_PROVIDER_CAPABILITY_A");
    expect(content).not.toContain("Research private material");
    expect(JSON.parse(content).events).toHaveLength(2);
  }));
  it("fails closed for an incomplete started step after a simulated restart",async()=>fixture(async(root,task)=>{
    await recordExecutionStep(task,{callId:"unsettled",tool:"read",phase:"started"},root);
    const afterCrash=await readExecutionCheckpoint({...task},root);
    expect(afterCrash.incomplete).toBe(1);
    expect(afterCrash.manualReviewRequired).toBe(true);
    await expect(recordExecutionStep(task,{callId:"other",tool:"read",phase:"finished"},root))
      .rejects.toThrow("Unmatched");
    expect((await readExecutionCheckpoint(task,root)).steps).toHaveLength(1);
  }));
  it("never marks outside-network or unrecognized tool calls replay safe",async()=>fixture(async(root,baseTask)=>{
    const task={...baseTask,domain:"research" as const};
    await recordExecutionStep(task,{callId:"net",tool:"web_search",phase:"started"},root);
    await recordExecutionStep(task,{callId:"net",tool:"web_search",phase:"finished"},root);
    const seen=await readExecutionCheckpoint(task,root);
    expect(seen.externalUnverified).toBe(1);
    expect(seen.steps.at(-1)?.outcome).toBe("unverified");
    expect(seen.manualReviewRequired).toBe(true);
    await recordExecutionStep(task,{callId:"unapproved",tool:"shell_exec",phase:"started"},root);
    expect((await readExecutionCheckpoint(task,root)).steps.at(-1)?.tool).toBe("other");
    expect((await readExecutionCheckpoint(task,root)).manualReviewRequired).toBe(true);
  }));
  it("rejects repeated completion, duplicate start, invalid ID and corrupted evidence",async()=>fixture(async(root,task)=>{
    await expect(recordExecutionStep(task,{callId:"",tool:"read",phase:"started"},root))
      .rejects.toThrow("correlation");
    await recordExecutionStep(task,{callId:"c1",tool:"read",phase:"started"},root);
    await expect(recordExecutionStep(task,{callId:"c1",tool:"read",phase:"started"},root))
      .rejects.toThrow("Duplicate");
    await recordExecutionStep(task,{callId:"c1",tool:"read",phase:"finished",isError:true},root);
    expect((await readExecutionCheckpoint(task,root)).manualReviewRequired).toBe(true);
    await expect(recordExecutionStep(task,{callId:"c1",tool:"read",phase:"finished"},root))
      .rejects.toThrow("Unmatched");
    const folder=path.join(root,"assistant-execution-steps");
    const file=path.join(folder,(await readdir(folder))[0]);
    await writeFile(file,'{"schemaVersion":999,"events":[]}');
    await expect(readExecutionCheckpoint(task,root)).rejects.toThrow("corrupted");
    expect(await readFile(file,"utf8")).toContain("999");
    // Injected payload fields must never leave the journal through HTTP.
    await writeFile(file, JSON.stringify({
      schemaVersion:1,taskId:task.taskId,nextSeq:1,events:[],
      privatePrompt:"should-never-cross-HTTP",
    }));
    await expect(readExecutionCheckpoint(task,root)).rejects.toThrow("corrupted");
  }));
  it("isolates step history per task/workspace/owner",async()=>fixture(async(root,task)=>{
    await recordExecutionStep(task,{callId:"secret",tool:"read",phase:"started"},root);
    const changed={...task,workspaceId:"other_workspace"};
    expect((await readExecutionCheckpoint(changed,root)).steps).toEqual([]);
    const changedOwner={...task,ownerId:"other_owner"};
    expect((await readExecutionCheckpoint(changedOwner,root)).steps).toEqual([]);
    expect((await readExecutionCheckpoint(task,root)).steps).toHaveLength(1);
  }));
});
