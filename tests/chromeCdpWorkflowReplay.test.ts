import {beforeEach,describe,test,expect} from "vitest";
import {
  startRecordedWorkflow,getRecordedWorkflow,activeRecordedWorkflowId,
  assertNextWorkflowStep,consumeNextWorkflowStep,skipManualWorkflowStep,
  clearRecordedWorkflowTestState,
} from "../src/core/tools/chromeCdpWorkflowReplay.js";
import type {SafeActionRecord} from "../src/core/tools/chromeCdpActionRecorder.js";

const sha="a".repeat(64);
const events: SafeActionRecord[] = [
  {sequence:1,action:"move_cursor",status:"dispatched",at:100,position:{x:20,y:30}},
  {sequence:2,action:"click",status:"dispatched",at:150,locatorDigest:sha,pageDigest:sha},
  {sequence:3,action:"type",status:"dispatched",at:200},
  {sequence:4,action:"scroll_cursor",status:"dispatched",at:250},
];
describe("strict one-step replay workflow",()=>{
  beforeEach(clearRecordedWorkflowTestState);
  test("requires in-order cursor and approved-click consumption; manual actions cannot be automated",()=>{
    const flow=startRecordedWorkflow("tab","owner","gen","recording",events);
    const id=flow.workflowId;
    expect(flow.totalCount).toBe(4);
    expect(flow.steps.map(x=>x.mode)).toEqual(["cursor","approval","manual","manual"]);
    expect(activeRecordedWorkflowId("tab","owner","gen")).toBe(id);
    expect(()=>consumeNextWorkflowStep("tab","owner","gen",id,2,"approval"))
      .toThrow(/out of order/);
    expect(consumeNextWorkflowStep("tab","owner","gen",id,1,"cursor").next?.sequence).toBe(2);
    expect(()=>consumeNextWorkflowStep("tab","owner","gen",id,1,"cursor"))
      .toThrow(/out of order/);
    expect(assertNextWorkflowStep("tab","owner","gen",id,2,"approval").action).toBe("click");
    const step3=consumeNextWorkflowStep("tab","owner","gen",id,2,"approval");
    expect(step3.next?.action).toBe("type");
    expect(()=>skipManualWorkflowStep("tab","owner","gen",id,3,false)).toThrow(/confirmation/);
    expect(skipManualWorkflowStep("tab","owner","gen",id,3,true).next?.sequence).toBe(4);
    expect(skipManualWorkflowStep("tab","owner","gen",id,4,true).done).toBe(true);
    expect(activeRecordedWorkflowId("tab","owner","gen")).toBeNull();
    expect(getRecordedWorkflow("tab","owner","gen",id).steps.map(x=>x.status))
      .toEqual(["consumed","consumed","skipped","skipped"]);
  });
  test("never trusts a different actor, generation, ID or stale workflow",()=>{
    const flow=startRecordedWorkflow("tab","owner","generation-1","recording",events);
    for(const changed of [
      ["tab","attacker","generation-1",flow.workflowId],
      ["tab","owner","generation-2",flow.workflowId],
      ["other-tab","owner","generation-1",flow.workflowId],
      ["tab","owner","generation-1","fake-id"],
    ]) {
      expect(()=>getRecordedWorkflow(changed[0],changed[1],changed[2],changed[3]))
        .toThrow(/unavailable/);
    }
    const replacement=startRecordedWorkflow("tab","owner","generation-1","new-recording",events);
    expect(replacement.workflowId).not.toBe(flow.workflowId);
    expect(()=>getRecordedWorkflow("tab","owner","generation-1",flow.workflowId))
      .toThrow(/unavailable/);
  });
  test("rejects malformed, oversized or non-monotonic action logs",()=>{
    expect(()=>startRecordedWorkflow("tab","owner","gen","id",[])).toThrow(/stopped/);
    expect(()=>startRecordedWorkflow("tab","owner","gen","id",Array(129).fill(events[0])))
      .toThrow(/stopped/);
    expect(()=>startRecordedWorkflow("tab","owner","gen","id",
      [{...events[0],sequence:4}])).toThrow(/monotonic/);
  });
});
