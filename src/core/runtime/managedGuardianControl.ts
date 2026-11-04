/**
 * Opt-in Guardian manager. Only attaches to an already-supervised Core and
 * never kills that Core, its workers, MCP tunnel or old/foreign Guardians.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {spawn} from "node:child_process";
import {getPackageRootDir} from "../config/paths.js";
import {inspectCoreBuild} from "./coreBuildIdentity.js";
import {readListenerOwners} from "./coreMcpOwnershipAudit.js";
import {requestCoreSupervisor} from "./coreSupervisor.js";
import {readCoreCheckpoint} from "./coreSupervisorCheckpoint.js";
import {coreGuardianFile,readCoreGuardianLease} from "./coreGuardian.js";
import {readManagedGuardianOwner,managedGuardianOwnerPath} from "./managedGuardianEntry.js";
import {ManagedSidecarLedger,sidecarOperationFingerprint} from "./managedSidecarLedger.js";
import {validateCoreOperationId} from "./coreLifecycleLedger.js";

export async function inspectManagedGuardian(port:number){
  const owner=readManagedGuardianOwner(port);
  if(!owner)return {verified:false,ownerPid:null,reason:"No managed Guardian owner"};
  try {
    const response=await fetch("http://127.0.0.1:"+owner.controlPort+"/guardian/health",{
      signal:AbortSignal.timeout(1600),redirect:"error",
    });
    const live=await response.json() as {service?:string;pid?:number;
      corePort?:number;instanceId?:string;guardianRegistered?:boolean;supervisorPid?:number};
    const verified=response.ok&&live.service==="superagent-managed-guardian"&&
      live.pid===owner.pid&&live.corePort===port&&
      live.instanceId===owner.instanceId&&live.guardianRegistered===true&&
      readListenerOwners()?.get(owner.controlPort)===owner.pid;
    return {verified,ownerPid:owner.pid,controlPort:owner.controlPort,
      reason:verified?"Authenticated private Guardian owner":"Guardian PID or instance identity mismatch"};
  }catch{
    return {verified:false,ownerPid:owner.pid,reason:"Guardian private control endpoint unreachable"};
  }
}
async function requestManagedGuardianStop(port:number,pid:number,instanceId:string){
  const owner=readManagedGuardianOwner(port),current=await inspectManagedGuardian(port);
  if(!owner||!current.verified||owner.pid!==pid||owner.instanceId!==instanceId)
    throw new Error("GUARDIAN_OWNER_CHANGED");
  const reply=await fetch("http://127.0.0.1:"+owner.controlPort+"/guardian/control",{
    method:"POST",headers:{"Authorization":"Bearer "+owner.token,
      "Content-Type":"application/json"},
    body:JSON.stringify({action:"stop",instanceId:owner.instanceId}),
    signal:AbortSignal.timeout(3000),
  });
  if(!reply.ok||!(await reply.json() as any).ok)
    throw new Error("GUARDIAN_STOP_REFUSED");
}
type Action="start"|"stop"|"restart";
export type GuardianPlan={
  service:"guardian";action:Action;port:number;operationId:string;
  expectedOwnerPid:number;expectedInstanceId:string;
  expectedSupervisorPid:number;noCoreShutdown:true;note:string;
};
function validPort(p:number){
  return Number.isSafeInteger(p)&&p>=1024&&p<=65535;
}
async function activeCore(port:number) {
  const status=await requestCoreSupervisor("status",port,1700);
  if(status.supervisorPid<=0||status.publicPort!==port||
     status.ownerContract?.role!=="core-supervisor"||
     status.ownerContract?.mcpLifecycle!=="not-owned"||
     readListenerOwners()?.get(port)!==status.supervisorPid)
    throw new Error("GUARDIAN_CORE_SUPERVISOR_UNVERIFIED");
  const checkpoint=readCoreCheckpoint(port);
  if(checkpoint.activePid!==status.active.pid||
     !["tline","chrome-extension"].includes(checkpoint.clientMode))
    throw new Error("GUARDIAN_CORE_CHECKPOINT_UNVERIFIED");
  return {status,checkpoint};
}
async function unowned(port:number){
  if(fs.existsSync(coreGuardianFile(port))||fs.existsSync(managedGuardianOwnerPath(port)))
    throw new Error("GUARDIAN_EXISTING_OWNER_RECORD: no adoption of old Guardians");
}
export async function planManagedGuardian(action:Action,port:number):Promise<GuardianPlan>{
  if(!validPort(port))throw new Error("GUARDIAN_INVALID_PORT");
  const core=await activeCore(port);
  let pid=0,instanceId="absent";
  if(action==="start")await unowned(port);
  else {
    const record=readManagedGuardianOwner(port),observed=await inspectManagedGuardian(port);
    if(!record||!observed.verified)
      throw new Error("GUARDIAN_UNOWNED_OR_UNVERIFIED");
    pid=record.pid;instanceId=record.instanceId;
  }
  return {service:"guardian",action,port,operationId:crypto.randomUUID(),
    expectedOwnerPid:pid,expectedInstanceId:instanceId,
    expectedSupervisorPid:core.status.supervisorPid,noCoreShutdown:true,
    note:"Only attaches to verified supervised Core. Stopping Guardian does not stop Core. Requires explicit operator approval."};
}
export async function executeManagedGuardian(args:GuardianPlan&{confirm:boolean}){
  if(args.confirm!==true||args.noCoreShutdown!==true)
    throw new Error("GUARDIAN_CONFIRM_REQUIRED");
  validateCoreOperationId(args.operationId);
  if(!validPort(args.port)||!Number.isSafeInteger(args.expectedOwnerPid)||
     args.expectedOwnerPid<0||typeof args.expectedInstanceId!=="string")
    throw new Error("GUARDIAN_INVALID_OPERATION");
  const ledger=new ManagedSidecarLedger("guardian",args.port);
  const fp=sidecarOperationFingerprint({service:"guardian",action:args.action,
    port:args.port,expectedOwnerPid:args.expectedOwnerPid,
    expectedInstanceId:args.expectedInstanceId,
    expectedSupervisorPid:args.expectedSupervisorPid,noCoreShutdown:true});
  const prior=ledger.lookup(args.operationId,fp);
  if(prior?.replayed){
    if(prior.afterPid===0)await unowned(args.port);
    else{
      const status=await inspectManagedGuardian(args.port);
      if(!status.verified||status.ownerPid!==prior.afterPid)
        throw new Error("GUARDIAN_REPLAY_OWNER_CHANGED");
    }
    return {service:"guardian",action:args.action,port:args.port,
      replayed:true,changed:false,ownerPid:prior.afterPid||null};
  }
  const core=await activeCore(args.port);
  if(core.status.supervisorPid!==args.expectedSupervisorPid)
    throw new Error("GUARDIAN_CORE_SUPERVISOR_CHANGED_SINCE_PLAN");
  async function start(){
    await unowned(args.port);
    const root=getPackageRootDir();
    const source=path.join(root,"src","core","runtime","managedGuardianEntry.ts"),
      compiled=path.join(root,"dist","core","runtime","managedGuardianEntry.js");
    const useSource=fs.existsSync(source)&&typeof (globalThis as any).Bun!=="undefined";
    const entry=useSource?source:compiled;
    if(!fs.existsSync(entry)||fs.lstatSync(entry).isSymbolicLink())
      throw new Error("GUARDIAN_CLI_ENTRY_MISSING");
    inspectCoreBuild(entry,{requireFreshCompiled:!useSource});
    const child=spawn(process.execPath,[entry,String(args.port)],{
      cwd:root,windowsHide:true,detached:true,stdio:"ignore",
      env:{...process.env,SUPERAGENT_TRAY_AUTOSTART:"0"},
    });
    child.on("error",()=>{});child.unref();
    if(!child.pid)throw new Error("GUARDIAN_CHILD_PID_MISSING");
    const deadline=Date.now()+20000;
    while(Date.now()<deadline){
      try {
        const lease=readCoreGuardianLease(args.port);
        const owner=readManagedGuardianOwner(args.port);
        const current=await inspectManagedGuardian(args.port);
        if(lease?.pid===child.pid&&owner?.pid===child.pid&&current.verified&&
           lease.supervisorPid===core.status.supervisorPid)
          return child.pid;
        if((lease&&lease.pid!==child.pid)||(owner&&owner.pid!==child.pid))
          throw new Error("GUARDIAN_FOREIGN_OWNER_APPEARED");
      }catch(e){
        if(String(e).includes("GUARDIAN_FOREIGN_OWNER_APPEARED"))throw e;
      }
      await new Promise(r=>setTimeout(r,200));
    }
    throw new Error("GUARDIAN_START_UNCERTAIN: review PID "+child.pid);
  }
  if(args.action==="start"){
    if(args.expectedOwnerPid!==0||args.expectedInstanceId!=="absent")
      throw new Error("GUARDIAN_EXPECTED_VACANT");
    await unowned(args.port);
    ledger.begin(args.operationId,fp);
    const pid=await start();
    ledger.complete(args.operationId,pid);
    return {service:"guardian",action:"start",port:args.port,
      ownerPid:pid,replayed:false,changed:true};
  }
  const current=readManagedGuardianOwner(args.port),
    coreLease=readCoreGuardianLease(args.port),
    status=await inspectManagedGuardian(args.port);
  if(!current||!coreLease||!status.verified||
     current.pid!==args.expectedOwnerPid||
     current.instanceId!==args.expectedInstanceId)
    throw new Error("GUARDIAN_OWNER_CHANGED_SINCE_PLAN");
  if(coreLease.ownership!=="adopted"||
     coreLease.supervisorPid!==core.status.supervisorPid||
     coreLease.pid!==current.pid)
    throw new Error("GUARDIAN_STOP_REQUIRES_ADOPTED_CORE_OWNER");
  ledger.begin(args.operationId,fp);
  await requestManagedGuardianStop(args.port,current.pid,current.instanceId);
  const deadline=Date.now()+14000;
  while(Date.now()<deadline &&
    (fs.existsSync(coreGuardianFile(args.port))||
     fs.existsSync(managedGuardianOwnerPath(args.port))))
    await new Promise(r=>setTimeout(r,200));
  if(fs.existsSync(coreGuardianFile(args.port))||
     fs.existsSync(managedGuardianOwnerPath(args.port)))
    throw new Error("GUARDIAN_STOP_UNCERTAIN: inspect owner before retry");
  const after=await activeCore(args.port);
  if(after.status.supervisorPid!==core.status.supervisorPid)
    throw new Error("GUARDIAN_CORE_OWNER_CHANGED_DURING_STOP");
  if(args.action==="stop"){
    ledger.complete(args.operationId,0);
    return {service:"guardian",action:"stop",port:args.port,
      ownerPid:null,previousPid:current.pid,replayed:false,changed:true,
      coreSupervisorPid:after.status.supervisorPid,coreUnaffected:true,
      note:"Guardian stopped; supervised Core remains alive and unchanged"};
  }
  const pid=await start();
  ledger.complete(args.operationId,pid);
  return {service:"guardian",action:"restart",port:args.port,
    ownerPid:pid,previousPid:current.pid,replayed:false,changed:true,
    coreSupervisorPid:after.status.supervisorPid};
}
