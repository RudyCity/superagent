import {describe,it,expect,vi} from "vitest";
import {controlCoreLifecycle,prepareCoreLifecycle,corePort,coreAction} from "../src/core/runtime/coreLifecycleControl.js";
import {manageCoreTool} from "../src/core/tools/coreLifecycleTools.js";
import {masterToolset,superagentToolset,chromeExtensionToolset} from "../src/core/tools/toolsets.js";
import type {CoreRuntimeStatus} from "../src/core/runtime/coreSupervisor.js";

const digest = "a".repeat(64), previousDigest = "b".repeat(64);
const before: CoreRuntimeStatus = {
  supervisorPid:101,publicPort:17888,
  active:{pid:201,port:30001,since:1,buildDigest:previousDigest,buildMode:"source"},retained:[],
  currentBuild:{mode:"source",digest,sourceDigest:digest,fileCount:4,fresh:true},
  affinitySessions:3,ownerContract:{version:1,role:"core-supervisor",mcpLifecycle:"not-owned",replayPolicy:"explicit-resume-only"},
};
const after: CoreRuntimeStatus = {...before,active:{pid:202,port:30002,since:2,buildDigest:digest,buildMode:"source"},retained:[before.active]};
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
  it("prepares a non-mutating build plan with stable owner and version",async()=>{
    const send=vi.fn().mockResolvedValue(before);
    const plan=await prepareCoreLifecycle("restart",17888,send);
    expect(plan.expectedBuildDigest).toBe(digest);
    expect(plan.codeChangedSinceActiveWorker).toBe(true);
    expect(plan.operationId.length).toBeGreaterThanOrEqual(16);
    expect(send).toHaveBeenCalledWith("status",17888,2500);
  });
  it("refuses stale source or expected fingerprint mismatch before mutation",async()=>{
    const stale={...before,currentBuild:{...before.currentBuild!,fresh:false}};
    const send=vi.fn().mockResolvedValue(stale);
    await expect(controlCoreLifecycle("restart",17888,true,send)).rejects.toThrow("CORE_BUILD_UNVERIFIED");
    const requested=vi.fn().mockResolvedValue(before);
    await expect(controlCoreLifecycle("restart",17888,true,requested,{
      operationId:"core-test-unique-001",expectedBuildDigest:"f".repeat(64),
    })).rejects.toThrow("CORE_BUILD_CHANGED_SINCE_PLAN");
  });
  it("binds a fresh plan to the exact old supervisor and worker PID",async()=>{
    const send=vi.fn().mockResolvedValue(before);
    await expect(controlCoreLifecycle("restart",17888,true,send,{
      operationId:"core-guarded-operation-001",expectedBuildDigest:digest,
      expectedSupervisorPid:101,expectedWorkerPid:999,
    })).rejects.toThrow("CORE_CONTROL_OWNER_CHANGED_SINCE_PLAN");
    expect(send.mock.calls.map(c=>c[0])).toEqual(["status"]);
    const planned=await prepareCoreLifecycle("restart",17888,vi.fn().mockResolvedValue(before));
    expect(planned).toMatchObject({expectedSupervisorPid:101,expectedWorkerPid:201});
  });
  it("returns completed-operation replay without triggering a new generation",async()=>{
    const replay={...after,operation:{operationHashPrefix:"f".repeat(16),
      replayed:true,action:"restart" as const}};
    const send=vi.fn().mockResolvedValueOnce(after).mockResolvedValueOnce(replay).mockResolvedValueOnce(after);
    const response=await controlCoreLifecycle("restart",17888,true,send,{
      operationId:"core-test-retry-001",expectedBuildDigest:digest,
    });
    expect(response.replayed).toBe(true);
    expect(response.changed).toBe(false);
    expect(response.activeWorkerPid).toBe(202);
  });
  it("exposes manage_core to master, superagent and extension agents",()=>{
    for(const toolset of [masterToolset,superagentToolset,chromeExtensionToolset])
      expect(toolset.some(t=>t.name==="manage_core")).toBe(true);
    expect(manageCoreTool.parameters).toHaveProperty("required",["action"]);
  });
  it("agent rejects unregistered supervisor rather than killing an unsupervised dev process",async()=>{
    const output=await manageCoreTool.execute({action:"plan",targetAction:"restart",port:19997},process.cwd());
    expect(output).toMatch(/^Error:/);
    expect(output).toMatch(/No supervised core/);
  });
});
