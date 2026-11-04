/**
 * Unified service management for MCP and local agents.
 *
 * Read-only inventory covers every known service domain. Mutations go ONLY
 * through pre-existing authenticated owner-specific lifecycle protocols.
 * No shell execution, arbitrary PID signals or tunnel URL rotation.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import { requestCoreSupervisor } from "./coreSupervisor.js";
import { controlCoreLifecycle, prepareCoreLifecycle } from "./coreLifecycleControl.js";
import { validateCoreOperationId } from "./coreLifecycleLedger.js";
import { readCoreGuardianLease } from "./coreGuardian.js";
import { listVerifiedChannelHosts } from "./channelHost.js";
import { readListenerOwners } from "./coreMcpOwnershipAudit.js";
import { getMcpStateFile, readMcpStateFile } from "../mcp/mcpTunnel.js";
import { readManagedMcpTunnelLease, probeManagedMcpTunnelOwner,
  verifyManagedOwnerIdentity, reloadManagedMcpTunnelBackend } from "./mcpManagedTunnelOwner.js";
import { McpServiceReloadLedger } from "./serviceReloadLedger.js";
import {planSidecarService,executeSidecarService,type SidecarService} from "./managedSidecarControl.js";
import {readTransportOwner} from "./transportHost.js";
import {readChannelHostDiscovery} from "./channelHost.js";
import {planOwnedTunnelStop,stopOwnedTunnel} from "./ownedTunnelLifecycle.js";
import {planManagedVision,executeManagedVision,inspectManagedVision} from "./managedVisionControl.js";
import {planManagedGuardian,executeManagedGuardian,inspectManagedGuardian} from "./managedGuardianControl.js";
import {planDaemonLifecycle,executeDaemonLifecycle,inspectDaemonScheduler} from "./managedDaemonControl.js";

import { MANAGED_SERVICE_NAMES, type ManagedServiceName } from "./serviceManagerTypes.js";
export { MANAGED_SERVICE_NAMES, type ManagedServiceName } from "./serviceManagerTypes.js";
export type ServiceAction =
  "inventory"|"status"|"plan"|"restart"|"rollback"|"drain"|"reload"|"start"|"stop"|"doctor";
export type ManageServicesArgs = {
  action:ServiceAction; service?:ManagedServiceName|"all"; port?:number;
  targetAction?:"restart"|"rollback"|"drain"|"reload"|"start"|"stop";
  confirm?:boolean; operationId?:string; expectedBuildDigest?:string;
  expectedOwnerPid?:number; expectedPublicUrl?:string;
  expectedInstanceId?:string; noPublicIngress?:boolean;
  expectedSupervisorPid?:number; noCoreShutdown?:boolean;
  expectedWorkerPid?:number; expectedRunning?:boolean; noActiveJobs?:boolean;
  expectedLocalUrl?:string;allowPublicDisruption?:boolean;
  corePort?:number;channelMode?:"idle"|"muse-ws"|"telegram-fallback";wsPort?:number;
};
export type ServiceStatus = {
  service:ManagedServiceName; port?:number;
  state:"active"|"inactive"|"degraded"|"unknown"|"unverified"|"embedded";
  ownerPid:number|null; ownershipVerified:boolean; actions:string[];
  reason:string; details?:Record<string,unknown>;
};
const defaultPorts:Partial<Record<ManagedServiceName,number>>={
  core:7888,mcp:8857,transport:7891,channel_host:7892,muse:7892,
  telegram:7892,vision:8095,guardian:7888,daemon:7888,
  rest_tunnel:7888,muse_tunnel:9225,
};
const known=new Set<string>(MANAGED_SERVICE_NAMES);
export function validateServicePort(input:unknown,fallback?:number):number {
  const v=input===undefined?fallback:input;
  if(typeof v!=="number"||!Number.isSafeInteger(v)||v<1024||v>65535)
    throw new Error("SERVICE_INVALID_PORT");
  return v;
}
export function validateManageServicesArgs(raw:unknown):ManageServicesArgs {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw new Error("SERVICE_ARGUMENTS_OBJECT_REQUIRED");
  const v=raw as Record<string,unknown>;
  const allowed=new Set(["action","service","port","targetAction","confirm",
    "operationId","expectedBuildDigest","expectedOwnerPid","expectedPublicUrl",
    "expectedInstanceId","noPublicIngress","corePort","channelMode","wsPort",
    "expectedLocalUrl","allowPublicDisruption",
    "expectedSupervisorPid","noCoreShutdown",
    "expectedWorkerPid","expectedRunning","noActiveJobs"]);
  if(Object.keys(v).some(k=>!allowed.has(k)))throw new Error("SERVICE_UNEXPECTED_ARGUMENT");
  if(!["inventory","status","plan","restart","rollback","drain","reload","start","stop","doctor"].includes(String(v.action)))
    throw new Error("SERVICE_UNKNOWN_ACTION");
  if(v.service!==undefined&&v.service!=="all"&&
     (typeof v.service!=="string"||!known.has(v.service)))throw new Error("SERVICE_UNKNOWN_TARGET");
  if(v.port!==undefined)validateServicePort(v.port);
  if(v.confirm!==undefined&&typeof v.confirm!=="boolean")throw new Error("SERVICE_INVALID_CONFIRM");
  if(v.targetAction!==undefined&&
     !["restart","rollback","drain","reload","start","stop"].includes(String(v.targetAction)))
    throw new Error("SERVICE_INVALID_TARGET_ACTION");
  if(v.expectedOwnerPid!==undefined&&
     (!Number.isSafeInteger(v.expectedOwnerPid)||Number(v.expectedOwnerPid)<0))
    throw new Error("SERVICE_INVALID_OWNER_PID");
  if(v.expectedInstanceId!==undefined&&(typeof v.expectedInstanceId!=="string"||
     !(/^[a-f0-9]{32}$/.test(v.expectedInstanceId)||v.expectedInstanceId==="absent")))
    throw new Error("SERVICE_INVALID_INSTANCE_ID");
  if(v.noPublicIngress!==undefined&&typeof v.noPublicIngress!=="boolean")
    throw new Error("SERVICE_INVALID_INGRESS_GUARD");
  if(v.expectedSupervisorPid!==undefined&&
     (!Number.isSafeInteger(v.expectedSupervisorPid)||Number(v.expectedSupervisorPid)<=0))
    throw new Error("SERVICE_INVALID_SUPERVISOR_PID");
  if(v.noCoreShutdown!==undefined&&typeof v.noCoreShutdown!=="boolean")
    throw new Error("SERVICE_INVALID_CORE_PROTECTION");
  if(v.expectedWorkerPid!==undefined&&
     (!Number.isSafeInteger(v.expectedWorkerPid)||Number(v.expectedWorkerPid)<=0))
    throw new Error("SERVICE_INVALID_WORKER_PID");
  if(v.expectedRunning!==undefined&&typeof v.expectedRunning!=="boolean")
    throw new Error("SERVICE_INVALID_RUNNING_EXPECTATION");
  if(v.noActiveJobs!==undefined&&typeof v.noActiveJobs!=="boolean")
    throw new Error("SERVICE_INVALID_SCHEDULER_JOB_PROTECTION");
  if(v.allowPublicDisruption!==undefined&&typeof v.allowPublicDisruption!=="boolean")
    throw new Error("SERVICE_INVALID_PUBLIC_DISRUPTION_ACK");
  if(v.expectedLocalUrl!==undefined&&
     (typeof v.expectedLocalUrl!=="string"||v.expectedLocalUrl.length>256||
      !/^http:\/\/127\.0\.0\.1:\d{4,5}(?:\/|$)/.test(v.expectedLocalUrl)))
    throw new Error("SERVICE_INVALID_LOCAL_TUNNEL_TARGET");
  if(v.corePort!==undefined)validateServicePort(v.corePort);
  if(v.wsPort!==undefined)validateServicePort(v.wsPort);
  if(v.channelMode!==undefined&&!["idle","muse-ws","telegram-fallback"].includes(String(v.channelMode)))
    throw new Error("SERVICE_INVALID_CHANNEL_MODE");
  if(v.expectedPublicUrl!==undefined&&
     (typeof v.expectedPublicUrl!=="string"||!/^https:\/\/[^\s]+$/.test(v.expectedPublicUrl)||v.expectedPublicUrl.length>1024))
    throw new Error("SERVICE_INVALID_PUBLIC_URL");
  if(v.expectedBuildDigest!==undefined&&
     (typeof v.expectedBuildDigest!=="string"||!/^[a-f0-9]{64}$/.test(v.expectedBuildDigest)))
    throw new Error("SERVICE_INVALID_BUILD_DIGEST");
  if(v.operationId!==undefined)validateCoreOperationId(v.operationId);
  if((v.service===undefined||v.service==="all")&&
     !["inventory","status","doctor"].includes(String(v.action)))
    throw new Error("SERVICE_SINGLE_TARGET_REQUIRED");
  return v as ManageServicesArgs;
}
function snap(service:ManagedServiceName,port:number|undefined,
  state:ServiceStatus["state"],ownerPid:number|null,verified:boolean,
  actions:string[],reason:string,details?:Record<string,unknown>):ServiceStatus {
  return {service,...(port?{port}:{}),state,ownerPid,ownershipVerified:verified,
    actions,reason,...(details?{details}:{})};
}
async function probe(port:number,resource:string):Promise<{status:number;body:any}|null> {
  try {
    const response=await fetch("http://127.0.0.1:"+port+resource,{
      method:"GET",signal:AbortSignal.timeout(1400),redirect:"error"});
    return {status:response.status,body:response.ok?await response.json().catch(()=>null):null};
  }catch{return null;}
}

async function inspectOne(service:ManagedServiceName,port:number|undefined,
  listeners:Map<number,number>|null):Promise<ServiceStatus> {
  const owner=port?listeners?.get(port)??null:null;
  if(service==="core") {
    try {
      const s=await requestCoreSupervisor("status",port!,1200);
      const verified=s.publicPort===port&&s.ownerContract?.role==="core-supervisor"&&
        s.ownerContract?.mcpLifecycle==="not-owned"&&s.supervisorPid===owner;
      return snap(service,port,verified?"active":"unverified",s.supervisorPid,verified,
        verified?["status","plan","restart","rollback","drain"]:["status"],
        verified?"Authenticated Core supervisor + kernel listener":
        "Core supervisor identity/kernel listener mismatch",
        {workerPid:s.active.pid,retainedWorkers:s.retained.length,
          sessionCount:s.affinitySessions,buildFresh:s.currentBuild?.fresh??null});
    }catch {
      const response=await probe(port!,"/api/status");
      return snap(service,port,response?"unverified":"inactive",owner,false,["status"],
        response?"API responds without supervised Core ownership; restart blocked":
          "No authenticated Core supervisor or responsive API");
    }
  }
  if(service==="mcp") {
    const registered=readMcpStateFile(getMcpStateFile(port!));
    if(!registered)return snap(service,port,owner?"unverified":"inactive",owner,false,
      ["status"],owner?"Listener exists without MCP owner record":"No registered MCP owner");
    const lease=readManagedMcpTunnelLease(port!);
    let verified=false,reloadable=false;
    if(lease?.pid===registered.pid&&owner===registered.pid) {
      try {
        await verifyManagedOwnerIdentity(lease,{timeoutMs:1100});
        const live=await probeManagedMcpTunnelOwner(lease);
        verified=Boolean(live&&live.pid===registered.pid);
        reloadable=verified&&Boolean((live as any)?.reloadable)&&registered.reloadable===true;
      }catch{}
    }
    const matched=owner===registered.pid;
    return snap(service,port,!matched?"unverified":verified?"active":"degraded",
      registered.pid,verified,reloadable?["status","plan","reload"]:["status"],
      reloadable?"Authenticated Reloadable MCP owner; URL-stable reload available":
        registered.reloadable?"Reloadable identity unverified; mutation blocked":
        "Legacy MCP owner: cannot guarantee same public URL on restart",
      {authMode:registered.authMode,tunnelProvider:registered.tunnelProvider,
        publicUrl:registered.publicUrl,registeredPid:registered.pid,
        listenerPid:owner,reloadable});
  }
  if(service==="transport") {
    const response=await probe(port!,"/_transport/health");
    const data=response?.body;
    if(!data||data.service!=="superagent-transport-host"||data.publicPort!==port)
      return snap(service,port,owner?"unverified":"inactive",owner,false,["status"],
        owner?"Unrecognized listener":"No T-Line Transport Host");
    const registered=readTransportOwner(port!);
    const verified=Number.isSafeInteger(data.pid)&&owner===data.pid&&
      registered?.pid===data.pid&&registered?.instanceId===data.instanceId;
    const actions=verified?["status","plan","stop","restart"]:["status"];
    return snap(service,port,!verified?"unverified":
      data.backendReady?"active":"degraded",data.pid,verified,actions,
      verified?"Identified T-Line front door":"Transport PID mismatch",
      {corePort:data.corePort,backendReady:data.backendReady,
        activeRequests:data.activeHttpRequests,upgradedSockets:data.upgradedSockets});
  }
  if(service==="channel_host"||service==="muse"||service==="telegram") {
    const hosts=await listVerifiedChannelHosts();
    const h=service==="channel_host"?hosts.find(x=>x.port===port):
      hosts.find(x=>x.mode===(service==="muse"?"muse-ws":"telegram-fallback"));
    if(!h)return snap(service,service==="channel_host"?port:undefined,"inactive",
      null,false,["status"],"No verified independent channel host for "+service);
    const registered=readChannelHostDiscovery(h.port);
    const verified=listeners?.get(h.port)===h.pid&&
      registered.pid===h.pid&&registered.instanceId===h.instanceId;
    const actions=verified?["status","plan","stop","restart"]:["status"];
    return snap(service,h.port,!verified?"unverified":
      h.status==="error"?"degraded":"active",h.pid,verified,actions,
      verified?"Verified independent channel host":"Channel host kernel PID mismatch",
      {mode:h.mode,watcherActive:h.watcherActive,taskActive:h.taskActive,
        pendingReconciliation:h.reconciliationPending??0});
  }
  if(service==="vision") {
    const response=await probe(port!,"/health");
    const ownership=await inspectManagedVision(port!);
    const verified=ownership.verified===true;
    return snap(service,port,!response?"inactive":
      verified?(response.body?.model_loaded?"active":"degraded"):"unverified",
      verified?ownership.ownerPid??null:owner,verified,
      verified?["status","plan","stop","restart"]:["status"],
      verified?"Managed Vision owner with authenticated local health and kernel PID":
      !response?"Vision helper not responding":
      "Core-spawned or unverified Vision server; do not adopt or kill",
      response?{httpStatus:response.status,modelLoaded:response.body?.model_loaded===true,
        activeRequests:ownership.activeRequests??null}:undefined);
  }
  if(service==="guardian") {
    const managed=await inspectManagedGuardian(port!);
    const lease=readCoreGuardianLease(port!);
    return snap(service,port,
      managed.verified?"active":lease?"unverified":"inactive",
      managed.ownerPid??lease?.pid??null,managed.verified,
      managed.verified?["status","plan","restart","stop"]:["status"],
      managed.verified?"Authenticated independent Core Guardian watchdog":
        managed.reason??"No authenticated Guardian owner",
      {clientMode:lease?.clientMode??null,coreSupervisorPid:lease?.supervisorPid??null,
        managed:managed.verified,coreUnaffected:true});
  }
  if(service==="rest_tunnel"||service==="muse_tunnel") {
    // A public URL or a Cloudflare registry record is NOT a verified owner.
    // In particular, the local backend's listening PID is not cloudflared's PID.
    const {listActiveTunnels,isOwnQuickTunnelProcess}=await import("../remoteAgent/cloudflareTunnel.js");
    const serviceKind=service==="rest_tunnel"?"superagent-http":"muse-websocket";
    const tunnel=listActiveTunnels().find(x=>x.serviceKind===serviceKind&&x.port===port);
    const verified=tunnel?await isOwnQuickTunnelProcess(tunnel.pid,tunnel.localUrl):false;
    return snap(service,port,tunnel?(verified?"active":"unverified"):"inactive",
      tunnel?.pid??null,verified,verified?["status","plan","stop"]:["status"],
      verified?"Exactly identified local cloudflared owner; destructive stop still needs separate public-disruption approval":
        tunnel?"Tunnel metadata exists but process ownership cannot be independently confirmed":
        "No registered Cloudflare tunnel of this kind",
      tunnel?{publicUrl:tunnel.publicUrl,registeredTunnelPid:tunnel.pid,
        localBackendListenerPid:owner,kind:serviceKind}:undefined);
  }
  if(service==="daemon") {
    const status=await inspectDaemonScheduler(port!);
    return snap(service,port,
      status.verified?(status.running?"active":"embedded"):"unverified",
      status.verified?status.workerPid??null:null,status.verified,
      status.verified?["status","plan","start","stop","restart"]:["status"],
      status.reason,
      {embeddedInCore:true,running:status.verified?status.running:null,
        activeJobs:status.activeJobs??null,totalJobs:status.totalJobs??null,
        coreSupervisorPid:status.supervisorPid??null});
  }
  if(service==="tray")
    return snap(service,undefined,"unknown",null,false,["status"],
      "Tauri Tray is a desktop application, not a network server; use its native controls");
  if(service==="process_supervisor")
    return snap(service,undefined,"embedded",null,false,["status"],
      "Process Supervisor is an internal registry, not a standalone service");
  return snap(service,port,owner?"unverified":"unknown",owner,false,["status"],
    "Public tunnel must be managed via its dedicated owner; listener PID is not shutdown authorization");
}
export async function inspectServices(service:ManagedServiceName|"all"="all",port?:number) {
  const names=service==="all"?MANAGED_SERVICE_NAMES:[service];
  const listeners=readListenerOwners();
  return Promise.all(names.map(async name=>{
    try {
      const selected=service==="all"||port===undefined?defaultPorts[name]:port;
      return await inspectOne(name,selected,listeners);
    }catch(e) {
      return snap(name,defaultPorts[name],"unknown",null,false,["status"],
        "Inspection failed: "+(e instanceof Error?e.message:"unknown").slice(0,120));
    }
  }));
}

async function planMcpReload(port:number) {
  const current=(await inspectServices("mcp",port))[0];
  if(!current.ownershipVerified||current.details?.reloadable!==true)
    throw new Error("SERVICE_MCP_LEGACY_OR_UNVERIFIED: no URL-safe hot reload");
  const state=readMcpStateFile(getMcpStateFile(port));
  if(!state?.publicUrl)throw new Error("SERVICE_MCP_STATE_MISSING");
  return {service:"mcp",action:"reload",port,
    operationId:crypto.randomUUID(),expectedOwnerPid:state.pid,
    expectedPublicUrl:state.publicUrl,
    note:"Verified backend-only reload; public Cloudflare URL must remain unchanged"};
}
export async function manageServices(raw:unknown):Promise<unknown> {
  const args=validateManageServicesArgs(raw);
  const action=args.action,service=args.service??"all";
  const port=service==="all" ? undefined :
    (args.port!==undefined || defaultPorts[service]!==undefined)
      ? validateServicePort(args.port,defaultPorts[service])
      : undefined;
  if(action==="status"||action==="inventory"||action==="doctor")
    return {action,readOnly:true,services:await inspectServices(service,port),
      note:"Only owner-authenticated processes may be modified; public tunnel URLs are never rotated."};
  if(action==="plan") {
    if(service==="core"&&
      (args.targetAction==="restart"||args.targetAction==="rollback"||args.targetAction==="drain")) {
      const status=(await inspectServices("core",port))[0];
      if(process.platform==="win32"&&!status.ownershipVerified)
        throw new Error("SERVICE_CORE_KERNEL_OWNER_UNVERIFIED");
      return {service,...await prepareCoreLifecycle(args.targetAction,port!)};
    }
    if(service==="mcp"&&args.targetAction==="reload")return planMcpReload(port!);
    if(service==="daemon"&&(args.targetAction==="start"||
       args.targetAction==="stop"||args.targetAction==="restart"))
      return planDaemonLifecycle(args.targetAction,port!);
    if(service==="guardian"&&(args.targetAction==="start"||
       args.targetAction==="stop"||args.targetAction==="restart"))
      return planManagedGuardian(args.targetAction,port!);
    if(service==="vision"&&(args.targetAction==="start"||
       args.targetAction==="stop"||args.targetAction==="restart"))
      return planManagedVision(args.targetAction,port!);
    if((service==="rest_tunnel"||service==="muse_tunnel")&&args.targetAction==="stop")
      return planOwnedTunnelStop(service,port!);
    if(["transport","channel_host","muse","telegram"].includes(service)&&
       (args.targetAction==="start"||args.targetAction==="stop"||args.targetAction==="restart"))
      return planSidecarService({
        service:service as SidecarService,action:args.targetAction,port:port!,
        corePort:args.corePort,channelMode:args.channelMode,wsPort:args.wsPort,
      });
    return {service,port,action:"plan",targetAction:args.targetAction??null,
      allowed:false,supportedActions:(await inspectServices(service,port))[0].actions,
      reason:"SERVICE_UNSUPPORTED_MUTATION: no authenticated remote lifecycle protocol; no PID kill or tunnel restart will be attempted"};
  }
  if(args.confirm!==true)throw new Error("SERVICE_CONFIRM_REQUIRED");
  if(service==="core"&&(action==="restart"||action==="rollback"||action==="drain")) {
    if(!args.operationId||!args.expectedBuildDigest)
      throw new Error("SERVICE_CORE_PLAN_REQUIRED: call action=plan first");
    const status=(await inspectServices("core",port))[0];
    if(process.platform==="win32"&&!status.ownershipVerified)
      throw new Error("SERVICE_CORE_KERNEL_OWNER_UNVERIFIED");
    return {service,...await controlCoreLifecycle(action,port!,true,undefined,
      {operationId:args.operationId,expectedBuildDigest:args.expectedBuildDigest})};
  }
  if(["transport","channel_host","muse","telegram"].includes(service)&&
     (action==="start"||action==="stop"||action==="restart")) {
    if(!args.operationId||args.expectedOwnerPid===undefined||
       !args.expectedInstanceId||args.noPublicIngress!==true)
      throw new Error("SERVICE_SIDECAR_PLAN_REQUIRED: run action=plan first");
    return executeSidecarService({
      service:service as SidecarService,action,port:port!,confirm:true,
      operationId:args.operationId,expectedOwnerPid:args.expectedOwnerPid,
      expectedInstanceId:args.expectedInstanceId,noPublicIngress:true,
      corePort:args.corePort,channelMode:args.channelMode,wsPort:args.wsPort,
      note:"Approved owner-attested sidecar lifecycle operation",
    });
  }
  if((service==="rest_tunnel"||service==="muse_tunnel")&&action==="stop"){
    if(!args.operationId||!args.expectedOwnerPid||!args.expectedPublicUrl||
       !args.expectedLocalUrl||args.allowPublicDisruption!==true)
      throw new Error("SERVICE_PUBLIC_TUNNEL_STOP_PLAN_AND_ACK_REQUIRED");
    return stopOwnedTunnel({
      service,port:port!,confirm:true,operationId:args.operationId,
      expectedOwnerPid:args.expectedOwnerPid,
      expectedPublicUrl:args.expectedPublicUrl,
      expectedLocalUrl:args.expectedLocalUrl,
      allowPublicDisruption:true,
    });
  }
  if(service==="daemon"&&(action==="start"||action==="stop"||action==="restart")){
    if(!args.operationId||!args.expectedSupervisorPid||
       !args.expectedWorkerPid||typeof args.expectedRunning!=="boolean"||
       args.noActiveJobs!==true)
      throw new Error("SERVICE_DAEMON_PLAN_REQUIRED");
    return executeDaemonLifecycle({
      service:"daemon",action,port:port!,confirm:true,
      operationId:args.operationId,
      expectedSupervisorPid:args.expectedSupervisorPid,
      expectedWorkerPid:args.expectedWorkerPid,
      expectedRunning:args.expectedRunning,
      noActiveJobs:true,note:"Verified in-process Core scheduler only",
    });
  }
  if(service==="guardian"&&(action==="start"||action==="stop"||action==="restart")){
    if(!args.operationId||args.expectedOwnerPid===undefined||
       !args.expectedInstanceId||!args.expectedSupervisorPid||
       args.noCoreShutdown!==true)
      throw new Error("SERVICE_GUARDIAN_PLAN_REQUIRED");
    return executeManagedGuardian({
      service:"guardian",action,port:port!,operationId:args.operationId,
      expectedOwnerPid:args.expectedOwnerPid,
      expectedInstanceId:args.expectedInstanceId,
      expectedSupervisorPid:args.expectedSupervisorPid,
      noCoreShutdown:true,confirm:true,note:"Guardian watchdog only, Core unaffected",
    });
  }
  if(service==="vision"&&(action==="start"||action==="stop"||action==="restart")){
    if(!args.operationId||args.expectedOwnerPid===undefined||
       !args.expectedInstanceId||args.noPublicIngress!==true)
      throw new Error("SERVICE_VISION_PLAN_REQUIRED");
    return executeManagedVision({
      service:"vision",action,port:port!,operationId:args.operationId,
      expectedOwnerPid:args.expectedOwnerPid,expectedInstanceId:args.expectedInstanceId,
      noPublicIngress:true,confirm:true,note:"Explicitly managed Vision instance only",
    });
  }
  if(service==="mcp"&&action==="reload") {
    if(!args.operationId||!args.expectedPublicUrl||!args.expectedOwnerPid)
      throw new Error("SERVICE_MCP_PLAN_REQUIRED: call action=plan targetAction=reload first");
    const state=readMcpStateFile(getMcpStateFile(port!));
    if(state?.pid!==args.expectedOwnerPid||state.publicUrl!==args.expectedPublicUrl)
      throw new Error("SERVICE_MCP_OWNER_OR_URL_CHANGED");
    const lease=readManagedMcpTunnelLease(port!);
    if(!lease||lease.pid!==state.pid||state.reloadable!==true)
      throw new Error("SERVICE_MCP_OWNER_NOT_RELOADABLE");
    await verifyManagedOwnerIdentity(lease,{timeoutMs:2500});
    const store=new McpServiceReloadLedger(port!);
    const op=store.begin({operationId:args.operationId,ownerPid:state.pid,
      publicUrl:state.publicUrl});
    if(op.replayed) {
      const now=readMcpStateFile(getMcpStateFile(port!));
      if(now?.pid!==state.pid||now.publicUrl!==state.publicUrl)
        throw new Error("SERVICE_MCP_REPLAY_OWNER_CHANGED");
      return {service,action,port,replayed:true,changed:false,
        ownerPid:state.pid,backendPid:op.backendPid,publicUrl:now.publicUrl};
    }
    try {
      const updated=await reloadManagedMcpTunnelBackend(port!);
      if(updated.publicUrl!==args.expectedPublicUrl)
        throw new Error("SERVICE_MCP_PUBLIC_URL_CHANGED");
      store.complete(args.operationId,updated.backendPid);
      return {service,action,replayed:false,changed:true,ownerPid:state.pid,...updated};
    }catch(e) {
      // Uncertain requests must never automatically trigger another reload.
      throw new Error("SERVICE_MCP_RELOAD_UNCERTAIN: "+
        (e instanceof Error?e.message:"reload failed"));
    }
  }
  throw new Error("SERVICE_UNSUPPORTED_MUTATION: no verified owner-scoped control path for "+
    service+" "+action+"; processes and tunnels were not changed");
}
