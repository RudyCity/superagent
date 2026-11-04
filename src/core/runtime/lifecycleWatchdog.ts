/**
 * Opt-in, fail-closed watchdog reconciliation and single-operation recovery.
 * Automatic recovery is strictly limited to ABSENT, locally owned sidecars;
 * never restarts running sessions, Core, MCP, tunnels or unmanaged UI.
 */
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {getRootConfigDir} from "../config/paths.js";
import {readLifecycleSettings,canAutoRecover} from "./lifecycleProfiles.js";
import {MANAGED_SERVICE_NAMES,type ManagedServiceName} from "./serviceManagerTypes.js";

type Entry={
  failures:number; checkedAt:number; attempts:number[];
  lastHealthyAt?:number;
  bootMarker?:number;bootAttempted?:boolean;
  pendingOperationHash?:string; pendingSince?:number;
};
type State={version:1;entries:Partial<Record<ManagedServiceName,Entry>>};
const hash=(id:string)=>crypto.createHash("sha256").update(id).digest("hex");
const WATCHED=new Set<ManagedServiceName>([
  "transport","channel_host","vision","guardian","tray",
]);
const port:Partial<Record<ManagedServiceName,number>>={
  transport:7891,channel_host:7892,vision:8095,guardian:7888,
};
export const watchdogStatePath=(root=getRootConfigDir())=>
  path.join(root,"lifecycle-watchdog-state.json");
function read(root=getRootConfigDir()):State {
  const file=watchdogStatePath(root);
  let text:string;
  try{
    const st=fs.lstatSync(file);
    if(!st.isFile()||st.isSymbolicLink()||st.size>16000)
      throw new Error("LIFECYCLE_WATCHDOG_UNSAFE_FILE");
    text=fs.readFileSync(file,"utf8");
  }catch(e){
    if((e as NodeJS.ErrnoException).code==="ENOENT")
      return {version:1,entries:{}};
    throw e;
  }
  const state=JSON.parse(text) as State;
  if(state.version!==1||!state.entries||typeof state.entries!=="object"||
     Object.keys(state.entries).some(x=>!MANAGED_SERVICE_NAMES.includes(x as ManagedServiceName)))
    throw new Error("LIFECYCLE_WATCHDOG_CORRUPT");
  for(const value of Object.values(state.entries)){
    if(!value||!Number.isSafeInteger(value.failures)||value.failures<0||
       !Number.isSafeInteger(value.checkedAt)||!Array.isArray(value.attempts)||
       value.attempts.length>64||value.attempts.some(x=>!Number.isSafeInteger(x)||x<0)||
       (value.bootMarker!==undefined&&(!Number.isSafeInteger(value.bootMarker)||value.bootMarker<0))||
       (value.bootAttempted!==undefined&&typeof value.bootAttempted!=="boolean")||
       (value.pendingOperationHash!==undefined&&
        !/^[a-f0-9]{64}$/.test(value.pendingOperationHash)))
      throw new Error("LIFECYCLE_WATCHDOG_CORRUPT");
  }
  return state;
}
function write(state:State,root=getRootConfigDir()){
  const file=watchdogStatePath(root),dir=path.dirname(file);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if(fs.lstatSync(dir).isSymbolicLink())throw new Error("LIFECYCLE_WATCHDOG_DIRECTORY_UNSAFE");
  const tmp=file+"."+crypto.randomBytes(7).toString("hex")+".tmp";
  try{
    const fd=fs.openSync(tmp,"wx",0o600);
    try{fs.writeFileSync(fd,JSON.stringify(state));fs.fsyncSync(fd);}
    finally{fs.closeSync(fd);}
    fs.renameSync(tmp,file);
  }finally{try{fs.rmSync(tmp,{force:true});}catch{}}
}
const healthy=(x:{state:string;ownershipVerified:boolean})=>
  x.state==="active"||x.state==="embedded";
export async function runLifecycleWatchdog(options:{
  execute?:boolean;now?:number;root?:string;service?:ManagedServiceName;
}={}){
  const root=options.root??getRootConfigDir(),now=options.now??Date.now();
  const mutex=watchdogStatePath(root)+".guard";
  let mutexFd:number|undefined;
  if(options.execute){
    fs.mkdirSync(path.dirname(mutex),{recursive:true,mode:0o700});
    if(fs.lstatSync(path.dirname(mutex)).isSymbolicLink())
      throw new Error("LIFECYCLE_WATCHDOG_UNSAFE_DIRECTORY");
    try{mutexFd=fs.openSync(mutex,"wx",0o600);}
    catch{throw new Error("LIFECYCLE_WATCHDOG_CONCURRENT_OR_ORPHAN_LOCK");}
  }
  try{
  const policy=readLifecycleSettings(root);
  const state=read(root);
  const {inspectServices,manageServices}=await import("./serviceManager.js");
  const observed=await inspectServices("all");
  const byName=new Map(observed.map(x=>[x.service,x]));
  const reports:Record<string,unknown>[]=[];
  // An apply tick is permitted only by explicit caller consent AND the
  // saved profile; default profile auto-recovery is disabled for every service.
  for(const item of policy.profiles){
    if(!WATCHED.has(item.service)||options.service&&item.service!==options.service)continue;
    const current=byName.get(item.service)!;
    const entry:Entry=state.entries[item.service]??{
      failures:0,checkedAt:0,attempts:[],
    };
    const bootMarker=Math.floor((Date.now()-os.uptime()*1000)/60000);
    if(entry.bootMarker!==bootMarker){
      entry.bootMarker=bootMarker;entry.bootAttempted=false;
    }
    const withinWindow=entry.attempts.filter(t=>t>now-3600*1000&&t<=now);
    const dependenciesReady=item.dependsOn.every(dep=>{
      const s=byName.get(dep);
      return Boolean(s&&healthy(s)&&s.ownershipVerified);
    });
    if(entry.pendingOperationHash){
      reports.push({service:item.service,state:current.state,
        action:"blocked_pending_operator_review",failures:entry.failures});
      continue;
    }
    if(now-entry.checkedAt<item.intervalSeconds*1000){
      reports.push({service:item.service,state:current.state,action:"interval_not_elapsed"});
      continue;
    }
    const missing=current.state==="inactive"&&current.ownerPid===null;
    const firstBootAttempt=item.startOnBoot&&!entry.bootAttempted;
    const willStart=missing&&dependenciesReady&&
      (firstBootAttempt||canAutoRecover(item,entry.failures+1,withinWindow.length));
    const permitted=willStart&&withinWindow.length<item.maxRestartsPerHour;
    if(!options.execute){
      reports.push({service:item.service,state:current.state,
        candidate:permitted,reason:!missing?"not_absent":
          !dependenciesReady?"dependency_unready":
          permitted?"requires_explicit_apply":"policy_disabled_or_threshold"});
      continue;
    }
    entry.checkedAt=now;
    if(item.startOnBoot&&missing)entry.bootAttempted=true;
    if(healthy(current)){
      entry.failures=0;entry.lastHealthyAt=now;
    }else if(missing)entry.failures=Math.min(1000,entry.failures+1);
    state.entries[item.service]={...entry,attempts:withinWindow};
    write(state,root);
    if(!permitted){
      reports.push({service:item.service,state:current.state,
        action:"observed_only",failures:entry.failures});
      continue;
    }
    let opId:string|undefined;
    try{
      // The existing owner's validated plan binds target port, code identity
      // and dependency state. Never use PID-kill, shell, or a public tunnel.
      const plan=await manageServices({
        action:"plan",service:item.service,targetAction:"start",
        ...(port[item.service]?{port:port[item.service]}:{}),
      }) as Record<string,unknown>;
      if(typeof plan.operationId!=="string")
        throw new Error("LIFECYCLE_WATCHDOG_PLAN_MISSING_OPERATION_ID");
      opId=plan.operationId;
      entry.pendingOperationHash=hash(opId);
      entry.pendingSince=now;
      write(state,root); // Durable BEFORE any mutating request.
      const safeKeys=new Set([
        "service","action","port","operationId","expectedOwnerPid",
        "expectedInstanceId","noPublicIngress","corePort","channelMode",
        "wsPort","expectedBuildDigest","expectedSupervisorPid","noCoreShutdown",
      ]);
      const call:Record<string,unknown>={confirm:true};
      for(const [key,value] of Object.entries(plan))
        if(safeKeys.has(key))call[key]=value;
      const result=await manageServices(call);
      entry.pendingOperationHash=undefined;entry.pendingSince=undefined;
      entry.failures=0;entry.attempts=[...withinWindow,now];
      write(state,root);
      reports.push({service:item.service,action:"started",result});
    }catch(e){
      // If the plan itself failed before reserving an operation, it is safe
      // to retry a future health observation. If reserved, it stays pending.
      reports.push({service:item.service,action:"blocked_or_uncertain",
        operationHashPrefix:opId?hash(opId).slice(0,16):undefined,
        reason:(e instanceof Error?e.message:"LIFECYCLE_WATCHDOG_FAILED").slice(0,160)});
    }
  }
  return {readOnly:!options.execute,automatedStartOptIn:true,
    checkedAt:now,services:reports};
  }finally{
    if(mutexFd!==undefined){
      fs.closeSync(mutexFd);
      try{fs.rmSync(mutex,{force:true});}catch{}
    }
  }
}
export function reviewWatchdogPending(service:ManagedServiceName,id:string,root=getRootConfigDir()){
  const state=read(root),entry=state.entries[service];
  if(!entry||entry.pendingOperationHash!==hash(id))
    throw new Error("LIFECYCLE_WATCHDOG_PENDING_ID_MISMATCH");
  entry.pendingOperationHash=undefined;entry.pendingSince=undefined;
  entry.failures=0;entry.checkedAt=Date.now();
  write(state,root);
}
