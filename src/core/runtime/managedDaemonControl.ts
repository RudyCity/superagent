/**
 * In-process cron scheduler lifecycle, executed through the authenticated
 * supervised Core's REST interface. Never mutates an MCP-local scheduler.
 */
import crypto from "node:crypto";
import {requestCoreSupervisor} from "./coreSupervisor.js";
import {readCoreCheckpoint} from "./coreSupervisorCheckpoint.js";
import {readListenerOwners} from "./coreMcpOwnershipAudit.js";
import {ManagedSidecarLedger,sidecarOperationFingerprint} from "./managedSidecarLedger.js";
import {validateCoreOperationId} from "./coreLifecycleLedger.js";

type Action="start"|"stop"|"restart";
type State={running:boolean;pid:number;activeJobsCount:number;totalJobsCount:number};
type Owner={port:number;supervisorPid:number;workerPid:number;token:string};
export type DaemonPlan={
  service:"daemon";action:Action;port:number;operationId:string;
  expectedSupervisorPid:number;expectedWorkerPid:number;
  expectedRunning:boolean;noActiveJobs:true;note:string;
};
async function verifiedCore(port:number):Promise<Owner>{
  const live=await requestCoreSupervisor("status",port,1400);
  const cp=readCoreCheckpoint(port);
  if(live.publicPort!==port||live.ownerContract?.role!=="core-supervisor"||
     live.ownerContract?.mcpLifecycle!=="not-owned"||
     live.supervisorPid!==readListenerOwners()?.get(port)||
     live.active.pid!==cp.activePid||live.retained.length>4)
    throw new Error("DAEMON_CORE_OWNER_UNVERIFIED");
  return {port,supervisorPid:live.supervisorPid,
    workerPid:live.active.pid,token:cp.serverToken};
}
async function api(owner:Owner,action:"status"|"start"|"stop"){
  const response=await fetch("http://127.0.0.1:"+owner.port+"/api/daemon/"+action,{
    method:action==="status"?"GET":"POST",
    headers:{"Authorization":"Bearer "+owner.token,
      ...(action==="start"||action==="stop"?{"Content-Type":"application/json"}:{})},
    ...(action==="status"?{}:{body:"{}"}),
    signal:AbortSignal.timeout(4000),redirect:"error",
  });
  const body=await response.json().catch(()=>null) as any;
  if(!response.ok||body?.success!==true)
    throw new Error("DAEMON_AUTHENTICATED_API_FAILED_"+action.toUpperCase()+"_HTTP_"+response.status);
  return body;
}
export async function inspectDaemonScheduler(port:number){
  try {
    const owner=await verifiedCore(port);
    const status=await api(owner,"status") as State & {success:boolean};
    if(status.pid!==owner.workerPid||
       !Number.isSafeInteger(status.activeJobsCount)||
       !Number.isSafeInteger(status.totalJobsCount)||
       typeof status.running!=="boolean")
      throw new Error("DAEMON_WORKER_IDENTITY_MISMATCH");
    return {verified:true,port,running:status.running,workerPid:owner.workerPid,
      supervisorPid:owner.supervisorPid,activeJobs:status.activeJobsCount,
      totalJobs:status.totalJobsCount,reason:"Verified scheduler in supervised Core worker"};
  }catch(e){
    return {verified:false,port,reason:e instanceof Error?e.message:"DAEMON_UNVERIFIED"};
  }
}
export async function planDaemonLifecycle(action:Action,port:number):Promise<DaemonPlan>{
  if(!Number.isSafeInteger(port)||port<1024||port>65535)
    throw new Error("DAEMON_INVALID_PORT");
  const status=await inspectDaemonScheduler(port);
  if(!status.verified||status.workerPid===undefined||status.supervisorPid===undefined)
    throw new Error(status.reason);
  if((status.activeJobs??0)>0)
    throw new Error("DAEMON_ACTIVE_JOBS: wait for completion, do not interrupt scheduled actions");
  return {service:"daemon",action,port,operationId:crypto.randomUUID(),
    expectedSupervisorPid:status.supervisorPid,
    expectedWorkerPid:status.workerPid,expectedRunning:status.running===true,
    noActiveJobs:true,
    note:"In-process scheduler only. No Core/worker restart or cron job deletion. Operator confirmation required; active jobs are never stopped.",
  };
}
export async function executeDaemonLifecycle(args:DaemonPlan&{confirm:boolean}){
  if(args.confirm!==true||args.noActiveJobs!==true)
    throw new Error("DAEMON_EXPLICIT_APPROVAL_REQUIRED");
  validateCoreOperationId(args.operationId);
  if(!Number.isSafeInteger(args.expectedSupervisorPid)||args.expectedSupervisorPid<=0||
     !Number.isSafeInteger(args.expectedWorkerPid)||args.expectedWorkerPid<=0||
     typeof args.expectedRunning!=="boolean"||
     !["start","stop","restart"].includes(args.action))
    throw new Error("DAEMON_INVALID_PLAN_FIELDS");
  const ledger=new ManagedSidecarLedger("daemon",args.port);
  const fp=sidecarOperationFingerprint({
    service:"daemon",action:args.action,port:args.port,
    expectedSupervisorPid:args.expectedSupervisorPid,
    expectedWorkerPid:args.expectedWorkerPid,
    expectedRunning:args.expectedRunning,noActiveJobs:true,
  });
  const repeated=ledger.lookup(args.operationId,fp);
  if(repeated?.replayed){
    const current=await inspectDaemonScheduler(args.port);
    if(!current.verified||current.workerPid!==args.expectedWorkerPid||
       current.running!==(args.action!=="stop"))
      throw new Error("DAEMON_REPLAY_OWNER_OR_RUNNING_STATE_CHANGED");
    return {service:"daemon",action:args.action,port:args.port,
      replayed:true,changed:false,workerPid:current.workerPid,running:current.running};
  }
  const owner=await verifiedCore(args.port);
  if(owner.workerPid!==args.expectedWorkerPid||
     owner.supervisorPid!==args.expectedSupervisorPid)
    throw new Error("DAEMON_CORE_CHANGED_SINCE_PLAN");
  const before=await inspectDaemonScheduler(args.port);
  if(!before.verified||before.workerPid!==owner.workerPid||
     before.running!==args.expectedRunning||before.activeJobs!==0)
    throw new Error("DAEMON_PENDING_JOBS_OR_STATE_CHANGED");
  ledger.begin(args.operationId,fp);
  if(args.action==="restart"&&before.running)
    await api(owner,"stop");
  if(args.action==="start"||args.action==="restart")
    await api(owner,"start");
  else await api(owner,"stop");
  const after=await inspectDaemonScheduler(args.port);
  const expected=args.action!=="stop";
  if(!after.verified||after.workerPid!==owner.workerPid||
     after.supervisorPid!==owner.supervisorPid||after.running!==expected)
    throw new Error("DAEMON_OPERATION_OUTCOME_UNCERTAIN: operator review before retry");
  ledger.complete(args.operationId,owner.workerPid);
  return {service:"daemon",action:args.action,port:args.port,replayed:false,
    changed:args.action==="restart"||before.running!==expected,
    workerPid:owner.workerPid,supervisorPid:owner.supervisorPid,
    running:after.running,activeJobs:after.activeJobs,coreUnaffected:true};
}
