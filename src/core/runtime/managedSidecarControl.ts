/**
 * Owner-attested start/stop/restart for separate T-Line transport and
 * Muse/Telegram channel hosts. NEVER adopt an unsupervised/foreign server.
 * Core, MCP, Cloudflare, Vision, Tray and Guardian are not process-killed here.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {getPackageRootDir} from "../config/paths.js";
import {inspectCoreBuild} from "./coreBuildIdentity.js";
import {readListenerOwners} from "./coreMcpOwnershipAudit.js";
import {
  readTransportOwner,requestTransportStop,transportOwnerPath,
} from "./transportHost.js";
import {
  readChannelHostDiscovery,requestChannelHostStop,
  type ChannelHostHealth,type ChannelHostMode,validateChannelHostMode,
} from "./channelHost.js";
import {loadRemoteAgentConfig} from "../remoteAgent/config.js";
import {listActiveTunnels} from "../remoteAgent/cloudflareTunnel.js";
import {ManagedSidecarLedger,sidecarOperationFingerprint} from "./managedSidecarLedger.js";
import {validateCoreOperationId} from "./coreLifecycleLedger.js";

export type SidecarService="transport"|"channel_host"|"muse"|"telegram";
export type SidecarOperation="start"|"stop"|"restart";
export type SidecarPlan={
  service:SidecarService;action:SidecarOperation;port:number;
  operationId:string;expectedOwnerPid:number;expectedInstanceId:string;
  corePort?:number; channelMode?:ChannelHostMode; wsPort?:number;
  noPublicIngress:true; note:string;
};
function validPort(p:number){
  return Number.isSafeInteger(p)&&p>=1024&&p<=65535&&![7888,8857,9227,9225].includes(p);
}
function ownerFile(kind:"transport"|"channel_host",port:number){
  return kind==="transport"?transportOwnerPath(port):
    path.join(os.homedir(),".superagent-r","channel-host-"+port+".json");
}
function kind(service:SidecarService){
  return service==="transport"?"transport" as const:"channel_host" as const;
}
async function health(service:SidecarService,port:number){
  try {
    const endpoint=service==="transport"?"/_transport/health":"/_channel/health";
    const response=await fetch("http://127.0.0.1:"+port+endpoint,{
      signal:AbortSignal.timeout(1500),redirect:"error",
    });
    if(!response.ok)return null;
    const data=await response.json() as any;
    if(service==="transport")
      return data.service==="superagent-transport-host"&&data.publicPort===port?data:null;
    return data.service==="superagent-channel-host"&&data.port===port?data:null;
  }catch{return null;}
}
function modeOf(service:SidecarService,input?:ChannelHostMode):ChannelHostMode {
  if(service==="muse")return "muse-ws";
  if(service==="telegram")return "telegram-fallback";
  return input??"idle";
}
function blockIngress(service:SidecarService,port:number,wsPort=9225) {
  const targets=service==="transport"?[port]:[port,wsPort];
  const affected=listActiveTunnels().filter(t=>targets.includes(t.port));
  if(affected.length)throw new Error("SIDECAR_PUBLIC_TUNNEL_ATTACHED: refuse to interrupt an exposed endpoint");
}
async function verifiedCurrent(service:SidecarService,port:number) {
  const k=kind(service);
  const registered=k==="transport"?readTransportOwner(port):readChannelHostDiscovery(port);
  const live=await health(service,port);
  const actualPid=readListenerOwners()?.get(port);
  if(!live||live.pid!==registered!.pid||actualPid!==registered!.pid||
     registered!.instanceId!==live.instanceId)
    throw new Error("SIDECAR_OWNER_UNVERIFIED: private lease, kernel PID and health must agree");
  if(service==="muse"&&live.mode!=="muse-ws"||
     service==="telegram"&&live.mode!=="telegram-fallback")
    throw new Error("SIDECAR_CHANNEL_MODE_MISMATCH");
  return {registered:registered!,live};
}
function preflightIdle(service:SidecarService,port:number,live:any) {
  if(service==="transport"){
    if(live.activeHttpRequests!==0||live.upgradedSockets!==0||live.draining)
      throw new Error("SIDECAR_TRANSPORT_ACTIVE_STREAMS");
  }else if(live.taskActive||live.draining||
      (live.reconciliationPending??0)>0||
      (live.interruptedCallBatches??0)>0||
      (live.recoveryIntegrityBlocked??0)>0||
      (live.recoveryManualReconciliation??0)>0||
      (live.resultOutboxStored??0)>0)
    throw new Error("SIDECAR_CHANNEL_ACTIVE_TASK_OR_RECOVERY");
}
async function ensureVacant(service:SidecarService,port:number) {
  if(fs.existsSync(ownerFile(kind(service),port)))
    throw new Error("SIDECAR_STALE_OR_ACTIVE_OWNER_RECORD: manual owner audit required");
  if(readListenerOwners()?.has(port))
    throw new Error("SIDECAR_PORT_ALREADY_OWNED: no foreign process adoption");
  // On platforms where kernel enumeration is unavailable, bind-test without
  // listening publicly. This still never adopts an existing process.
  const net=await import("node:net");
  await new Promise<void>((resolve,reject)=>{
    const server=net.createServer();
    server.once("error",()=>reject(new Error("SIDECAR_PORT_NOT_VACANT")));
    server.listen({port,host:"127.0.0.1"},()=>{
      server.close(err=>err?reject(err):resolve());
    });
  });
}
export async function planSidecarService(options:{
  service:SidecarService;action:SidecarOperation;port:number;
  corePort?:number;wsPort?:number;channelMode?:ChannelHostMode;
}):Promise<SidecarPlan> {
  const {service,action,port}=options;
  if(!validPort(port)||!["start","stop","restart"].includes(action))
    throw new Error("SIDECAR_INVALID_TARGET");
  const corePort=options.corePort??7888,wsPort=options.wsPort??9225;
  const channelMode=modeOf(service,options.channelMode);
  if(service==="transport"&&(!Number.isSafeInteger(corePort)||corePort<1024||
      corePort>65535||corePort===port))
    throw new Error("SIDECAR_CORE_PORT_INVALID");
  if(service!=="transport"&&(!Number.isSafeInteger(wsPort)||wsPort<1024||
      wsPort>65535||wsPort===port))
    throw new Error("SIDECAR_WS_PORT_INVALID");
  blockIngress(service,port,wsPort);
  let pid=0,instanceId="absent";
  if(action==="start") {
    await ensureVacant(service,port);
    if(service!=="transport")validateChannelHostMode(channelMode,wsPort,loadRemoteAgentConfig());
  }else{
    const {registered,live}=await verifiedCurrent(service,port);
    preflightIdle(service,port,live);
    pid=registered.pid;instanceId=registered.instanceId;
    if(service==="transport" && options.corePort!==undefined&&live.corePort!==corePort)
      throw new Error("SIDECAR_CORE_PORT_CHANGED");
    if(service!=="transport"&& options.channelMode!==undefined&&live.mode!==channelMode)
      throw new Error("SIDECAR_CHANNEL_MODE_CHANGED");
    if(service!=="transport"&&options.wsPort!==undefined&&live.wsPort!==wsPort)
      throw new Error("SIDECAR_WS_PORT_CHANGED");
  }
  return {
    service,action,port,operationId:crypto.randomUUID(),
    expectedOwnerPid:pid,expectedInstanceId:instanceId,
    ...(service==="transport"?{corePort:action==="start"?corePort:
      (await health(service,port))?.corePort}:{channelMode:action==="start"?channelMode:
      (await health(service,port))?.mode,wsPort:action==="start"?wsPort:
      (await health(service,port))?.wsPort}),
    noPublicIngress:true,
    note:"Read-only plan. Explicit approval required; no public tunnel may be attached. Stop/restart requires idle owned service.",
  };
}

export interface SidecarExecutionArgs extends SidecarPlan {confirm:boolean}
function fingerprint(input:SidecarExecutionArgs) {
  return sidecarOperationFingerprint({
    service:input.service,action:input.action,port:input.port,
    expectedOwnerPid:input.expectedOwnerPid,expectedInstanceId:input.expectedInstanceId,
    corePort:input.corePort??null,channelMode:input.channelMode??null,wsPort:input.wsPort??null,
    noPublicIngress:input.noPublicIngress,
  });
}
async function waitVacant(service:SidecarService,port:number) {
  const deadline=Date.now()+11000;
  while(Date.now()<deadline){
    if(!fs.existsSync(ownerFile(kind(service),port)) &&
       !readListenerOwners()?.has(port)){
      await ensureVacant(service,port);
      return;
    }
    await new Promise(r=>setTimeout(r,200));
  }
  throw new Error("SIDECAR_STOP_ACKNOWLEDGED_BUT_LISTENER_REMAINS: inspect owner before retry");
}
async function startOwned(service:SidecarService,port:number,config:SidecarExecutionArgs){
  await ensureVacant(service,port);
  const root=getPackageRootDir();
  const source=path.join(root,"src","cli.tsx");
  const compiled=path.join(root,"dist","cli.js");
  // Build parity is critical for compiled agents, but source development
  // workers run from a pinned local source entry with no shell invocation.
  const useSource=fs.existsSync(source)&&typeof (globalThis as any).Bun!=="undefined";
  const entry=useSource?source:compiled;
  if(!fs.existsSync(entry)||fs.lstatSync(entry).isSymbolicLink())
    throw new Error("SIDECAR_TRUSTED_CLI_ENTRY_MISSING");
  inspectCoreBuild(entry,{requireFreshCompiled:!useSource});
  const args=service==="transport"
    ? [entry,"transport","start","--port",String(port),"--core-port",String(config.corePort??7888)]
    : [entry,"channel-host","serve","--port",String(port),
       "--mode",modeOf(service,config.channelMode),
       "--ws-port",String(config.wsPort??9225)];
  const child=spawn(process.execPath,args,{
    cwd:root,windowsHide:true,detached:true,stdio:"ignore",
    env:{...process.env,SUPERAGENT_TRAY_AUTOSTART:"0",SUPERAGENT_MANAGED_SIDECAR:"1"},
  });
  child.on("error",()=>{});
  child.unref();
  if(!child.pid)throw new Error("SIDECAR_CHILD_PID_MISSING");
  const deadline=Date.now()+22000;
  while(Date.now()<deadline){
    try{
      const current=await verifiedCurrent(service,port);
      if(current.registered.pid!==child.pid)
        throw new Error("SIDECAR_STARTED_FOREIGN_OWNER");
      if(service==="transport"&&current.live.corePort!==config.corePort)
        throw new Error("SIDECAR_START_WRONG_CORE_PORT");
      if(service!=="transport"&&(current.live.mode!==modeOf(service,config.channelMode)||
          current.live.wsPort!==config.wsPort))
        throw new Error("SIDECAR_START_WRONG_CHANNEL_MODE");
      if(service!=="transport" && modeOf(service,config.channelMode)!=="idle" &&
         (current.live.status!=="running"||!current.live.watcherActive)){
        // A configured watcher may still be connecting; leave its owner intact
        // while readiness progresses. No silent replay or duplicate child.
      }else return {pid:child.pid,instanceId:current.registered.instanceId,
        state:current.live.status};
    }catch(e){
      if(String(e).includes("SIDECAR_STARTED_FOREIGN_OWNER")||
         String(e).includes("SIDECAR_START_WRONG_")) {
        // The only PID we can signal is the child spawned by this invocation.
        try{child.kill("SIGTERM");}catch{}
        throw e;
      }
    }
    await new Promise(r=>setTimeout(r,220));
  }
  throw new Error("SIDECAR_START_OUTCOME_UNKNOWN: child may still be running, review PID "+child.pid);
}
export async function executeSidecarService(args:SidecarExecutionArgs) {
  if(args.confirm!==true)throw new Error("SIDECAR_CONFIRM_REQUIRED");
  validateCoreOperationId(args.operationId);
  if(!validPort(args.port)||!["start","stop","restart"].includes(args.action)||
     typeof args.expectedOwnerPid!=="number"||
     !Number.isSafeInteger(args.expectedOwnerPid)||args.expectedOwnerPid<0||
     typeof args.expectedInstanceId!=="string"||
     !(/^[a-f0-9]{32}$/.test(args.expectedInstanceId)||args.expectedInstanceId==="absent")||
     args.noPublicIngress!==true)
    throw new Error("SIDECAR_INVALID_APPROVAL");
  const k=kind(args.service),ledger=new ManagedSidecarLedger(k,args.port);
  const signature=fingerprint(args);
  const replay=ledger.lookup(args.operationId,signature);
  if(replay?.replayed) {
    if(replay.afterPid===0)await ensureVacant(args.service,args.port);
    else{
      const current=await verifiedCurrent(args.service,args.port);
      if(current.registered.pid!==replay.afterPid)
        throw new Error("SIDECAR_REPLAY_OWNER_CHANGED");
    }
    return {service:args.service,action:args.action,port:args.port,
      replayed:true,changed:false,ownerPid:replay.afterPid??null,
      note:"Recorded operation outcome returned; no new process action executed."};
  }
  // If process exits between plan and commit, record stays pending. This
  // protects against duplicated side effects after a timeout or crash.
  if(args.action==="start"){
    if(args.expectedOwnerPid!==0||args.expectedInstanceId!=="absent")
      throw new Error("SIDECAR_START_OWNER_EXPECTATION_MISMATCH");
    blockIngress(args.service,args.port,args.wsPort);
    await ensureVacant(args.service,args.port);
    ledger.begin(args.operationId,signature);
    const started=await startOwned(args.service,args.port,args);
    ledger.complete(args.operationId,started.pid);
    return {service:args.service,action:args.action,port:args.port,
      replayed:false,changed:true,ownerPid:started.pid,...started};
  }
  const current=await verifiedCurrent(args.service,args.port);
  if(current.registered.pid!==args.expectedOwnerPid||
     current.registered.instanceId!==args.expectedInstanceId)
    throw new Error("SIDECAR_OWNER_CHANGED_SINCE_PLAN");
  if(args.service==="transport"&&current.live.corePort!==args.corePort||
     args.service!=="transport"&&(current.live.mode!==args.channelMode||
       current.live.wsPort!==args.wsPort))
    throw new Error("SIDECAR_CONFIGURATION_CHANGED_SINCE_PLAN");
  preflightIdle(args.service,args.port,current.live);
  blockIngress(args.service,args.port,args.wsPort);
  ledger.begin(args.operationId,signature);
  if(k==="transport")await requestTransportStop(args.port,current.registered.pid);
  else await requestChannelHostStop(args.port,current.registered.pid);
  await waitVacant(args.service,args.port);
  if(args.action==="stop"){
    ledger.complete(args.operationId,0);
    return {service:args.service,action:args.action,port:args.port,
      replayed:false,changed:true,ownerPid:null,stoppedPid:current.registered.pid};
  }
  const started=await startOwned(args.service,args.port,args);
  if(started.pid===current.registered.pid)throw new Error("SIDECAR_RESTART_PID_NOT_CHANGED");
  ledger.complete(args.operationId,started.pid);
  return {service:args.service,action:args.action,port:args.port,
    replayed:false,changed:true,ownerPid:started.pid,previousPid:current.registered.pid,
    ...started,note:"Old owned host was idle and stopped before new host was verified. No public tunnel was touched."};
}
