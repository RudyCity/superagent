import {describe,it,expect} from "vitest";
import {assessMcpCoreStart,validateMcpCoreStart} from "../src/core/runtime/coreMcpBootstrap.js";
import {manageServices} from "../src/core/runtime/serviceManager.js";

describe("MCP independent Core cold bootstrap policy",()=>{
  it("wires the unified service manager to Core cold-start planning",async()=>{
    try{
      const plan=await manageServices({action:"plan",service:"core",targetAction:"start",port:19486}) as any;
      expect(plan).toMatchObject({service:"core",action:"start",port:19486,
        expectedOwnerPid:0,expectedInstanceId:"absent"});
      expect(plan.operationId).toMatch(/^[a-f0-9-]{36}$/);
    }catch(e){
      // A test host without a fully attested kernel inventory/build must fail
      // closed, but must not silently fall back to the unsupported operation.
      expect((e as Error).message).toMatch(/^(CORE_START_|CORE_BUILD_)/);
    }
  },30000);
  const clean={ownerOnline:false,listenerObserved:false,listenerInventoryVerified:true,decision:"fresh_guard_allowed" as const};
  it("permits only audited safe cold-start or worker recovery",()=>{
    expect(assessMcpCoreStart(clean)).toBe("ready");
    expect(assessMcpCoreStart({...clean,decision:"recover_verified_survivors"})).toBe("ready");
    expect(assessMcpCoreStart({...clean,decision:"cold_reset_allowed"})).toBe("ready");
    for(const decision of ["operator_review","blocked","already_running"] as const)
      expect(assessMcpCoreStart({...clean,decision})).not.toBe("ready");
  });
  it("refuses foreign listeners and unverified kernel ownership",()=>{
    expect(assessMcpCoreStart({...clean,listenerObserved:true})).toBe("CORE_START_FOREIGN_LISTENER");
    expect(assessMcpCoreStart({...clean,listenerInventoryVerified:false})).toBe("CORE_START_LISTENER_INVENTORY_UNAVAILABLE");
    expect(assessMcpCoreStart({...clean,ownerOnline:true})).toBe("CORE_START_ALREADY_RUNNING");
  });
  it("rejects unbound or forged start confirmations",()=>{
    const base={action:"start" as const,service:"core" as const,port:7888,confirm:true,
      operationId:"3e40d372-2ca2-40a1-8939-f96c3eebbd83",
      expectedOwnerPid:0,expectedInstanceId:"absent",
      expectedBuildDigest:"a".repeat(64),clientMode:"tline" as const};
    expect(validateMcpCoreStart(base)).toEqual(base);
    expect(()=>validateMcpCoreStart({...base,confirm:false})).toThrow("CORE_START_CONFIRM_REQUIRED");
    expect(()=>validateMcpCoreStart({...base,expectedOwnerPid:2431})).toThrow("CORE_START_UNEXPECTED_OWNER");
    expect(()=>validateMcpCoreStart({...base,expectedInstanceId:"hijack"})).toThrow("CORE_START_UNEXPECTED_OWNER");
    expect(()=>validateMcpCoreStart({...base,expectedBuildDigest:"no"})).toThrow("CORE_START_INVALID_BUILD");
    expect(()=>validateMcpCoreStart({...base,port:80})).toThrow("CORE_START_INVALID_PORT");
  });
});
