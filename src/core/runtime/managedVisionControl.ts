/**
 * Opt-in Vision server lifecycle. Only processes launched with our private
 * owner record/token may be controlled. Legacy Core-spawned Vision servers
 * remain visible in status but cannot be stopped or adopted.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {spawn,spawnSync} from "node:child_process";
import {getPackageRootDir,getRootConfigDir} from "../config/paths.js";
import {readListenerOwners} from "./coreMcpOwnershipAudit.js";
import {ManagedSidecarLedger,sidecarOperationFingerprint} from "./managedSidecarLedger.js";
import {validateCoreOperationId} from "./coreLifecycleLedger.js";
import {listActiveTunnels} from "../remoteAgent/cloudflareTunnel.js";

type VisionOwner={version:1;port:number;pid:number;instanceId:string;token:string};
type VisionAction="start"|"stop"|"restart";
export type VisionPlan={
  service:"vision";action:VisionAction;port:number;operationId:string;
  expectedOwnerPid:number;expectedInstanceId:string;noPublicIngress:true;
  note:string;
};
export function visionOwnerFile(port:number){
  return path.join(getRootConfigDir(),"vision-owner-"+port+".json");
}
export function readVisionOwner(port:number):VisionOwner|null {
  let stat:fs.Stats;
  try{stat=fs.lstatSync(visionOwnerFile(port));}catch(e){
    if((e as NodeJS.ErrnoException).code==="ENOENT")return null;
    throw e;
  }
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>2048)
    throw new Error("VISION_OWNER_UNSAFE_FILE");
  const v=JSON.parse(fs.readFileSync(visionOwnerFile(port),"utf8")) as VisionOwner;
  if(v.version!==1||v.port!==port||!Number.isSafeInteger(v.pid)||v.pid<=0||
     !/^[a-f0-9]{32}$/.test(v.instanceId)||!/^[a-f0-9]{64}$/.test(v.token))
    throw new Error("VISION_OWNER_INVALID_FILE");
  return v;
}
async function health(port:number) {
  const r=await fetch("http://127.0.0.1:"+port+"/health",{
    signal:AbortSignal.timeout(1800),redirect:"error"});
  if(!r.ok)throw new Error("VISION_HEALTH_UNAVAILABLE");
  return await r.json() as {status:string;model_loaded:boolean;managed?:boolean;
    ownerPid?:number;instanceId?:string;activeRequests?:number};
}
export async function inspectManagedVision(port:number) {
  const rec=readVisionOwner(port);
  if(!rec)return {verified:false,reason:"Legacy/unowned Vision server: no lifecycle control"};
  try{
    const status=await health(port);
    const identityOk=status.managed===true&&status.ownerPid===rec.pid&&
      status.instanceId===rec.instanceId;
    let kernelPid=readListenerOwners()?.get(port);
    // Windows netstat snapshots occasionally lag a just-opened listener.
    // Retry a bounded read-only kernel observation; never infer ownership
    // from HTTP health alone and never proceed on an unresolved mismatch.
    for(let attempt=0;identityOk&&kernelPid!==rec.pid&&attempt<3;attempt++){
      await new Promise(resolve=>setTimeout(resolve,180));
      kernelPid=readListenerOwners()?.get(port);
    }
    const verified=identityOk&&kernelPid===rec.pid;
    return {verified,ownerPid:rec.pid,modelLoaded:status.model_loaded,
      activeRequests:status.activeRequests??0,
      reason:verified?"Authenticated isolated Vision owner":
        "Vision owner identity/kernel listener mismatch"};
  }catch{
    return {verified:false,ownerPid:rec.pid,reason:"Owner record exists but Vision instance unavailable"};
  }
}
function noIngress(port:number){
  if(listActiveTunnels().some(t=>t.port===port))
    throw new Error("VISION_PUBLIC_INGRESS_ATTACHED");
}
async function vacant(port:number){
  if(readVisionOwner(port)||fs.existsSync(visionOwnerFile(port)))
    throw new Error("VISION_OWNER_RECORD_EXISTS: manual review required");
  if(readListenerOwners()?.has(port))throw new Error("VISION_PORT_ALREADY_OWNED");
  await new Promise<void>((resolve,reject)=>{
    const server=net.createServer();
    server.once("error",()=>reject(new Error("VISION_PORT_NOT_VACANT")));
    server.listen(port,"127.0.0.1",()=>server.close(e=>e?reject(e):resolve()));
  });
}
let resolvedPython:string|undefined;
function pythonBin(){
  if(resolvedPython)return resolvedPython;
  const configured=process.env.SUPERAGENT_VISION_PYTHON||"python";
  // pyenv-win shims may spawn a second interpreter. Recording the shim PID
  // instead of the actual bound HTTP listener fails ownership validation.
  const probe=spawnSync(configured,["-c","import sys; print(sys.executable)"],{
    windowsHide:true,timeout:6000,encoding:"utf8",stdio:["ignore","pipe","ignore"],
  });
  const binary=probe.status===0?probe.stdout.trim():"";
  if(!path.isAbsolute(binary))throw new Error("VISION_PYTHON_BINARY_UNRESOLVED");
  // Validate the real executable, but preserve sys.executable as the launch
  // path: a Python virtual environment can use a symlink to the system ELF.
  // Invoking the realpath rather than the venv path loses sys.prefix and all
  // site-packages installed by setup-python/venv, causing a silent startup
  // failure despite a successful dependency probe.
  const real=fs.realpathSync(binary);
  const stat=fs.lstatSync(real);
  if(!stat.isFile()||stat.isSymbolicLink())
    throw new Error("VISION_PYTHON_BINARY_UNSAFE");
  resolvedPython=binary;
  return binary;
}
function preflightPython(){
  const script=path.join(getPackageRootDir(),"scripts","vision_server.py");
  const stat=fs.lstatSync(script);
  if(!stat.isFile()||stat.isSymbolicLink())
    throw new Error("VISION_TRUSTED_SCRIPT_MISSING");
  // Probe the exact interpreter and every eager import used by vision_server.py.
  // The heavyweight model weights remain lazy and are not downloaded here.
  const check=spawnSync(pythonBin(),["-c",
    "import torch; import transformers; import rfdetr; import numpy; from PIL import Image; from huggingface_hub import hf_hub_download"],{
    cwd:getPackageRootDir(),windowsHide:true,timeout:18000,
    stdio:"ignore",
  });
  if(check.error||check.status!==0)
    throw new Error("VISION_PYTHON_DEPENDENCIES_UNAVAILABLE: configure supported Python with torch, transformers, rfdetr, numpy, Pillow and huggingface_hub before starting");
}
export async function planManagedVision(action:VisionAction,port:number):Promise<VisionPlan>{
  if(!Number.isSafeInteger(port)||port<1024||port>65535||[7888,8857,9225,9227].includes(port))
    throw new Error("VISION_INVALID_OR_PROTECTED_PORT");
  noIngress(port);
  let pid=0,instanceId="absent";
  if(action==="start"){
    await vacant(port);
    preflightPython();
  }else{
    const current=readVisionOwner(port);
    const status=await inspectManagedVision(port);
    if(!current||!status.verified)
      throw new Error("VISION_UNOWNED_OR_UNVERIFIED: cannot stop Core-spawned Vision");
    if(status.activeRequests!==0)throw new Error("VISION_INFERENCE_ACTIVE");
    pid=current.pid;instanceId=current.instanceId;
  }
  return {service:"vision",action,port,operationId:crypto.randomUUID(),
    expectedOwnerPid:pid,expectedInstanceId:instanceId,noPublicIngress:true,
    note:"Only service-manager-owned Vision processes, never Core-spawned legacy Python. Requires approval and idle inference."};
}
export async function executeManagedVision(args:VisionPlan&{confirm:boolean}){
  if(args.confirm!==true||args.noPublicIngress!==true)
    throw new Error("VISION_EXPLICIT_CONFIRMATION_REQUIRED");
  validateCoreOperationId(args.operationId);
  if(!Number.isSafeInteger(args.port)||args.port<1024||args.port>65535||
     [7888,8857,9225,9227].includes(args.port)||
     !Number.isSafeInteger(args.expectedOwnerPid)||args.expectedOwnerPid<0||
     typeof args.expectedInstanceId!=="string")
    throw new Error("VISION_INVALID_OPERATION_ARGS");
  const ledger=new ManagedSidecarLedger("vision",args.port);
  const fp=sidecarOperationFingerprint({
    service:"vision",action:args.action,port:args.port,
    expectedOwnerPid:args.expectedOwnerPid,expectedInstanceId:args.expectedInstanceId,
    noPublicIngress:true,
  });
  const old=ledger.lookup(args.operationId,fp);
  if(old?.replayed){
    if(old.afterPid===0)await vacant(args.port);
    else {
      const current=await inspectManagedVision(args.port);
      if(!current.verified||current.ownerPid!==old.afterPid)
        throw new Error("VISION_REPLAY_UNVERIFIED_OWNER");
    }
    return {service:"vision",port:args.port,action:args.action,
      replayed:true,changed:false,ownerPid:old.afterPid||null};
  }
  noIngress(args.port);
  async function start(){
    await vacant(args.port);
    preflightPython();
    const instanceId=crypto.randomBytes(16).toString("hex");
    const token=crypto.randomBytes(32).toString("hex");
    const child=spawn(pythonBin(),[
      path.join(getPackageRootDir(),"scripts","vision_server.py"),String(args.port),
    ],{cwd:getPackageRootDir(),windowsHide:true,detached:true,stdio:"ignore",
      env:{...process.env,SUPERAGENT_VISION_OWNER_TOKEN:token,
        SUPERAGENT_VISION_OWNER_INSTANCE:instanceId,SUPERAGENT_TRAY_AUTOSTART:"0"}});
    child.on("error",()=>{});child.unref();
    if(!child.pid)throw new Error("VISION_CHILD_PID_MISSING");
    const record:VisionOwner={version:1,port:args.port,pid:child.pid,instanceId,token};
    const file=visionOwnerFile(args.port);
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    fs.writeFileSync(file,JSON.stringify(record),{flag:"wx",mode:0o600});
    const deadline=Date.now()+35000;
    while(Date.now()<deadline){
      const status=await inspectManagedVision(args.port);
      if(status.verified&&status.ownerPid===child.pid)
        return {pid:child.pid,instanceId};
      await new Promise(r=>setTimeout(r,250));
    }
    throw new Error("VISION_START_OUTCOME_UNCERTAIN: review service-manager-owned PID "+child.pid);
  }
  if(args.action==="start"){
    if(args.expectedOwnerPid!==0||args.expectedInstanceId!=="absent")
      throw new Error("VISION_START_EXPECTED_VACANT");
    await vacant(args.port);preflightPython();
    ledger.begin(args.operationId,fp);
    const created=await start();
    ledger.complete(args.operationId,created.pid);
    return {service:"vision",action:"start",port:args.port,
      replayed:false,changed:true,ownerPid:created.pid};
  }
  const rec=readVisionOwner(args.port),state=await inspectManagedVision(args.port);
  if(!rec||!state.verified||rec.pid!==args.expectedOwnerPid||
     rec.instanceId!==args.expectedInstanceId)
    throw new Error("VISION_OWNER_CHANGED_SINCE_PLAN");
  if(state.activeRequests!==0)throw new Error("VISION_INFERENCE_ACTIVE");
  ledger.begin(args.operationId,fp);
  const response=await fetch("http://127.0.0.1:"+args.port+"/_superagent/vision/lifecycle",{
    method:"POST",headers:{"Authorization":"Bearer "+rec.token,
      "Content-Type":"application/json"},
    body:JSON.stringify({action:"stop",instanceId:rec.instanceId}),
    signal:AbortSignal.timeout(6000),
  });
  if(!response.ok||!(await response.json() as any).ok)
    throw new Error("VISION_OWNER_REFUSED_STOP");
  const deadline=Date.now()+18000;
  while(Date.now()<deadline){
    if(readListenerOwners()?.get(args.port)!==rec.pid){
      try{
        await new Promise<void>((resolve,reject)=>{
          const server=net.createServer();
          server.once("error",reject);
          server.listen(args.port,"127.0.0.1",()=>server.close(()=>resolve()));
        });
        const actual=readVisionOwner(args.port);
        if(actual?.pid!==rec.pid||actual.instanceId!==rec.instanceId)
          throw new Error("VISION_OWNER_CHANGED_DURING_STOP");
        fs.rmSync(visionOwnerFile(args.port),{force:true});
        break;
      }catch(e){
        if(String(e).includes("VISION_OWNER_CHANGED_DURING_STOP"))throw e;
      }
    }
    await new Promise(r=>setTimeout(r,250));
  }
  if(fs.existsSync(visionOwnerFile(args.port)))
    throw new Error("VISION_STOP_UNCERTAIN: operator review required");
  if(args.action==="stop"){
    ledger.complete(args.operationId,0);
    return {service:"vision",action:"stop",port:args.port,
      replayed:false,changed:true,previousPid:rec.pid};
  }
  const created=await start();
  ledger.complete(args.operationId,created.pid);
  return {service:"vision",action:"restart",port:args.port,
    replayed:false,changed:true,previousPid:rec.pid,ownerPid:created.pid};
}
