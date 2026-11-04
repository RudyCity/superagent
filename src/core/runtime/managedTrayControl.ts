/**
 * Independent SuperAgent Tray lifecycle through its native authenticated
 * loopback control. No taskkill, no process adoption and no Core/tunnel stop.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import {spawn} from "node:child_process";
import {getPackageRootDir,getRootConfigDir} from "../config/paths.js";
import {trayExecutableCandidates} from "./trayAutoLauncher.js";
import {readListenerOwners} from "./coreMcpOwnershipAudit.js";
import {ManagedSidecarLedger,sidecarOperationFingerprint} from "./managedSidecarLedger.js";
import {validateCoreOperationId} from "./coreLifecycleLedger.js";

type Action="start"|"stop"|"restart";
type Owner={version:1;pid:number;instanceId:string;token:string;
  controlPort:number;executablePath:string};
type Plan={service:"tray";action:Action;operationId:string;
  expectedOwnerPid:number;expectedInstanceId:string;
  expectedBuildDigest:string;port?:number;noCoreShutdown:true;
  note:string};
const recordFile=()=>path.join(getRootConfigDir(),"tray-lifecycle-owner.json");
function canonical(file:string) {
  return fs.realpathSync.native(file);
}
function candidates() {
  return trayExecutableCandidates(getPackageRootDir(),getRootConfigDir(),
    process.env.SUPERAGENT_TRAY_EXECUTABLE).filter(file=>{
      try {const st=fs.lstatSync(file);return st.isFile()&&!st.isSymbolicLink()&&
        path.extname(file).toLowerCase()===".exe";}catch{return false;}
    }).map(canonical);
}
function permitted(file:string){
  const canon=canonical(file);
  if(!candidates().some(c=>process.platform==="win32"?
    c.toLowerCase()===canon.toLowerCase():c===canon))
    throw new Error("TRAY_EXECUTABLE_OUTSIDE_TRUSTED_INSTALL");
  return canon;
}
function hashFile(file:string){
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
export function readManagedTrayOwner():Owner|null{
  const file=recordFile();
  let st:fs.Stats;
  try{st=fs.lstatSync(file);}catch(e){
    if((e as NodeJS.ErrnoException).code==="ENOENT")return null;
    throw e;
  }
  if(!st.isFile()||st.isSymbolicLink()||st.size<1||st.size>2048)
    throw new Error("TRAY_OWNER_RECORD_UNSAFE");
  const value=JSON.parse(fs.readFileSync(file,"utf8")) as Owner;
  if(value.version!==1||!Number.isSafeInteger(value.pid)||value.pid<=0||
     !Number.isSafeInteger(value.controlPort)||value.controlPort<1024||
     value.controlPort>65535||
     !/^[a-f0-9]{32}$/.test(value.instanceId)||
     !/^[a-f0-9]{64}$/.test(value.token)||
     typeof value.executablePath!=="string"||
     value.executablePath.length>2048||!path.isAbsolute(value.executablePath))
    throw new Error("TRAY_OWNER_RECORD_INVALID");
  permitted(value.executablePath);
  return value;
}
function verifiedPid(port:number,pid:number){
  return readListenerOwners()?.get(port)===pid;
}
async function probe(owner:Owner){
  const response=await fetch("http://127.0.0.1:"+owner.controlPort+"/tray/health",{
    method:"GET",headers:{"Authorization":"Bearer "+owner.token},
    redirect:"error",signal:AbortSignal.timeout(1500),
  });
  if(!response.ok)throw new Error("TRAY_PRIVATE_HEALTH_FAILED");
  const value=await response.json() as Record<string,unknown>;
  if(value.service!=="superagent-tray"||value.version!==1||
     value.pid!==owner.pid||value.controlPort!==owner.controlPort||
     value.instanceId!==owner.instanceId||value.ownerVerified!==true)
    throw new Error("TRAY_PRIVATE_HEALTH_IDENTITY_MISMATCH");
}
async function verifiedOwner(){
  const owner=readManagedTrayOwner();
  if(!owner||!verifiedPid(owner.controlPort,owner.pid))
    throw new Error("TRAY_NO_VERIFIED_KERNEL_OWNER");
  await probe(owner);
  return owner;
}
export async function inspectManagedTray(){
  let owner:Owner|null=null;
  try{
    owner=readManagedTrayOwner();
    if(!owner)return {verified:false,reason:"No managed Tray owner; legacy instances cannot be adopted"};
    if(!verifiedPid(owner.controlPort,owner.pid))
      throw new Error("Kernel listener owner does not match Tray owner record");
    await probe(owner);
    return {verified:true,ownerPid:owner.pid,controlPort:owner.controlPort,
      reason:"Authenticated native Tray owner; never manages Core/MCP or other processes"};
  }catch(e){
    return {verified:false,ownerPid:owner?.pid??null,
      reason:(e instanceof Error?e.message:"Tray owner unknown").slice(0,180)};
  }
}
async function freePort(port:number){
  await new Promise<void>((resolve,reject)=>{
    const server=net.createServer();
    server.once("error",()=>reject(new Error("TRAY_CONTROL_PORT_NOT_RELEASED")));
    server.listen({port,host:"127.0.0.1"},()=>{
      server.close(err=>err?reject(err):resolve());
    });
  });
}
async function absent(){
  if(fs.existsSync(recordFile()))
    throw new Error("TRAY_OWNER_RECORD_EXISTS: do not adopt a legacy or stale owner");
}
function chooseBinary(){
  const paths=candidates();
  if(!paths.length)throw new Error("TRAY_TRUSTED_EXECUTABLE_NOT_INSTALLED");
  return paths[0];
}
export async function planManagedTray(action:Action):Promise<Plan>{
  let pid=0,instanceId="absent",port:number|undefined;
  let executable:string;
  if(action==="start"){
    await absent();executable=chooseBinary();
  }else{
    const owner=await verifiedOwner();
    pid=owner.pid;instanceId=owner.instanceId;port=owner.controlPort;
    executable=permitted(owner.executablePath);
  }
  return {service:"tray",action,operationId:crypto.randomUUID(),
    expectedOwnerPid:pid,expectedInstanceId:instanceId,
    expectedBuildDigest:hashFile(executable),...(port?{port}:{}),
    noCoreShutdown:true,
    note:"Opt-in native Tray lifecycle. Stop exits only the verified Tray; restart uses the identical verified executable. Core, MCP, Muse and tunnels are not touched. Explicit approval required."};
}

export type TrayExecutionArgs=Plan&{confirm:boolean};
const ledgerPort=45321; // private journal namespace, never a listener.
function fingerprint(args:TrayExecutionArgs){
  return sidecarOperationFingerprint({
    service:"tray",action:args.action,
    expectedOwnerPid:args.expectedOwnerPid,
    expectedInstanceId:args.expectedInstanceId,
    expectedBuildDigest:args.expectedBuildDigest,
    port:args.port??null,noCoreShutdown:true,
  });
}
async function stopOwner(owner:Owner){
  const url="http://127.0.0.1:"+owner.controlPort+"/tray/control";
  const reply=await fetch(url,{
    method:"POST",redirect:"error",
    headers:{"Authorization":"Bearer "+owner.token,
      "Content-Type":"application/json"},
    body:JSON.stringify({action:"stop",instanceId:owner.instanceId}),
    signal:AbortSignal.timeout(4500),
  });
  const body=await reply.json().catch(()=>null) as any;
  if(!reply.ok||body?.ok!==true||body?.coreUnaffected!==true)
    throw new Error("TRAY_PRIVATE_STOP_REFUSED");
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){
    if(!fs.existsSync(recordFile()) &&
       !verifiedPid(owner.controlPort,owner.pid)){
      try {await freePort(owner.controlPort);return;}catch{}
    }
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw new Error("TRAY_STOP_OUTCOME_UNCERTAIN: native UI may still be running; do not use taskkill or retry with a new operation ID");
}
async function startBinary(executable:string){
  await absent();
  const smoke=process.env.SUPERAGENT_TRAY_LIFECYCLE_TEST==="1"&&
    process.env.VITEST!==undefined;
  const child=spawn(executable,smoke?["--lifecycle-smoke"]:["--background"],{
    cwd:path.dirname(executable),detached:true,windowsHide:true,stdio:"ignore",
    env:{...process.env,SUPERAGENT_TRAY_CHILD:"1",
      SUPERAGENT_TRAY_AUTOSTART:"0"},
  });
  child.on("error",()=>{});
  child.unref();
  if(!child.pid)throw new Error("TRAY_SPAWN_PID_MISSING");
  const deadline=Date.now()+25000;
  while(Date.now()<deadline){
    const record=readManagedTrayOwner();
    if(record){
      if(record.pid!==child.pid)
        throw new Error("TRAY_FOREIGN_OR_SINGLE_INSTANCE_OWNER: child did not own the new Tray");
      const live=await verifiedOwner().catch(()=>null);
      if(live&&live.pid===child.pid){
        const actual=permitted(live.executablePath);
        if(actual.toLowerCase()!==executable.toLowerCase())
          throw new Error("TRAY_STARTED_DIFFERENT_EXECUTABLE");
        return live;
      }
    }
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw new Error("TRAY_START_OUTCOME_UNCERTAIN: spawned PID "+child.pid+" may still be active");
}
export async function executeManagedTray(args:TrayExecutionArgs){
  if(args.confirm!==true||args.noCoreShutdown!==true)
    throw new Error("TRAY_EXPLICIT_CONFIRMATION_REQUIRED");
  validateCoreOperationId(args.operationId);
  if(!["start","stop","restart"].includes(args.action)||
     !Number.isSafeInteger(args.expectedOwnerPid)||args.expectedOwnerPid<0||
     (args.expectedInstanceId!=="absent"&&
      !/^[a-f0-9]{32}$/.test(args.expectedInstanceId))||
     !/^[a-f0-9]{64}$/.test(args.expectedBuildDigest)||
     (args.port!==undefined&&(!Number.isSafeInteger(args.port)||
        args.port<1024||args.port>65535)))
    throw new Error("TRAY_INVALID_OPERATION_EXPECTATION");
  const ledger=new ManagedSidecarLedger("tray",ledgerPort);
  const signature=fingerprint(args);
  const replay=ledger.lookup(args.operationId,signature);
  if(replay?.replayed){
    if(replay.afterPid===0)await absent();
    else if((await verifiedOwner()).pid!==replay.afterPid)
      throw new Error("TRAY_REPLAY_OWNER_CHANGED");
    return {service:"tray",action:args.action,
      replayed:true,changed:false,ownerPid:replay.afterPid||null};
  }
  let executable:string,old:Owner|undefined;
  if(args.action==="start"){
    if(args.expectedOwnerPid!==0||args.expectedInstanceId!=="absent"||
       args.port!==undefined)
      throw new Error("TRAY_START_EXPECTED_NO_OWNER");
    await absent();
    executable=chooseBinary();
  }else {
    old=await verifiedOwner();
    if(old.pid!==args.expectedOwnerPid||
       old.instanceId!==args.expectedInstanceId||
       old.controlPort!==args.port)
      throw new Error("TRAY_OWNER_CHANGED_SINCE_PLAN");
    executable=permitted(old.executablePath);
  }
  if(hashFile(executable)!==args.expectedBuildDigest)
    throw new Error("TRAY_BINARY_CHANGED_SINCE_PLAN");
  ledger.begin(args.operationId,signature);
  if(old)await stopOwner(old);
  if(args.action==="stop"){
    ledger.complete(args.operationId,0);
    return {service:"tray",action:"stop",changed:true,replayed:false,
      previousPid:old!.pid,ownerPid:null,coreUnaffected:true};
  }
  // After STOP, use EXACT binary checked by the plan, never arbitrary CLI.
  if(hashFile(executable)!==args.expectedBuildDigest)
    throw new Error("TRAY_BINARY_CHANGED_DURING_RESTART");
  const started=await startBinary(executable);
  if(old&&started.pid===old.pid)
    throw new Error("TRAY_RESTART_DID_NOT_CHANGE_OWNER");
  ledger.complete(args.operationId,started.pid);
  return {service:"tray",action:args.action,changed:true,replayed:false,
    ownerPid:started.pid,controlPort:started.controlPort,
    ...(old?{previousPid:old.pid}:{}),coreUnaffected:true};
}
