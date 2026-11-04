import {describe,it,expect,vi} from "vitest";
import {controlCoreLifecycle,corePort,coreAction} from "../src/core/runtime/coreLifecycleControl.js";
import {manageCoreTool} from "../src/core/tools/coreLifecycleTools.js";
import {masterToolset,superagentToolset,chromeExtensionToolset} from "../src/core/tools/toolsets.js";
import type {CoreRuntimeStatus} from "../src/core/runtime/coreSupervisor.js";

const before: CoreRuntimeStatus = {
  supervisorPid:101,publicPort:17888,active:{pid:201,port:30001,since:1},retained:[],
  affinitySessions:3,ownerContract:{version:1,role:"core-supervisor",mcpLifecycle:"not-owned",replayPolicy:"explicit-resume-only"},
};
const after: CoreRuntimeStatus = {...before,active:{pid:202,port:30002,since:2},retained:[before.active]};
describe("authenticated agent/MCP Core lifecycle control",()=>{
  it("requires valid action, port and explicit consent for mutating actions",async()=>{
    expect(()=>corePort("17888")).toThrow("INVALID_PORT");
    expect(()=>corePort(0)).toThrow("INVALID_PORT");
    expect(()=>coreAction("kill")).toThrow("INVALID_ACTION");
    const send=vi.fn();
    await expect(controlCoreLifecycle("restart",17888,false,send)).rejects.toThrow("CONFIRM_REQUIRED");
    expect(send).not.toHaveBeenCalled();
  });
  it("reads status with no mutation",async()=>{
    const send=vi.fn().mockResolvedValue(before);
    const res=await controlCoreLifecycle("status",17888,false,send);
    expect(res.changed).toBe(false);
    expect(res.activeWorkerPid).toBe(201);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("status",17888,2500);
  });
  it("verifies new PID, retained session worker, stable owner and public port",async()=>{
    const send=vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after).mockResolvedValueOnce(after);
    const res=await controlCoreLifecycle("restart",17888,true,send);
    expect(res.verified).toBe(true);
    expect(res.previousWorkerPid).toBe(201);
    expect(res.activeWorkerPid).toBe(202);
    expect(res.supervisorPid).toBe(101);
    expect(send.mock.calls.map(call=>call[0])).toEqual(["status","restart","status"]);
  });
  it("rejects no-op worker rolls, PID owner drift or session-owner loss",async()=>{
    const same=vi.fn().mockResolvedValue(before);
    await expect(controlCoreLifecycle("restart",17888,true,same)).rejects.toThrow("RESTART_NOT_VERIFIED");
    const drift=vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce({...after,supervisorPid:999});
    await expect(controlCoreLifecycle("restart",17888,true,drift)).rejects.toThrow("OWNER_CHANGED");
    const lost=vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce({...after,retained:[]}).mockResolvedValueOnce({...after,retained:[]});
    await expect(controlCoreLifecycle("restart",17888,true,lost)).rejects.toThrow("RESTART_NOT_VERIFIED");
  });
  it("rollback and guarded drain reuse the authenticated supervisor",async()=>{
    const rollback=vi.fn().mockResolvedValueOnce(after).mockResolvedValueOnce(before).mockResolvedValueOnce(before);
    expect((await controlCoreLifecycle("rollback",17888,true,rollback)).activeWorkerPid).toBe(201);
    const drain=vi.fn().mockResolvedValue(before);
    expect((await controlCoreLifecycle("drain",17888,true,drain)).changed).toBe(false);
  });
  it("exposes manage_core to master, superagent and extension agents",()=>{
    for(const toolset of [masterToolset,superagentToolset,chromeExtensionToolset])
      expect(toolset.some(t=>t.name==="manage_core")).toBe(true);
    expect(manageCoreTool.parameters).toHaveProperty("required",["action"]);
  });
  it("agent rejects unregistered supervisor rather than killing an unsupervised dev process",async()=>{
    const output=await manageCoreTool.execute({action:"restart",port:19997,confirm:true},process.cwd());
    expect(output).toMatch(/^Error:/);
    expect(output).toMatch(/No supervised core/);
  });
});
