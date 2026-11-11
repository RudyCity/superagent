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
import { readListenerOwners, readMcpStateInventory } from "./coreMcpOwnershipAudit.js";
import { verifyWindowsProcessBirth, type ProcessBirthVerdict } from "./mcpProcessBirth.js";
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
import {
  planManagedTray,executeManagedTray,inspectManagedTray,
  planManagedTrayRelease,executeManagedTrayRelease,legacyTrayProcessPids,
  reviewStaleTrayReceiptWithVerifiedSuccessor,
} from "./managedTrayControl.js";
import {readTrayReleaseState} from "./trayReleaseStore.js";
import {readLifecycleSettings,configureLifecycleProfile,dependencyOrder} from "./lifecycleProfiles.js";
import {readLifecycleEvents,recordLifecycleEvent,operationHashPrefix} from "./lifecycleTimeline.js";
import {ManagedSidecarLedger} from "./managedSidecarLedger.js";
import {trayReconcileLedgerPort} from "./trayReconcileLedgerSelection.js";
import {
  planLegacyCoreRecycle, scheduleLegacyCoreRecycle,
  inspectLegacyCoreRecycleReadiness,
} from "./coreLegacyRecycle.js";
import {planLegacyTrayRecycle,executeLegacyTrayRecycle} from "./trayLegacyRecycle.js";
import {planLegacyVisionRecycle,executeLegacyVisionRecycle} from "./visionLegacyRecycle.js";
import {planGlobalLifecycleRecycle,executeGlobalLifecycleRecycle,reconcileGlobalLifecycleRecycle} from "./globalLifecycleRecycle.js";

import { MANAGED_SERVICE_NAMES, type ManagedServiceName } from "./serviceManagerTypes.js";
export { MANAGED_SERVICE_NAMES, type ManagedServiceName } from "./serviceManagerTypes.js";
export type ServiceAction =
  "inventory"|"status"|"plan"|"restart"|"rollback"|"drain"|"reload"|"start"|"stop"|"doctor"
  |"health"|"dashboard"|"logs"|"profile"|"configure"|"reconcile"|"upgrade"|"watchdog"|"recycle";
export type ManageServicesArgs = {
  action:ServiceAction; service?:ManagedServiceName|"all"; port?:number;
  targetAction?:"restart"|"rollback"|"drain"|"reload"|"start"|"stop"|"upgrade"|"recycle";
  confirm?:boolean; operationId?:string; expectedBuildDigest?:string;
  expectedOwnerPid?:number; expectedPublicUrl?:string;
  expectedProcessIdentity?:string; expectedLegacyCommandDigest?:string; expectedExecutablePath?:string;
  clientMode?:"tline"|"chrome-extension";
  expectedInstanceId?:string; noPublicIngress?:boolean;
  expectedSupervisorPid?:number; noCoreShutdown?:boolean;
  expectedWorkerPid?:number; expectedRunning?:boolean; noActiveJobs?:boolean;
  expectedLocalUrl?:string;allowPublicDisruption?:boolean;
  corePort?:number;channelMode?:"idle"|"muse-ws"|"telegram-fallback";wsPort?:number;
  revision?:string;autoRecover?:boolean;startOnBoot?:boolean;
  failureThreshold?:number;maxRestartsPerHour?:number;intervalSeconds?:number;
  reviewed?:boolean;limit?:number;
  expectedReleaseRevision?:string;
  expectedCurrentDigest?:string|null;
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

/** Use an OS listener and matching owner record, not a hard-coded MCP port. */
export function discoverObservedMcpPort(
  listeners:Map<number,number>|null,
  records:ReadonlyArray<{port:number;pid:number;startedAt?:number}> = readMcpStateInventory().records,
):number {
  if(!listeners)return defaultPorts.mcp!;
  const matches=records.filter(r=>Number.isSafeInteger(r.port)&&
    r.port>=1024&&r.port<=65535&&Number.isSafeInteger(r.pid)&&r.pid>0&&
    listeners.get(r.port)===r.pid);
  if(matches.length===0)return defaultPorts.mcp!;
  matches.sort((a,b)=>(b.startedAt??0)-(a.startedAt??0)||
    Number(b.port===defaultPorts.mcp)-Number(a.port===defaultPorts.mcp)||
    a.port-b.port);
  return matches[0].port;
}
function observedMcpPort(listeners:Map<number,number>|null):number {
  const records=readMcpStateInventory().records.map(r=>({
    ...r,startedAt:readMcpStateFile(getMcpStateFile(r.port))?.startedAt,
  }));
  return discoverObservedMcpPort(listeners,records);
}
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
    "expectedWorkerPid","expectedRunning","noActiveJobs",
    "revision","autoRecover","startOnBoot","failureThreshold",
    "maxRestartsPerHour","intervalSeconds","reviewed","limit",
    "expectedReleaseRevision","expectedCurrentDigest",
    "expectedProcessIdentity","expectedLegacyCommandDigest","clientMode","expectedExecutablePath"]);
  if(Object.keys(v).some(k=>!allowed.has(k)))throw new Error("SERVICE_UNEXPECTED_ARGUMENT");
  if(!["inventory","status","plan","restart","rollback","drain","reload","start","stop","doctor",
    "health","dashboard","logs","profile","configure","reconcile","upgrade","watchdog","recycle"].includes(String(v.action)))
    throw new Error("SERVICE_UNKNOWN_ACTION");
  if(v.service!==undefined&&v.service!=="all"&&
     (typeof v.service!=="string"||!known.has(v.service)))throw new Error("SERVICE_UNKNOWN_TARGET");
  if(v.port!==undefined)validateServicePort(v.port);
  if(v.confirm!==undefined&&typeof v.confirm!=="boolean")throw new Error("SERVICE_INVALID_CONFIRM");
  if(v.targetAction!==undefined&&
     !["restart","rollback","drain","reload","start","stop","upgrade","recycle"].includes(String(v.targetAction)))
    throw new Error("SERVICE_INVALID_TARGET_ACTION");
  if(v.expectedOwnerPid!==undefined&&
     (!Number.isSafeInteger(v.expectedOwnerPid)||Number(v.expectedOwnerPid)<0))
    throw new Error("SERVICE_INVALID_OWNER_PID");
  if(v.expectedProcessIdentity!==undefined&&
     (typeof v.expectedProcessIdentity!=="string"||
      !/^(?:win:\d{15,20}|linux:[a-f0-9-]{36}:\d+)$/.test(v.expectedProcessIdentity)))
    throw new Error("SERVICE_INVALID_PROCESS_IDENTITY");
  if(v.expectedLegacyCommandDigest!==undefined&&
     (typeof v.expectedLegacyCommandDigest!=="string"||!/^[a-f0-9]{64}$/.test(v.expectedLegacyCommandDigest)))
    throw new Error("SERVICE_INVALID_LEGACY_COMMAND_DIGEST");
  if(v.clientMode!==undefined&&!["tline","chrome-extension"].includes(String(v.clientMode)))
    throw new Error("SERVICE_INVALID_CLIENT_MODE");
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
  if(v.expectedReleaseRevision!==undefined&&
     (typeof v.expectedReleaseRevision!=="string"||
      !/^[a-f0-9]{24}$/.test(v.expectedReleaseRevision)))
    throw new Error("SERVICE_TRAY_RELEASE_REVISION_INVALID");
  if(v.expectedCurrentDigest!==undefined&&v.expectedCurrentDigest!==null&&
     (typeof v.expectedCurrentDigest!=="string"||
      !/^[a-f0-9]{64}$/.test(v.expectedCurrentDigest)))
    throw new Error("SERVICE_TRAY_CURRENT_DIGEST_INVALID");
  if(v.revision!==undefined&&(typeof v.revision!=="string"||
     !/^(?:default|[a-f0-9]{24})$/.test(v.revision)))
    throw new Error("SERVICE_PROFILE_INVALID_REVISION");
  for(const key of ["autoRecover","startOnBoot","reviewed"]){
    if(v[key]!==undefined&&typeof v[key]!=="boolean")
      throw new Error("SERVICE_PROFILE_INVALID_BOOLEAN");
  }
  for(const key of ["failureThreshold","maxRestartsPerHour","intervalSeconds","limit"]){
    if(v[key]!==undefined&&(!Number.isSafeInteger(v[key])||Number(v[key])<0||
       Number(v[key])>300))
      throw new Error("SERVICE_PROFILE_INVALID_NUMERIC");
  }
  if((v.service===undefined||v.service==="all")&&
     !["inventory","status","doctor","health","dashboard","logs","profile","watchdog","recycle"].includes(String(v.action))&&
     !(v.action==="plan"&&v.targetAction==="recycle")&&
     !(v.action==="reconcile"))
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

type CoreServerInfoEvidence = {
  port:number;pid:number;authToken:string;startedAt:number;
};
function readCoreServerInfoEvidence(port:number):CoreServerInfoEvidence|null {
  try {
    const file=path.join(getRootConfigDir(),"server-info-"+port+".json");
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<20||stat.size>4096)
      return null;
    const value=JSON.parse(fs.readFileSync(file,"utf8")) as Partial<CoreServerInfoEvidence>;
    if(value.port!==port||!Number.isSafeInteger(value.pid)||Number(value.pid)<=0||
       typeof value.authToken!=="string"||!/^[a-f0-9]{48}$/.test(value.authToken)||
       !Number.isSafeInteger(value.startedAt)||Number(value.startedAt)<=0)return null;
    return value as CoreServerInfoEvidence;
  }catch{return null;}
}
async function authenticatedCorePublicProbe(
  port:number,token:string,
):Promise<boolean>{
  try{
    const response=await fetch("http://127.0.0.1:"+port+"/api/status",{
      method:"GET",headers:{Authorization:"Bearer "+token},
      signal:AbortSignal.timeout(1600),redirect:"error",
    });
    await response.arrayBuffer();
    return response.status===200;
  }catch{return false;}
}
export function acceptsAuthenticatedCoreOwnerFallback(input:{
  platform:string;kernelOwner:number|null;supervisorPid:number;
  serverInfoPid:number|null;birth:ProcessBirthVerdict;publicProbe:boolean;
}):boolean{
  return input.platform==="win32"&&
    (input.kernelOwner===0||input.kernelOwner===null)&&
    Number.isSafeInteger(input.supervisorPid)&&input.supervisorPid>0&&
    input.serverInfoPid===input.supervisorPid&&
    input.birth==="matched"&&input.publicProbe===true;
}

async function inspectOne(service:ManagedServiceName,port:number|undefined,
  listeners:Map<number,number>|null):Promise<ServiceStatus> {
  const owner=port?listeners?.get(port)??null:null;
  if(service==="core") {
    try {
      const s=await requestCoreSupervisor("status",port!,2500);
      let ownerVerified=s.supervisorPid===owner;
      if(!ownerVerified&&(owner===0||owner===null)&&process.platform==="win32"){
        const info=readCoreServerInfoEvidence(port!);
        const birth=info&&info.pid===s.supervisorPid
          ? verifyWindowsProcessBirth(s.supervisorPid,info.startedAt):"unverified";
        const publicProbe=info&&info.pid===s.supervisorPid
          ? await authenticatedCorePublicProbe(port!,info.authToken):false;
        ownerVerified=acceptsAuthenticatedCoreOwnerFallback({
          platform:process.platform,kernelOwner:owner,supervisorPid:s.supervisorPid,
          serverInfoPid:info?.pid??null,birth,publicProbe,
        });
      }
      const verified=s.publicPort===port&&s.ownerContract?.role==="core-supervisor"&&
        s.ownerContract?.mcpLifecycle==="not-owned"&&ownerVerified;
      const buildFresh=s.currentBuild?.fresh??null;
      const state=verified?(buildFresh===false?"degraded":"active"):"unverified";
      return snap(service,port,state,s.supervisorPid,verified,
        verified?["status","plan","restart","rollback","drain"]:["status"],
        verified
          ? buildFresh===false
            ? "Authenticated Core supervisor is serving a stale compiled generation; rebuild/restart recommended"
            : "Authenticated Core supervisor + kernel listener"
          : "Core supervisor identity/kernel listener mismatch",
        {workerPid:s.active.pid,retainedWorkers:s.retained.length,
          sessionCount:s.affinitySessions,buildFresh,
          ownerManagedRecovery:verified?"verified_rollback_monitor":null,
          runtimeWarning:buildFresh===false?"SOURCE_DIST_DRIFT":null,
          kernelListenerPid:owner,
          ownershipEvidence:s.supervisorPid===owner
            ?"kernel_listener_pid"
            : verified?"authenticated_server_info_fallback":null});
    }catch {
      const response=await probe(port!,"/api/status");
      // A failed supervisor probe never proves that an existing listener
      // is inactive or legacy. Require a fresh owner-bound plan to mutate.
      return snap(service,port,owner!==null||response?"unverified":"inactive",owner,false,
        response?["status","plan","recycle"]:["status"],
        response?"Core HTTP responds but supervisor ownership is not currently attested; recycle requires independent preflight":
          owner!==null?"Core listener exists but supervisor attestation is unavailable; mutation blocked":
          "No Core supervisor, listener, or responsive API");
    }
  }
  if(service==="mcp") {
    const registered=readMcpStateFile(getMcpStateFile(port!));
    if(!registered)return snap(service,port,owner?"unverified":"inactive",owner,false,
      ["status"],owner?"Listener exists without MCP owner record":"No registered MCP owner");
    const lease=readManagedMcpTunnelLease(port!);
    let verified=false,reloadable=false,live:any=null;
    if(lease?.pid===registered.pid&&owner===registered.pid) {
      try {
        await verifyManagedOwnerIdentity(lease,{timeoutMs:1100});
        live=await probeManagedMcpTunnelOwner(lease);
        verified=Boolean(live&&live.pid===registered.pid);
        reloadable=verified&&Boolean(live?.reloadable)&&registered.reloadable===true;
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
        listenerPid:owner,reloadable,
        backendPid:live?.backendPid??registered.backendPid??null,
        backendGenerations:live?.backendGenerations??null,
        backendHealthy:live?.backendHealthy??null,
        backendGenerationDetails:Array.isArray(live?.backendGenerationDetails)
          ? live.backendGenerationDetails.slice(0,8):[],
        ownerManagedRecovery:live?.autoRecovery??null});
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
  if(service==="tray"){
    const state=await inspectManagedTray();
    return snap(service,state.controlPort, state.verified?"active":
      state.ownerPid?"unverified":"inactive",state.ownerPid??null,
      state.verified,state.verified?
        ["status","plan","stop","restart"]:["status","plan","start"],
      state.reason,{desktopProcess:true,coreUnaffected:true});
  }
  if(service==="process_supervisor"){
    const {getProcessSupervisor}=await import("../process/processSupervisor.js");
    const report=await getProcessSupervisor().getProcessDiagnostics({
      callerWorkspaceRoot:process.cwd(),
    });
    return snap(service,undefined,report.isCorrupt?"degraded":"embedded",
      null,false,["status","doctor"],
      report.isCorrupt?"Process registry requires operator review":
        "In-process ownership registry; managed process lifecycles are controlled through their individual service owners",
      {workspaceScoped:true,registryCorrupt:report.isCorrupt,
        tracked:report.totalTracked,activeOwned:report.activeOwnedCount,
        historical:report.historicalCount,terminal:report.terminalCount,
        identityMismatch:report.identityMismatchCount,
        unverifiedPid:report.unverifiedPidCount,
        stalePid:report.stalePidCount});
  }
  return snap(service,port,owner?"unverified":"unknown",owner,false,["status"],
    "Public tunnel must be managed via its dedicated owner; listener PID is not shutdown authorization");
}
export async function inspectServices(service:ManagedServiceName|"all"="all",port?:number) {
  const names=service==="all"?MANAGED_SERVICE_NAMES:[service];
  const listeners=readListenerOwners();
  return Promise.all(names.map(async name=>{
    try {
      const selected=service!=="all"&&port!==undefined?port:
        name==="mcp"?observedMcpPort(listeners):defaultPorts[name];
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
async function manageServicesInternal(raw:unknown):Promise<unknown> {
  const args=validateManageServicesArgs(raw);
  const action=args.action,service=args.service??"all";
  const port=service==="all" ? undefined :
    (args.port!==undefined || defaultPorts[service]!==undefined)
      ? validateServicePort(args.port,args.port!==undefined?undefined:
          service==="mcp"?observedMcpPort(readListenerOwners()):defaultPorts[service])
      : undefined;
  if(action==="status"||action==="inventory")
    return {action,readOnly:true,services:await inspectServices(service,port),
      note:"Owner-scoped status; no process/tunnel mutation."};
  if(action==="watchdog"){
    const {runLifecycleWatchdog}=await import("./lifecycleWatchdog.js");
    return runLifecycleWatchdog({
      execute:args.confirm===true,
      ...(service==="all"?{}:{service}),
    });
  }
  if(action==="profile"){
    const state=readLifecycleSettings();
    return {action,readOnly:true,revision:state.revision,updatedAt:state.updatedAt,
      order:dependencyOrder(state.profiles),
      profiles:service==="all"?state.profiles:state.profiles.filter(x=>x.service===service)};
  }
  if(action==="logs"){
    return {action,readOnly:true,
      events:readLifecycleEvents({
        ...(service==="all"?{}:{service}),
        limit:args.limit??50,
      }),
      note:"Bounded metadata only: no tokens, user messages, prompts or raw operation IDs."};
  }
  if(action==="health"||action==="doctor"||action==="dashboard"){
    const states=await inspectServices(service,port);
    const profile=readLifecycleSettings();
    const allStates=service==="all"?states:await inspectServices("all");
    const byName=new Map(allStates.map(x=>[x.service,x]));
    const checks=states.map(item=>{
      const policy=profile.profiles.find(x=>x.service===item.service)!;
      const deps=policy.dependsOn.map(dep=>({service:dep,
        state:byName.get(dep)?.state??"unknown",
        verified:byName.get(dep)?.ownershipVerified??false}));
      const blocked=deps.some(d=>d.state!=="active"&&d.state!=="embedded");
      const available=item.state==="active"||item.state==="embedded"||item.state==="degraded";
      // An unverified listener is not ready even when it responds.
      // The in-process process registry is the only ownerless exception.
      const ready=(item.state==="active"||item.state==="embedded")&&!blocked&&
        (item.ownershipVerified||item.service==="process_supervisor")&&
        (item.service!=="vision"||item.details?.modelLoaded===true)&&
        (item.service!=="transport"||item.details?.backendReady===true);
      const mcpRecoveryDetails=item.details?.ownerManagedRecovery;
      const mcpRecoveryActive=item.service==="mcp"&&
        item.ownershipVerified&&item.details?.reloadable===true&&
        typeof mcpRecoveryDetails==="object"&&mcpRecoveryDetails!==null&&
        "enabled" in mcpRecoveryDetails&&
        (mcpRecoveryDetails as Record<string,unknown>).enabled===true;
      const ownerManagedRecovery=item.service==="core"&&item.ownershipVerified
        ? {enabled:true,strategy:"verified_supervisor_rollback_monitor"}
        : mcpRecoveryActive
          ? {enabled:true,strategy:"reloadable_owner_backend_recovery"}
          : {enabled:false,strategy:null};
      return {service:item.service,state:item.state,ownerVerified:item.ownershipVerified,
        alive:available,ready,dependsOn:deps,dependencyBlocked:blocked,
        reason:item.reason,recoveryPolicy:{
          enabled:policy.autoRecover||ownerManagedRecovery.enabled,
          configuredWatchdog:policy.autoRecover,
          ownerManaged:ownerManagedRecovery,
          threshold:policy.failureThreshold,maxPerHour:policy.maxRestartsPerHour}};
    });
    const answer:any={action,readOnly:true,observedAt:Date.now(),services:states,checks,
      summary:{total:checks.length,ready:checks.filter(x=>x.ready).length,
        degraded:checks.filter(x=>x.alive&&!x.ready).length,
        unavailable:checks.filter(x=>!x.alive).length},
      note:"Monitoring is read-only; configuration does not grant permission to restart a process."};
    if(action==="doctor"&&(service==="core"||service==="all"))
      answer.coreRecycleReadiness = await inspectLegacyCoreRecycleReadiness(
        service==="core"?port:defaultPorts.core,
      );
    if(action==="dashboard"){
      answer.timeline=readLifecycleEvents({limit:args.limit??30});
      answer.dependencyOrder=dependencyOrder(profile.profiles);
      answer.profileRevision=profile.revision;
      answer.trayRelease=readTrayReleaseState();
      // Read-only, fail-closed restart readiness. No operation ID or
      // authorization is returned and no service is stopped or restarted.
      const { inspectSafeLifecycleReadiness, liveSafeLifecycleProvider } =
        await import("./safeLifecycleController.js");
      answer.safeLifecycle = await inspectSafeLifecycleReadiness(
        liveSafeLifecycleProvider, allStates);
    }
    return answer;
  }
  if(action==="configure"){
    if(service==="all"||args.confirm!==true||!args.revision)
      throw new Error("SERVICE_PROFILE_REVISION_AND_CONFIRM_REQUIRED");
    const updated=configureLifecycleProfile({
      service,revision:args.revision,startOnBoot:args.startOnBoot,
      autoRecover:args.autoRecover,maxRestartsPerHour:args.maxRestartsPerHour,
      failureThreshold:args.failureThreshold,intervalSeconds:args.intervalSeconds,
    });
    return {action,service,changed:true,revision:updated.revision,
      profile:updated.profiles.find(x=>x.service===service)};
  }
  if(action==="reconcile"){
    if(args.confirm!==true||args.reviewed!==true)
      throw new Error("SERVICE_RECONCILE_REQUIRES_EXPLICIT_OPERATOR_REVIEW");
    if(service==="tray"&&!args.operationId){
      if(args.targetAction!=="restart"&&args.targetAction!=="upgrade"&&args.targetAction!=="rollback")
        throw new Error("SERVICE_TRAY_STALE_RECONCILE_TARGET_REQUIRED");
      return {service,action,...await reviewStaleTrayReceiptWithVerifiedSuccessor(args.targetAction)};
    }
    if(!args.operationId)
      throw new Error("SERVICE_RECONCILE_REQUIRES_OPERATION_ID");
    if(service==="all")
      return reconcileGlobalLifecycleRecycle(args.operationId,args.reviewed);
    if(service==="core"||service==="mcp"||service==="process_supervisor"||
       service==="rest_tunnel"||service==="muse_tunnel")
      throw new Error("SERVICE_RECONCILE_USE_OWNER_SPECIFIC_PROTOCOL");
    const state=(await inspectServices(service,port))[0];
    if(state.state!=="inactive"||state.ownerPid!==null)
      throw new Error("SERVICE_RECONCILE_OWNER_MUST_BE_VERIFIED_ABSENT");
    // Absence of a verified managed service is not enough: a foreign
    // listener, stale owner lease or legacy process still makes the
    // outcome ambiguous and must never be manually marked reviewed.
    const listeners=readListenerOwners();
    if(port!==undefined&&!listeners)
      throw new Error("SERVICE_RECONCILE_KERNEL_PORT_OWNERSHIP_UNAVAILABLE");
    if(port!==undefined&&listeners?.has(port))
      throw new Error("SERVICE_RECONCILE_PORT_STILL_BOUND");
    if(service==="muse"||service==="telegram")
      throw new Error("SERVICE_RECONCILE_CHANNEL_ALIAS_REQUIRES_EXACT_CHANNEL_HOST_PORT");
    if(service==="channel_host"){
      try {
        (await import("./channelHost.js")).readChannelHostDiscovery(port!);
        throw new Error("SERVICE_RECONCILE_CHANNEL_OWNER_RECORD_PRESENT");
      }catch(e) {
        if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;
      }
    }
    if(service==="transport"&&readTransportOwner(port!))
      throw new Error("SERVICE_RECONCILE_TRANSPORT_OWNER_RECORD_PRESENT");
    if(service==="vision"&&
       fs.existsSync((await import("./managedVisionControl.js")).visionOwnerFile(port!)))
      throw new Error("SERVICE_RECONCILE_VISION_OWNER_RECORD_PRESENT");
    if(service==="tray"&&fs.existsSync(
      path.join(getRootConfigDir(),"tray-lifecycle-owner.json")))
      throw new Error("SERVICE_RECONCILE_TRAY_OWNER_RECORD_PRESENT");
    if(service==="tray"&&legacyTrayProcessPids().length)
      throw new Error("SERVICE_RECONCILE_LEGACY_TRAY_MAY_BE_RUNNING");
    const journalPort=service==="tray"?
      trayReconcileLedgerPort(args.targetAction):port!;
    const ledger=new ManagedSidecarLedger(service,journalPort);
    const result=ledger.reconcile(args.operationId,true,true);
    if(["tray","transport","channel_host","vision","guardian"].includes(service)){
      const {reviewWatchdogPending}=await import("./lifecycleWatchdog.js");
      try{reviewWatchdogPending(service,args.operationId);}
      catch(e){
        if(!(e instanceof Error)||!e.message.includes("PENDING_ID_MISMATCH"))throw e;
      }
    }
    return {service,action,...result};
  }
  if(action==="plan") {
    if((service==="all"||service===undefined)&&args.targetAction==="recycle")
      return planGlobalLifecycleRecycle();
    if(service==="core"&&args.targetAction==="recycle")
      return planLegacyCoreRecycle(port!);
    if(service==="tray"&&args.targetAction==="recycle")
      return planLegacyTrayRecycle(args.expectedOwnerPid);
    if(service==="vision"&&args.targetAction==="recycle")
      return planLegacyVisionRecycle(port!);
    if(service==="core"&&
      (args.targetAction==="restart"||args.targetAction==="rollback"||args.targetAction==="drain")) {
      const status=(await inspectServices("core",port))[0];
      if(process.platform==="win32"&&!status.ownershipVerified)
        throw new Error("SERVICE_CORE_KERNEL_OWNER_UNVERIFIED");
      return {service,...await prepareCoreLifecycle(args.targetAction,port!)};
    }
    if(service==="mcp"&&args.targetAction==="reload")return planMcpReload(port!);
    if(service==="tray"&&(args.targetAction==="upgrade"||
       args.targetAction==="rollback"))
      return planManagedTrayRelease(args.targetAction);
    if(service==="tray"&&(args.targetAction==="start"||
       args.targetAction==="stop"||args.targetAction==="restart")){
      const plan=await planManagedTray(args.targetAction);
      if(port!==undefined&&plan.port!==port)
        throw new Error("SERVICE_TRAY_OWNER_PORT_CHANGED");
      return plan;
    }
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
  if(service==="tray"&&(action==="upgrade"||action==="rollback")){
    if(!args.operationId||!args.expectedBuildDigest||
       !args.expectedReleaseRevision||args.expectedCurrentDigest===undefined||
       args.expectedOwnerPid===undefined||!args.expectedInstanceId||
       args.noCoreShutdown!==true)
      throw new Error("SERVICE_TRAY_RELEASE_PLAN_REQUIRED");
    return executeManagedTrayRelease({
      service:"tray",action,operationId:args.operationId,confirm:true,
      expectedBuildDigest:args.expectedBuildDigest,
      expectedReleaseRevision:args.expectedReleaseRevision,
      expectedCurrentDigest:args.expectedCurrentDigest,
      expectedOwnerPid:args.expectedOwnerPid,
      expectedInstanceId:args.expectedInstanceId,
      ...(port===undefined?{}:{port}),
      noCoreShutdown:true,
      note:"Only content-addressed trusted Tray binary; rollback if launch fails",
    });
  }
  if(service==="tray"&&(action==="start"||action==="stop"||action==="restart")){
    if(!args.operationId||args.expectedOwnerPid===undefined||
       !args.expectedInstanceId||!args.expectedBuildDigest||
       args.noCoreShutdown!==true)
      throw new Error("SERVICE_TRAY_PLAN_REQUIRED");
    return executeManagedTray({
      service:"tray",action,operationId:args.operationId,
      expectedOwnerPid:args.expectedOwnerPid,
      expectedInstanceId:args.expectedInstanceId,
      expectedBuildDigest:args.expectedBuildDigest,
      ...(port!==undefined?{port}:{}),
      noCoreShutdown:true,confirm:true,
      note:"Verified Tray process only, Core/MCP/Muse/tunnel unaffected",
    });
  }
  if(service==="all"&&action==="recycle"){
    if(!args.operationId)
      throw new Error("SERVICE_GLOBAL_RECYCLE_PLAN_REQUIRED");
    const {GlobalRecycleLedger,executeGlobalLifecycleRecycle}=await import('./globalLifecycleRecycle.js');
    const ledger=new GlobalRecycleLedger();
    const plan=ledger.getPlan(args.operationId);
    return executeGlobalLifecycleRecycle(plan,true);
  }
  if(service==="tray"&&action==="recycle"){
    if(!args.operationId||args.expectedOwnerPid===undefined||
       !args.expectedProcessIdentity||!args.expectedBuildDigest||
       args.noCoreShutdown!==true)
      throw new Error("SERVICE_TRAY_RECYCLE_PLAN_REQUIRED");
    return executeLegacyTrayRecycle({
      service:"tray",action:"recycle",operationId:args.operationId,
      expectedOwnerPid:args.expectedOwnerPid,
      expectedProcessIdentity:args.expectedProcessIdentity,
      expectedExecutablePath:args.expectedExecutablePath as string ?? "",
      expectedLegacyDigest:args.expectedCurrentDigest as string ?? args.expectedBuildDigest,
      targetBuildDigest:args.expectedBuildDigest,
      noCoreShutdown:true,
      note:"Guarded Tray legacy recycle",
    },true);
  }
  if(service==="vision"&&action==="recycle"){
    if(!args.operationId||args.expectedOwnerPid===undefined||
       !args.expectedProcessIdentity||!args.expectedBuildDigest||
       args.noPublicIngress!==true)
      throw new Error("SERVICE_VISION_RECYCLE_PLAN_REQUIRED");
    return executeLegacyVisionRecycle({
      service:"vision",action:"recycle",port:port!,operationId:args.operationId,
      expectedOwnerPid:args.expectedOwnerPid,
      expectedProcessIdentity:args.expectedProcessIdentity,
      expectedScriptDigest:args.expectedBuildDigest,
      supportsGracefulShutdown:true,
      noPublicIngress:true,
      note:"Guarded Vision legacy recycle",
    },true);
  }
  if(service==="core"&&action==="recycle") {
    if(!args.operationId||args.expectedOwnerPid===undefined||
       !args.expectedProcessIdentity||!args.expectedLegacyCommandDigest||
       !args.expectedBuildDigest||!args.clientMode)
      throw new Error("SERVICE_CORE_RECYCLE_PLAN_REQUIRED: call action=plan targetAction=recycle first");
    return scheduleLegacyCoreRecycle({
      service:"core",action:"recycle",port:port!,operationId:args.operationId,
      expectedOwnerPid:args.expectedOwnerPid,
      expectedProcessIdentity:args.expectedProcessIdentity,
      expectedLegacyCommandDigest:args.expectedLegacyCommandDigest,
      expectedBuildDigest:args.expectedBuildDigest,clientMode:args.clientMode,
      note:"Guarded legacy Core recycle plan",
    },true);
  }
  if(service==="core"&&(action==="restart"||action==="rollback"||action==="drain")) {
    if(!args.operationId||!args.expectedBuildDigest||
       !args.expectedSupervisorPid||!args.expectedWorkerPid)
      throw new Error("SERVICE_CORE_OWNER_BOUND_PLAN_REQUIRED: obtain a fresh owner-bound plan");
    const status=(await inspectServices("core",port))[0];
    if(process.platform==="win32"&&!status.ownershipVerified)
      throw new Error("SERVICE_CORE_KERNEL_OWNER_UNVERIFIED");
    return {service,...await controlCoreLifecycle(action,port!,true,undefined,
      {operationId:args.operationId,expectedBuildDigest:args.expectedBuildDigest,
       expectedSupervisorPid:args.expectedSupervisorPid,
       expectedWorkerPid:args.expectedWorkerPid})};
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

/** One metadata-only audit envelope for every mutation and preflight. */
export async function manageServices(raw:unknown):Promise<unknown>{
  const args=validateManageServicesArgs(raw);
  if(["status","inventory","doctor","health","dashboard", "profile","logs"].includes(args.action)||
    args.action==="watchdog"&&args.confirm!==true)
    return manageServicesInternal(args);
  const service=args.service??"all",since=Date.now();
  const fields:any={at:since,service:service==="all"?"process_supervisor":service,
    action:args.action,
    ...(args.operationId?{operationHashPrefix:operationHashPrefix(args.operationId)}:{}),
    ...(args.port?{port:args.port}:{})};
  // Preflight prevents unaudited mutation if the private audit journal is unusable.
  recordLifecycleEvent({...fields,outcome:"planned"});
  try{
    const result=await manageServicesInternal(args);
    const data=result as Record<string,any>;
    recordLifecycleEvent({...fields,at:Date.now(),
      durationMs:Math.min(Date.now()-since,3600000),
      outcome:data?.replayed===true?"replayed":"succeeded",
      ...(Number.isSafeInteger(data?.ownerPid)&&data.ownerPid>0?{ownerPid:data.ownerPid}:{}),
      ...(typeof data?.activeBuildDigest==="string"?
        {buildDigestPrefix:data.activeBuildDigest.slice(0,16)}:{})});
    return result;
  }catch(e){
    const message=e instanceof Error?e.message:"SERVICE_FAILED";
    const match=message.match(/[A-Z][A-Z0-9_]{2,63}/);
    recordLifecycleEvent({...fields,at:Date.now(),
      durationMs:Math.min(Date.now()-since,3600000),
      outcome:/UNCERTAIN|PENDING|UNKNOWN|TIMEOUT/.test(message)?"uncertain":"blocked",
      errorCode:match?.[0]??"SERVICE_FAILED"});
    throw e;
  }
}
