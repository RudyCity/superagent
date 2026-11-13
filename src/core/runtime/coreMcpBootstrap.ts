/**
 * Independently owned MCP -> Core bootstrap.
 * Runs only a verified bundled Core entry, never a caller-provided command,
 * and preserves orphan/checkpoint evidence for the existing Core boot policy.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {spawn} from "node:child_process";
import {getPackageRootDir,getRootConfigDir} from "../config/paths.js";
import {inspectCoreBuild} from "./coreBuildIdentity.js";
import {auditCoreColdStart} from "./coreColdStartAudit.js";
import type {CoreColdDecision} from "./coreColdStartPolicy.js";
import {requestCoreSupervisor} from "./coreSupervisor.js";
import {readListenerOwners} from "./coreMcpOwnershipAudit.js";
import {readCoreGuardianLease} from "./coreGuardian.js";
import {readCoreCheckpoint,coreCheckpointPath} from "./coreSupervisorCheckpoint.js";
import {ManagedSidecarLedger,sidecarOperationFingerprint} from "./managedSidecarLedger.js";
import {validateCoreOperationId} from "./coreLifecycleLedger.js";

type Mode="tline"|"chrome-extension";
export type McpCoreStartPlan={
  service:"core";action:"start";port:number;operationId:string;
  expectedOwnerPid:0;expectedInstanceId:"absent";
  expectedBuildDigest:string;clientMode:Mode;
  note:string;
};
export type McpCoreStartInput={
  ownerOnline:boolean;listenerObserved:boolean;listenerInventoryVerified:boolean;
  decision:CoreColdDecision;
};
export function assessMcpCoreStart(v:McpCoreStartInput):string {
  if(v.ownerOnline)return "CORE_START_ALREADY_RUNNING";
  if(!v.listenerInventoryVerified)return "CORE_START_LISTENER_INVENTORY_UNAVAILABLE";
  if(v.listenerObserved)return "CORE_START_FOREIGN_LISTENER";
  if(v.decision==="fresh_guard_allowed"||v.decision==="recover_verified_survivors"||
    v.decision==="cold_reset_allowed")return "ready";
  return "CORE_START_AUDIT_"+v.decision.toUpperCase();
}
function goodPort(port:number):boolean{
  return Number.isSafeInteger(port)&&port>=1024&&port<=65535;
}
export function validateMcpCoreStart(v:unknown):McpCoreStartPlan&{confirm:true}{
  if(!v||typeof v!=="object")throw new Error("CORE_START_INVALID_ARGUMENTS");
  const a=v as Record<string,unknown>;
  if(a.action!=="start"||a.service!=="core")throw new Error("CORE_START_INVALID_ACTION");
  if(!goodPort(a.port as number))throw new Error("CORE_START_INVALID_PORT");
  if(a.confirm!==true)throw new Error("CORE_START_CONFIRM_REQUIRED");
  if(a.expectedOwnerPid!==0||a.expectedInstanceId!=="absent")
    throw new Error("CORE_START_UNEXPECTED_OWNER");
  if(typeof a.expectedBuildDigest!=="string"||!/^[a-f0-9]{64}$/.test(a.expectedBuildDigest))
    throw new Error("CORE_START_INVALID_BUILD");
  if(a.clientMode!=="tline"&&a.clientMode!=="chrome-extension")
    throw new Error("CORE_START_INVALID_MODE");
  validateCoreOperationId(a.operationId);
  return v as McpCoreStartPlan&{confirm:true};
}
async function verifiedCore(port:number){
  try{
    const s=await requestCoreSupervisor("status",port,1200);
    return s.publicPort===port&&s.supervisorPid>0&&s.active?.pid>0&&
      s.ownerContract?.role==="core-supervisor"&&
      s.ownerContract?.mcpLifecycle==="not-owned"?s:null;
  }catch{return null;}
}
async function coldStartEvidence(port:number){
  if(!goodPort(port))throw new Error("CORE_START_INVALID_PORT");
  const owner=await verifiedCore(port);
  if(owner)throw new Error("CORE_START_ALREADY_RUNNING");
  const listeners=readListenerOwners();
  const audit=await auditCoreColdStart(port);
  const state=assessMcpCoreStart({
    ownerOnline:owner!==null,
    listenerInventoryVerified:listeners!==null,
    listenerObserved:listeners!==null&&listeners.has(port)||
      audit.snapshot.foreignListenerDetected,
    decision:audit.assessment.decision,
  });
  if(state!=="ready")throw new Error(state+
    (audit.assessment.reasons.length?": "+audit.assessment.reasons.join(","):""));
  // Existing boot refuses checkpoint-survivor recovery while a Guardian lease
  // remains; do not offer a plan that cannot be safely executed.
  if(audit.assessment.decision==="recover_verified_survivors"&&
    audit.snapshot.guardianLeasePresent)
    throw new Error("CORE_START_GUARDIAN_LEASE_REQUIRES_REVIEW");
  return audit;
}
function compiledLauncher(){
  if(typeof (globalThis as {Bun?:unknown}).Bun==="undefined"||
    !path.isAbsolute(process.execPath)||
    path.extname(process.execPath).toLowerCase()!==".exe"&&process.platform==="win32")
    throw new Error("CORE_START_REQUIRES_BUN_OWNER");
  const root=getPackageRootDir();
  const entry=path.join(root,"dist","cli.js");
  for(const file of [entry,process.execPath]){
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink())
      throw new Error("CORE_START_UNSAFE_LAUNCHER");
  }
  const build=inspectCoreBuild(entry,{requireFreshCompiled:true});
  return {root,entry,exe:process.execPath,build};
}
function modeFromCheckpoint(port:number):Mode{
  if(!fs.existsSync(coreCheckpointPath(port)))return "tline";
  return readCoreCheckpoint(port).clientMode;
}
export async function planMcpCoreStart(port:number):Promise<McpCoreStartPlan>{
  await coldStartEvidence(port);
  if(new ManagedSidecarLedger("core",port).inspect().some(x=>x.state==="pending"))
    throw new Error("CORE_START_PRIOR_OPERATION_UNCERTAIN");
  const launcher=compiledLauncher();
  const clientMode=modeFromCheckpoint(port);
  return {service:"core",action:"start",port,operationId:crypto.randomUUID(),
    expectedOwnerPid:0,expectedInstanceId:"absent",
    expectedBuildDigest:launcher.build.digest,clientMode,
    note:"MCP-independent cold bootstrap; existing Core checkpoint policy applies. No remote shell, PID kill or tunnel restart."};
}
async function startOwnedCore(launcher:ReturnType<typeof compiledLauncher>,
  port:number,clientMode:Mode):Promise<number>{
  const child=spawn(launcher.exe,[launcher.entry,"core","boot",
    "--port",String(port),"--client-mode",clientMode],{
    cwd:launcher.root,detached:true,windowsHide:true,stdio:"ignore",
    env:{...process.env,SUPERAGENT_TRAY_AUTOSTART:"0"},
  });
  // Attach both handlers before waiting; a launch failure is not success.
  child.on("error",()=>{});
  await new Promise<void>((resolve,reject)=>{
    child.once("spawn",()=>resolve());
    child.once("error",reject);
  });
  if(!child.pid)throw new Error("CORE_START_CHILD_PID_UNAVAILABLE");
  child.unref();
  return child.pid;
}
async function waitForOwnedCore(port:number,childPid:number):Promise<number>{
  const deadline=Date.now()+30000;
  while(Date.now()<deadline){
    const s=await verifiedCore(port);
    if(s){
      const listener=readListenerOwners();
      const lease=readCoreGuardianLease(port);
      const launchedByChild=s.supervisorPid===childPid||
        lease?.pid===childPid&&lease.supervisorPid===s.supervisorPid;
      if(listener?.get(port)===s.supervisorPid&&launchedByChild)return s.supervisorPid;
      // A verified competing Core is still NOT the child we launched.
      if(listener?.has(port)&&listener.get(port)!==s.supervisorPid)
        throw new Error("CORE_START_FOREIGN_LISTENER");
    }
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new Error("CORE_START_UNCERTAIN_TIMEOUT: inspect owner and operation receipt before retry");
}
export async function executeMcpCoreStart(raw:unknown){
  const v=validateMcpCoreStart(raw);
  const launcher=compiledLauncher();
  if(launcher.build.digest!==v.expectedBuildDigest)
    throw new Error("CORE_START_BUILD_CHANGED_SINCE_PLAN");
  if(modeFromCheckpoint(v.port)!==v.clientMode)
    throw new Error("CORE_START_MODE_CHANGED_SINCE_PLAN");
  const ledger=new ManagedSidecarLedger("core",v.port);
  const fingerprint=sidecarOperationFingerprint({service:"core",action:"start",
    port:v.port,expectedOwnerPid:0,expectedInstanceId:"absent",
    expectedBuildDigest:v.expectedBuildDigest,clientMode:v.clientMode});
  const prior=ledger.lookup(v.operationId,fingerprint);
  if(prior?.replayed){
    const s=await verifiedCore(v.port);
    if(!s||s.supervisorPid!==prior.afterPid)
      throw new Error("CORE_START_REPLAY_OWNER_CHANGED");
    return {service:"core",action:"start",port:v.port,
      changed:false,replayed:true,ownerPid:s.supervisorPid};
  }
  const root=getRootConfigDir();
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  if(fs.lstatSync(root).isSymbolicLink())throw new Error("CORE_START_UNSAFE_CONFIG_DIR");
  const lock=path.join(root,"core-mcp-bootstrap-"+v.port+".lock");
  let fd:number;
  try{fd=fs.openSync(lock,"wx",0o600);}
  catch{throw new Error("CORE_START_CONCURRENT_OR_ORPHAN_LOCK");}
  try{
    await coldStartEvidence(v.port);
    if(ledger.inspect().some(x=>x.state==="pending"))
      throw new Error("CORE_START_PRIOR_OPERATION_UNCERTAIN");
    // Check once more before reserving the operation and launching.
    if(launcher.build.digest!==compiledLauncher().build.digest)
      throw new Error("CORE_START_BUILD_CHANGED_SINCE_PLAN");
    ledger.begin(v.operationId,fingerprint);
    const childPid=await startOwnedCore(launcher,v.port,v.clientMode);
    const supervisorPid=await waitForOwnedCore(v.port,childPid);
    ledger.complete(v.operationId,supervisorPid);
    return {service:"core",action:"start",port:v.port,
      changed:true,replayed:false,ownerPid:supervisorPid,
      childPid,verified:true,tunnelUnaffected:true};
  }finally{
    fs.closeSync(fd);
    try{fs.rmSync(lock,{force:true});}catch{}
  }
}
