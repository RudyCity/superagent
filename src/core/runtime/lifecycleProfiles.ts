/**
 * Strict declarative lifecycle policy. No user-provided command, path, host,
 * shell or arbitrary tool is ever executed by this configuration.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {getRootConfigDir} from "../config/paths.js";
import {MANAGED_SERVICE_NAMES,type ManagedServiceName} from "./serviceManagerTypes.js";

export type LifecycleProfile = {
  service:ManagedServiceName;
  startOnBoot:boolean;
  autoRecover:boolean;
  maxRestartsPerHour:number;
  failureThreshold:number;
  intervalSeconds:number;
  dependsOn:ManagedServiceName[];
  allowedActions:string[];
};
type Settings={version:1; revision:string; profiles:LifecycleProfile[]; updatedAt:number};
const dependencies:Record<ManagedServiceName,ManagedServiceName[]>={
  core:[],mcp:[],transport:["core"],channel_host:[],
  muse:["channel_host"],telegram:["channel_host"],vision:[],
  guardian:["core"],daemon:["core"],tray:[],
  rest_tunnel:["core"],muse_tunnel:["muse"],
  process_supervisor:[],
};
const allowedActions:Record<ManagedServiceName,string[]>={
  core:["status","restart","rollback","drain","recycle"],
  mcp:["status","reload"],
  transport:["status","start","stop","restart"],
  channel_host:["status","start","stop","restart"],
  muse:["status","start","stop","restart"],
  telegram:["status","start","stop","restart"],
  vision:["status","start","stop","restart"],
  guardian:["status","start","stop","restart"],
  daemon:["status","start","stop","restart"],
  tray:["status","start","stop","restart","upgrade","rollback"],
  rest_tunnel:["status","stop"],
  muse_tunnel:["status","stop"],
  process_supervisor:["status"],
};
const names=new Set(MANAGED_SERVICE_NAMES);
const autoRecoverSupported=new Set<ManagedServiceName>([
  "transport","channel_host","vision","guardian","tray",
]);
const revision=()=>crypto.randomBytes(12).toString("hex");
function defaults():Settings {
  return {version:1,revision:"default",updatedAt:0,
    profiles:MANAGED_SERVICE_NAMES.map(service=>({
      service,startOnBoot:false,autoRecover:false,
      maxRestartsPerHour:2,failureThreshold:3,intervalSeconds:30,
      dependsOn:[...dependencies[service]],
      allowedActions:[...allowedActions[service]],
    }))};
}
export function lifecycleSettingsPath(root=getRootConfigDir()){
  return path.join(root,"lifecycle-service-profiles.json");
}
function assertSettings(x:unknown):asserts x is Settings {
  const value=x as Settings;
  if(!value||value.version!==1||typeof value.revision!=="string"||
    !/^(?:default|[a-f0-9]{24})$/.test(value.revision)||
    !Number.isSafeInteger(value.updatedAt)||value.updatedAt<0||
    !Array.isArray(value.profiles)||value.profiles.length!==MANAGED_SERVICE_NAMES.length)
    throw new Error("LIFECYCLE_PROFILE_INVALID_FILE");
  const seen=new Set<string>();
  for(const item of value.profiles){
    if(!item||!names.has(item.service)||seen.has(item.service)||
       typeof item.startOnBoot!=="boolean"||typeof item.autoRecover!=="boolean"||
       !Number.isSafeInteger(item.maxRestartsPerHour)||item.maxRestartsPerHour<0||
       item.maxRestartsPerHour>6||
       !Number.isSafeInteger(item.failureThreshold)||item.failureThreshold<2||
       item.failureThreshold>12||
       !Number.isSafeInteger(item.intervalSeconds)||item.intervalSeconds<10||
       item.intervalSeconds>300||
       JSON.stringify(item.dependsOn)!==JSON.stringify(dependencies[item.service])||
       JSON.stringify(item.allowedActions)!==JSON.stringify(allowedActions[item.service])||
       (item.autoRecover&&!autoRecoverSupported.has(item.service))||
       (item.startOnBoot&&!autoRecoverSupported.has(item.service))||
       (item.startOnBoot&&["mcp","rest_tunnel","muse_tunnel"].includes(item.service)))
      throw new Error("LIFECYCLE_PROFILE_UNSAFE_SETTING");
    seen.add(item.service);
  }
}
export function readLifecycleSettings(root=getRootConfigDir()):Settings {
  const file=lifecycleSettingsPath(root);
  let stat:fs.Stats;
  try{stat=fs.lstatSync(file);}catch(e){
    if((e as NodeJS.ErrnoException).code==="ENOENT")return defaults();
    throw e;
  }
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>16000)
    throw new Error("LIFECYCLE_PROFILE_UNSAFE_FILE");
  const state=JSON.parse(fs.readFileSync(file,"utf8"));
  assertSettings(state);
  return state;
}
function configureLifecycleProfileUnsafe(input:{
  service:ManagedServiceName;revision:string;startOnBoot?:boolean;
  autoRecover?:boolean;maxRestartsPerHour?:number;
  failureThreshold?:number;intervalSeconds?:number;
},root=getRootConfigDir()):Settings {
  if(!names.has(input.service)||typeof input.revision!=="string")
    throw new Error("LIFECYCLE_PROFILE_INVALID_REQUEST");
  const before=readLifecycleSettings(root);
  if(before.revision!==input.revision)
    throw new Error("LIFECYCLE_PROFILE_REVISION_CONFLICT");
  const old=before.profiles.find(x=>x.service===input.service)!;
  const next={...old};
  for(const key of ["startOnBoot","autoRecover","maxRestartsPerHour",
    "failureThreshold","intervalSeconds"] as const){
    const value=input[key];
    if(value!==undefined)(next as any)[key]=value;
  }
  const after:Settings={version:1,revision:revision(),updatedAt:Date.now(),
    profiles:before.profiles.map(x=>x.service===input.service?next:x)};
  assertSettings(after);
  const dir=path.dirname(lifecycleSettingsPath(root));
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if(fs.lstatSync(dir).isSymbolicLink())throw new Error("LIFECYCLE_PROFILE_UNSAFE_DIRECTORY");
  const file=lifecycleSettingsPath(root);
  const temp=file+"."+crypto.randomBytes(7).toString("hex")+".tmp";
  try{
    const fd=fs.openSync(temp,"wx",0o600);
    try{fs.writeFileSync(fd,JSON.stringify(after,null,2));fs.fsyncSync(fd);}
    finally{fs.closeSync(fd);}
    // revision checked before writing; use one process manager per profile root.
    fs.renameSync(temp,file);
  }finally{try{fs.rmSync(temp,{force:true});}catch{}}
  return after;
}
export function dependencyOrder(profiles:LifecycleProfile[]) {
  const states=new Map<string,0|1|2>(),order:ManagedServiceName[]=[];
  const byName=new Map(profiles.map(x=>[x.service,x]));
  const visit=(service:ManagedServiceName)=>{
    const state=states.get(service)||0;
    if(state===1)throw new Error("LIFECYCLE_DEPENDENCY_CYCLE");
    if(state===2)return;
    const p=byName.get(service);
    if(!p)throw new Error("LIFECYCLE_MISSING_DEPENDENCY");
    states.set(service,1);
    for(const dep of p.dependsOn)visit(dep);
    states.set(service,2);order.push(service);
  };
  for(const item of profiles)visit(item.service);
  return order;
}
export function canAutoRecover(profile:LifecycleProfile,failures:number,restartsLastHour:number){
  return profile.autoRecover&&autoRecoverSupported.has(profile.service)&&
    failures>=profile.failureThreshold&&restartsLastHour<profile.maxRestartsPerHour;
}

/** Single-writer profile update; no lost optimistic revisions across MCP owners. */
export function configureLifecycleProfile(
  input:Parameters<typeof configureLifecycleProfileUnsafe>[0],root=getRootConfigDir()){
  const dir=path.dirname(lifecycleSettingsPath(root));
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if(fs.lstatSync(dir).isSymbolicLink())throw new Error("LIFECYCLE_PROFILE_UNSAFE_DIRECTORY");
  const lock=lifecycleSettingsPath(root)+".guard";
  let fd:number;
  try{fd=fs.openSync(lock,"wx",0o600);}
  catch{throw new Error("LIFECYCLE_PROFILE_CONCURRENT_OR_ORPHAN_LOCK");}
  try{return configureLifecycleProfileUnsafe(input,root);}
  finally{
    fs.closeSync(fd);
    try{fs.rmSync(lock,{force:true});}catch{}
  }
}
