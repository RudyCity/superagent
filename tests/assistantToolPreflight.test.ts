import { describe, expect, it, vi } from "vitest";
import { agentLocalStorage } from "../src/core/agentLocalStorage.js";
import { executeToolCall } from "../src/core/permissions.js";
import { setDetachedToolPreflight } from "../src/core/assistant/assistantToolPreflight.js";

describe("detached tool pre-execution checkpoint barrier", () => {
  it("commits preflight before any tool adapter is invoked", async () => {
    const timeline:string[]=[];
    const tool = {
      name:"read",execute:vi.fn(async () => {
        timeline.push("adapter");
        return "safe";
      }),
    };
    const agent={
      tier:"single", delegationDepth:0,
      getActiveTools:async()=>[tool],
    };
    const clear=setDetachedToolPreflight(agent,async call=>{
      expect(call).toEqual({id:"call_authorized_1",name:"read"});
      timeline.push("durable-preflight");
    });
    try {
      const result=await agentLocalStorage.run(agent as any, async()=>
        executeToolCall({id:"call_authorized_1",name:"read",args:{filePaths:[]}},
          process.cwd(),undefined,[tool]));
      expect(result.isError).not.toBe(true);
      expect(timeline.indexOf("durable-preflight")).toBeLessThan(timeline.indexOf("adapter"));
      expect(tool.execute).toHaveBeenCalledOnce();
    } finally {clear();}
  });
  it("blocks adapter invocation if disk preflight fails closed", async () => {
    const adapter=vi.fn(async()=> "must-never-run");
    const tool={name:"read",execute:adapter};
    const agent={tier:"single",delegationDepth:0,getActiveTools:async()=>[tool]};
    const clear=setDetachedToolPreflight(agent,async()=>{
      throw Error("Simulated crash before journal flush");
    });
    try {
      const result=await agentLocalStorage.run(agent as any,async()=>
        executeToolCall({id:"call_failed_1",name:"read",args:{filePaths:[]}},
          process.cwd(),undefined,[tool]));
      expect(result.isError).toBe(true);
      expect(adapter).not.toHaveBeenCalled();
    } finally {clear();}
  });
  it("does not install process-wide gates or alter ordinary agents", async () => {
    const adapter=vi.fn(async()=>"safe");
    const tool={name:"read",execute:adapter};
    const agent={tier:"single",delegationDepth:0,getActiveTools:async()=>[tool]};
    const result=await agentLocalStorage.run(agent as any,async()=>
      executeToolCall({id:"call_generic_1",name:"read",args:{filePaths:[]}},
        process.cwd(),undefined,[tool]));
    expect(result.isError).not.toBe(true);
    expect(adapter).toHaveBeenCalledOnce();
  });
});
