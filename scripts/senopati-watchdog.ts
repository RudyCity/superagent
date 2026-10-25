/** Local Senopati model watchdog: isolated service recovery with bounded retries.
 *
 * start  - launch one detached watchdog without touching the current model
 * status - inspect watchdog and current shared inference health
 * stop   - stop watchdog only; leave model, agents, tunnels, T-Line running
 * run    - internal foreground watchdog worker
 *
 * Never kills an external process, never exposes HTTP/tunnels, never
 * persists request text, and never creates a second local mmBERT per agent.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {getRootConfigDir} from "../src/core/config/paths.js";
import {getModernPolicy} from "../src/core/senopatiModernBert.js";
import {sharedSenopatiStatus} from "../src/core/senopatiSharedClient.js";
import {modelStartLeaseBlocksNewModel} from "../src/core/senopatiStartLease.js";
import {
  SENOPATI_WATCH_CHECK_MS,
  decideSenopatiRestart,initialWatchState,
} from "../src/core/senopatiWatchPolicy.js";
import type {SenopatiWatchState} from "../src/core/senopatiWatchPolicy.js";

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const lockPath=path.join(getRootConfigDir(),"ipc","senopati-watchdog.json");
const stopPath=path.join(getRootConfigDir(),"ipc","senopati-watchdog.stop.json");
const ownScript=fileURLToPath(import.meta.url);
const serverScript=path.join(repo,"scripts","senopati-shared.ts");
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
type WatchRecord={
  version:1; pid:number; nonce:string; startedAt:number;
  updatedAt:number; modelPid:number|null; healthy:boolean;
  failedChecks:number; restartsInWindow:number; totalRestarts:number;
  circuitOpenUntilMs:number; lastStartOk:boolean|null;
  lastError:string|null; configuredPrecision:string|null;
};

function pidAlive(pid:number):boolean {
  if(!Number.isSafeInteger(pid)||pid<=0)return false;
  try{
    process.kill(pid,0);
    return true;
  }catch(error:any){
    // Inaccessible process might be running under another principal.
    return error?.code==="EPERM";
  }
}
function fileState(file:string):unknown{
  try{
    const stat=fs.lstatSync(file);
    if(!stat.isFile() || stat.size>8192 || stat.size<15)return null;
    return JSON.parse(fs.readFileSync(file,"utf8"));
  }catch{return null;}
}
function validRecord(x:unknown):x is WatchRecord {
  if(!x || typeof x!=="object")return false;
  const r=x as Partial<WatchRecord>;
  return r.version===1 && typeof r.nonce==="string" &&
    /^[a-f0-9]{32}$/.test(r.nonce) &&
    Number.isSafeInteger(r.pid) && Number(r.pid)>0 &&
    Number.isFinite(r.startedAt) && Number.isFinite(r.updatedAt);
}
function statusRecord():WatchRecord|null{
  const result=fileState(lockPath);
  return validRecord(result)?result:null;
}
function atomicRecord(record:WatchRecord):void{
  const temp=lockPath+"."+process.pid+"."+crypto.randomUUID()+".tmp";
  try{
    fs.writeFileSync(temp,JSON.stringify(record),{encoding:"utf8",mode:0o600,flag:"wx"});
    fs.renameSync(temp,lockPath);
  }finally{
    try{fs.rmSync(temp,{force:true});}catch{}
  }
}
function stopRequested(record:WatchRecord):boolean{
  const row=fileState(stopPath) as any;
  return row?.version===1 && row?.action==="stop" &&
    row?.pid===record.pid && row?.nonce===record.nonce;
}
function cleanup(record:WatchRecord):void{
  const found=statusRecord();
  if(found?.pid===record.pid && found.nonce===record.nonce){
    try{fs.rmSync(lockPath,{force:true});}catch{}
  }
  if(stopRequested(record)){
    try{fs.rmSync(stopPath,{force:true});}catch{}
  }
}
function acquire():WatchRecord{
  fs.mkdirSync(path.dirname(lockPath),{recursive:true,mode:0o700});
  // Never remove an unknown or symlinked watchdog file.
  if(fs.existsSync(lockPath)){
    const current=statusRecord();
    if(!current)throw new Error("Watchdog metadata untrusted; inspect it manually");
    if(pidAlive(current.pid))throw new Error("Senopati watchdog already active");
    // Only clean up a confirmed dead watchdog process.
    fs.rmSync(lockPath,{force:true});
  }
  const now=Date.now();
  const record:WatchRecord={
    version:1,pid:process.pid,nonce:crypto.randomBytes(16).toString("hex"),
    startedAt:now,updatedAt:now,modelPid:null,healthy:false,
    failedChecks:0,restartsInWindow:0,totalRestarts:0,
    circuitOpenUntilMs:0,lastStartOk:null,lastError:null,
    configuredPrecision:null,
  };
  fs.writeFileSync(lockPath,JSON.stringify(record),
    {encoding:"utf8",mode:0o600,flag:"wx"});
  return record;
}

async function startSharedOnly():Promise<boolean>{
  return new Promise<boolean>((resolve)=>{
    const child=spawn(process.execPath,[serverScript,"start"],{
      cwd:repo,windowsHide:true,stdio:"ignore",env:process.env,
    });
    let settled=false;
    const finish=(ok:boolean)=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer=setTimeout(()=>{
      // Own child is a short-lived bootstrap CLI, NOT a model/agent/tunnel.
      child.kill();
      finish(false);
    },25_000);
    child.once("error",()=>finish(false));
    child.once("exit",(code)=>finish(code===0));
  });
}
async function worker():Promise<void>{
  const record=acquire();
  let state:SenopatiWatchState=initialWatchState();
  let totalRestarts=0,stopping=false;
  const quit=()=>{stopping=true;};
  process.once("SIGINT",quit);
  process.once("SIGTERM",quit);
  console.log("SENOPATI_WATCHDOG_READY",JSON.stringify({pid:process.pid}));
  try{
    while(!stopping){
      if(stopRequested(record))break;
      const policy=getModernPolicy();
      const shouldRun=policy.enabled &&
        policy.backend==="mmbert-v64-seed73" &&
        policy.inferenceMode==="shared_only";
      const health=await sharedSenopatiStatus();
      const incompatible=Boolean(shouldRun && health &&
                                 health.precision!==policy.precision);
      const isHealthy=Boolean(health && health.precision===policy.precision);
      // A different precision is an operator-controlled handoff, NOT a
      // missing process. Never spin up duplicates or stop a healthy owner.
      // A model owner is still loading or draining (or its lock is
      // untrusted): do not race it or exhaust the restart budget.
      const replacementBlocked=modelStartLeaseBlocksNewModel();
      const decision=decideSenopatiRestart(
        state,Date.now(),shouldRun && !incompatible && !replacementBlocked,isHealthy);
      state=decision.state;
      if(shouldRun && decision.restart){
        totalRestarts++;
        const ok=await startSharedOnly();
        record.lastStartOk=ok;
        record.lastError=ok?null:"shared-bootstrap-failed";
      }else if(isHealthy){
        record.lastStartOk=true;
        record.lastError=null;
      }else if(incompatible){
        record.lastStartOk=false;
        record.lastError="precision-mismatch-needs-explicit-reload";
      }else if(replacementBlocked){
        record.lastError="model-start-or-drain-lease-active";
      }
      record.modelPid=health?.pid??null;
      record.healthy=isHealthy;
      record.configuredPrecision=shouldRun?policy.precision:null;
      record.failedChecks=state.failedChecks;
      record.circuitOpenUntilMs=state.circuitOpenUntilMs;
      record.restartsInWindow=state.restartTimestamps.length;
      record.totalRestarts=totalRestarts;
      record.updatedAt=Date.now();
      atomicRecord(record);
      await sleep(SENOPATI_WATCH_CHECK_MS);
    }
  }finally{
    cleanup(record);
    console.log("SENOPATI_WATCHDOG_STOPPED",JSON.stringify({
      pid:process.pid,totalRestarts,modelLeftRunning:true,
    }));
  }
}
async function main(){
  const action=process.argv[2]??"status";
  if(!["run","start","stop","status"].includes(action)){
    throw new Error("Options: start | status | stop");
  }
  if(action==="run"){await worker();return;}
  if(action==="status"){
    const watch=statusRecord();
    console.log(JSON.stringify({
      watchdog:watch?{
        pid:watch.pid,active:pidAlive(watch.pid),healthy:watch.healthy,
        configuredPrecision:watch.configuredPrecision,
        modelPid:watch.modelPid,updatedAt:watch.updatedAt,
        failedChecks:watch.failedChecks,
        totalRestarts:watch.totalRestarts,
        restartsInWindow:watch.restartsInWindow,
        circuitOpenUntilMs:watch.circuitOpenUntilMs,
        lastStartOk:watch.lastStartOk,
        lastError:watch.lastError,
      }:"offline",
      model:await sharedSenopatiStatus(),
      note:"Watchdog controls only shared model inference, never agent/tunnel processes",
    },null,2));return;
  }
  if(action==="start"){
    const existing=statusRecord();
    if(existing && pidAlive(existing.pid)){
      console.log("SENOPATI_WATCHDOG_ALREADY_ACTIVE",existing.pid);
      return;
    }
    const child=spawn(process.execPath,[ownScript,"run"],{
      cwd:repo,detached:true,stdio:"ignore",windowsHide:true,env:process.env,
    });
    child.unref();
    for(let i=0;i<36;i++){
      await sleep(250);
      const current=statusRecord();
      if(current && pidAlive(current.pid)){
        console.log("SENOPATI_WATCHDOG_STARTED",JSON.stringify({
          pid:current.pid,serviceUninterrupted:true,
        }));
        return;
      }
    }
    throw new Error("Watchdog did not start; no active model was stopped");
  }
  const existing=statusRecord();
  if(!existing || !pidAlive(existing.pid)){
    console.log("SENOPATI_WATCHDOG_NOT_RUNNING");return;
  }
  fs.writeFileSync(stopPath,JSON.stringify({
    version:1,action:"stop",pid:existing.pid,nonce:existing.nonce,
  }),{encoding:"utf8",mode:0o600});
  for(let i=0;i<28;i++){
    await sleep(250);
    if(!pidAlive(existing.pid) || !statusRecord()){
      console.log("SENOPATI_WATCHDOG_STOPPED_ONLY",JSON.stringify({
        pid:existing.pid,modelStillRunning:Boolean(await sharedSenopatiStatus()),
      }));
      return;
    }
  }
  throw new Error("Watchdog did not acknowledge stop; model left untouched");
}
await main();
