import { describe, expect, it, vi } from "vitest";
import { inspectSafeLifecycleReadiness, type SafeLifecycleInspectionProvider } from "../src/core/runtime/safeLifecycleController.js";
import type { ServiceStatus } from "../src/core/runtime/serviceManager.js";
import type { CoreRuntimeStatus } from "../src/core/runtime/coreSupervisor.js";

const digest = "a".repeat(64);
const op = "123e4567-e89b-42d3-a456-426614174000";
const coreState: ServiceStatus = {
  service: "core", state: "active", port: 7888, ownerPid: 101,
  ownershipVerified: true, actions: ["status", "plan", "restart", "rollback", "drain"], reason: "verified",
};
const trayState: ServiceStatus = {
  service: "tray", state: "active", port: 45000, ownerPid: 202,
  ownershipVerified: true, actions: ["status", "plan", "restart", "stop"], reason: "verified",
};
const coreStatus: CoreRuntimeStatus = {
  supervisorPid: 101, publicPort: 7888,
  ownerContract: {version:1,safeLifecycleVersion:2,role:"core-supervisor",mcpLifecycle:"not-owned",replayPolicy:"explicit-resume-only"},
  active: {pid: 102,port:34000,since:1,buildDigest:digest},
  retained: [{pid:103,port:34001,since:1}],
  currentBuild: {mode:"compiled",digest,sourceDigest:digest,fileCount:10,fresh:true},
  affinitySessions: 0,
};
const base = (): SafeLifecycleInspectionProvider => ({
  inspectServices: vi.fn(async()=>[coreState,trayState]),
  coreStatus: vi.fn(async()=>coreStatus),
  corePlan: vi.fn(async()=>({
    service:"core",action:"restart",operationId:op,expectedBuildDigest:digest,
    port:7888,supervisorPid:101,activeWorkerPid:102,
  })),
  corePending: vi.fn(()=>0),
  delegatePortOwner: vi.fn(()=>102),
  delegateDesiredEnabled: vi.fn(()=>true),
  trayOwner: vi.fn(()=>({
    pid:202,instanceId:"c".repeat(32),controlPort:45000,executablePath:"private.exe",
  })),
  trayPlan: vi.fn(async()=>({
    service:"tray",action:"restart",operationId:op,expectedBuildDigest:digest,
    expectedOwnerPid:202,expectedInstanceId:"c".repeat(32),port:45000,noCoreShutdown:true,
  })),
  trayPending: vi.fn(()=>0),
  trayForeign: vi.fn(()=>0),
  trayDigest: vi.fn(()=>digest),
});
describe("Safe lifecycle controller read-only end-to-end provider evidence",()=>{
  it("returns independent advisory ready verdicts, never mutation authorization",async()=>{
    const p=base();
    const result=await inspectSafeLifecycleReadiness(p);
    expect(result.readOnly).toBe(true);
    expect(result.core).toMatchObject({ready:true,mutationAuthorized:false,planAvailable:true});
    expect(result.tray).toMatchObject({ready:true,mutationAuthorized:false,planAvailable:true});
    expect(p.corePlan).toHaveBeenCalledTimes(1);
    expect(p.trayPlan).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(op);
    expect(JSON.stringify(result)).not.toContain("private.exe");
  });
  it("denies a retained or foreign Delegate port owner, regardless of a valid Core plan",async()=>{
    const p=base();p.delegatePortOwner=()=>103;
    const result=await inspectSafeLifecycleReadiness(p);
    expect(result.core.reasons).toContain("FOREIGN_PROCESS_UNVERIFIED");
    expect(result.tray.ready).toBe(true);
  });
  it("denies unknown port ownership, but permits deliberate OFF and absent listener",async()=>{
    const p=base();p.delegatePortOwner=()=>null;
    expect((await inspectSafeLifecycleReadiness(p)).core.ready).toBe(false);
    p.delegatePortOwner=()=>0;p.delegateDesiredEnabled=()=>false;
    expect((await inspectSafeLifecycleReadiness(p)).core.ready).toBe(true);
  });
  it("blocks old supervisor without safe handover v2 marker",async()=>{
    const p=base();
    p.coreStatus=async()=>({...coreStatus,
      ownerContract:{...coreStatus.ownerContract!,safeLifecycleVersion:undefined}});
    const result=await inspectSafeLifecycleReadiness(p);
    expect(result.core.ready).toBe(false);
    expect(result.core.reasons).toContain("SUPERVISOR_PROTOCOL_UNVERIFIED");
    expect(result.tray.ready).toBe(true);
  });
  it("denies pending Core operations and cross-journal pending Tray operations",async()=>{
    const p=base();p.corePending=()=>1;p.trayPending=()=>1;
    const result=await inspectSafeLifecycleReadiness(p);
    expect(result.core.reasons).toContain("UNCERTAIN_OPERATION");
    expect(result.tray.reasons).toContain("UNCERTAIN_OPERATION");
  });
  it("denies duplicate Tray processes and stale build state independently",async()=>{
    const p=base();
    p.trayForeign=()=>1;
    p.coreStatus=async()=>({...coreStatus,currentBuild:{...coreStatus.currentBuild!,fresh:false}});
    const result=await inspectSafeLifecycleReadiness(p);
    expect(result.tray.reasons).toContain("FOREIGN_PROCESS_UNVERIFIED");
    expect(result.core.reasons).toContain("BUILD_STALE");
  });
  it("denies plan or inspection failures, exposing an error code only",async()=>{
    const p=base();
    p.corePlan=async()=>{throw Error("CORE_BUILD_UNVERIFIED: secret-credential");};
    p.trayPlan=async()=>{throw Error("TRAY_LEGACY_PROCESS_REQUIRES_USER_QUIT: secret-credential");};
    const report=await inspectSafeLifecycleReadiness(p);
    expect(report.core).toMatchObject({ready:false,planErrorCode:"CORE_BUILD_UNVERIFIED"});
    expect(report.tray).toMatchObject({ready:false,planErrorCode:"TRAY_LEGACY_PROCESS_REQUIRES_USER_QUIT"});
    expect(JSON.stringify(report)).not.toContain("secret-credential");
  });
  it("denies owner identity drift and reached retained worker capacity",async()=>{
    const p=base();
    p.coreStatus=async()=>({...coreStatus,retained:[...coreStatus.retained,...coreStatus.retained,...coreStatus.retained,...coreStatus.retained]});
    p.trayOwner=()=>({pid:999,instanceId:"c".repeat(32),controlPort:45000,executablePath:"private.exe"});
    const result=await inspectSafeLifecycleReadiness(p);
    expect(result.core.reasons).toContain("RETAINED_LIMIT");
    expect(result.tray.reasons).toContain("OWNER_UNVERIFIED");
  });
  it("never converts provider failure into a ready verdict",async()=>{
    const p=base();
    p.inspectServices=async()=>{throw Error("INSPECTION_CRASH: tokens here");};
    const result=await inspectSafeLifecycleReadiness(p);
    expect(result.core.ready).toBe(false);
    expect(result.tray.ready).toBe(false);
    expect(JSON.stringify(result)).not.toContain("tokens here");
  });
});