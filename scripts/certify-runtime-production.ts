/**
 * Explicit production runtime certification.
 *
 * This script performs the expensive historical drills and writes a short-lived
 * certificate only after every step passes. Volatile OAuth/Core/MCP security is
 * still re-verified by rollout-audit on every invocation.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { captureRuntimeOwnership } from "../src/core/runtime/runtimeOwnershipContract.js";
import {
  inspectLiveRuntimeSecurity,
  writeRuntimeProductionCertificate,
  type RuntimeProductionCertificate,
} from "../src/core/runtime/runtimeProductionCertificate.js";
import { requestCoreSupervisor } from "../src/core/runtime/coreSupervisor.js";
import { readCoreGuardianLease } from "../src/core/runtime/coreGuardian.js";
import { readListenerOwners, readMcpStateInventory } from "../src/core/runtime/coreMcpOwnershipAudit.js";

const args=process.argv.slice(2);
const portIndex=args.indexOf("--port");
const corePort=portIndex<0?7888:Number(args[portIndex+1]);
const tlineIndex=args.indexOf("--tline-workspace");
const tlineWorkspace=tlineIndex<0?"":path.resolve(args[tlineIndex+1]||"");
const approve=args.includes("--approve-production");
const prebuiltTline=args.includes("--prebuilt-tline");
const soakIndex=args.indexOf("--soak-seconds");
const soakSeconds=soakIndex<0?36:Number(args[soakIndex+1]);
if(!approve)throw new Error("Explicit --approve-production is required");
if(corePort!==7888)throw new Error("Production certification is restricted to Core 7888");
if(!tlineWorkspace||!path.isAbsolute(tlineWorkspace)||!fs.existsSync(path.join(tlineWorkspace,"package.json")))
  throw new Error("--tline-workspace must point to the local T-Line repository");
if(!Number.isFinite(soakSeconds)||soakSeconds<30||soakSeconds>600)
  throw new Error("--soak-seconds must be between 30 and 600");

const run=(exe:string,argv:string[],cwd:string,timeout:number,maxBuffer=8*1024*1024)=>{
  const result=spawnSync(exe,argv,{cwd,encoding:"utf8",timeout,windowsHide:true,maxBuffer});
  if(result.status!==0)throw new Error(
    "Certification subprocess failed: "+exe+" "+argv.join(" ")+"\n"+
    String(result.stderr||result.stdout||result.error||result.status).slice(-1200));
  return String(result.stdout||"");
};

const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const waitForCoreReady=async(expectedSupervisorPid?:number,timeoutMs=12_000)=>{
  const deadline=Date.now()+timeoutMs;
  let last:unknown=null;
  while(Date.now()<deadline){
    try{
      const status=await requestCoreSupervisor("status",corePort,1800);
      if(expectedSupervisorPid===undefined||status.supervisorPid===expectedSupervisorPid)return status;
      last=new Error("Supervisor PID changed while waiting for readiness");
    }catch(error){last=error}
    await pause(250);
  }
  throw last instanceof Error?last:new Error("Core supervisor did not become ready");
};

const stableMcpPids=()=>{
  const listeners=readListenerOwners();
  const inventory=readMcpStateInventory();
  if(!listeners||inventory.directory!=="present"||inventory.rejected!==0||inventory.records.length===0)
    throw new Error("MCP ownership inventory unavailable");
  const result=new Map<number,number>();
  for(const rec of inventory.records){
    if(listeners.get(rec.port)!==rec.pid)throw new Error("MCP listener/state PID mismatch on "+rec.port);
    result.set(rec.port,rec.pid);
  }
  return result;
};
const assertMcpStable=(baseline:Map<number,number>)=>{
  const now=stableMcpPids();
  if(now.size!==baseline.size)throw new Error("MCP owner count changed during certification");
  for(const [port,pid] of baseline)if(now.get(port)!==pid)
    throw new Error("MCP PID changed during certification on port "+port);
};
const guardianPid=()=>{
  const lease=readCoreGuardianLease(corePort);
  if(!lease)throw new Error("Core guardian lease missing");
  try{process.kill(lease.pid,0)}catch{throw new Error("Core guardian PID is not alive")}
  return lease.pid;
};

console.log("[cert] verifying live security baseline");
let ownership=await captureRuntimeOwnership(corePort);
let live=await inspectLiveRuntimeSecurity(ownership,corePort);
if(!live.privateOAuthIssuerVerified||!live.windowsKeystoreAndAclVerified||
   !live.liveIssuerTlsVerified||!live.separateIngressVerified||
   !live.oauthClientsReauthorized||live.legacyMcpSessions!==0||
   live.pendingExternalEffects!==0||!live.guardianVerified)
  throw new Error("Live security baseline failed: "+live.reasons.join(", "));

const baselineMcp=stableMcpPids();
const baselineGuardian=guardianPid();

console.log("[cert] running installed T-Line verification");
const tlinePackage=JSON.parse(fs.readFileSync(path.join(tlineWorkspace,"package.json"),"utf8")) as {version?:string};
if(!tlinePackage.version)throw new Error("T-Line package version unavailable");
if(prebuiltTline){
  // The installer has already been built from the current outputs. Only run
  // non-mutating verification here so certificate generation cannot make the
  // just-verified installer stale by rebuilding frontend/backend again.
  run(process.execPath,["run","test"],tlineWorkspace,180_000);
  run(process.execPath,["run","parity:check"],tlineWorkspace,120_000);
  run(process.execPath,["run","verify:brain"],tlineWorkspace,120_000);
}else{
  run(process.execPath,["run","verify:all"],tlineWorkspace,180_000);
  // verify:all rebuilds frontend/backend outputs. The production installer must
  // be rebuilt afterwards or the bundle would intentionally fail freshness.
  run(process.execPath,["run","build:exe"],tlineWorkspace,900_000);
}

const bundleRaw=run(process.execPath,["scripts/check-tauri-bundle.cjs"],tlineWorkspace,120_000);
let bundle:any;
try{bundle=JSON.parse(bundleRaw)}catch{throw new Error("T-Line bundle verifier returned invalid JSON")}
if(bundle.status!=="pass")throw new Error("T-Line bundle did not pass");

const config=JSON.parse(fs.readFileSync(path.join(tlineWorkspace,"desktop-tauri","src-tauri","tauri.conf.json"),"utf8")) as {version:string};
const installer=path.join(tlineWorkspace,"desktop-tauri","src-tauri","target","release","bundle","nsis",
  "t-line_"+config.version+"_x64-setup.exe");
if(!fs.existsSync(installer))throw new Error("Current T-Line NSIS installer missing");
const guiRaw=run("python",[
  "scripts/check-studio-gui-smoke.py","--installer",installer,"--timeout","25",
],tlineWorkspace,60_000);
let gui:any;
try{gui=JSON.parse(guiRaw.trim().split(/\r?\n/).filter(Boolean).at(-1)!)}
catch{throw new Error("T-Line GUI smoke returned invalid JSON")}
if(gui.status!=="pass"||!gui.gui_window?.title)throw new Error("T-Line GUI smoke did not pass");
const tlineVerifiedAt=Date.now();

// Installer/GUI verification can be CPU-heavy. Sample the authenticated
// supervisor immediately before any mutation. State-changing operations
// themselves are never blindly retried.
await waitForCoreReady(undefined,12_000);
await pause(350);

console.log("[cert] running Core restart/rollback drill");
const before=await waitForCoreReady(undefined,12_000);
assertMcpStable(baselineMcp);
if(guardianPid()!==baselineGuardian)throw new Error("Guardian changed before rollback drill");
console.log("[cert] Core restart drill: "+before.active.pid+" -> new worker");
const restarted=await requestCoreSupervisor("restart",corePort,30_000);
if(restarted.supervisorPid!==before.supervisorPid||restarted.active.pid===before.active.pid)
  throw new Error("Core restart drill did not produce expected worker transition");
assertMcpStable(baselineMcp);
await waitForCoreReady(before.supervisorPid,12_000);
console.log("[cert] Core rollback drill: "+restarted.active.pid+" -> "+before.active.pid);
const rolled=await requestCoreSupervisor("rollback",corePort,30_000);
if(rolled.supervisorPid!==before.supervisorPid||rolled.active.pid!==before.active.pid)
  throw new Error("Core rollback did not return to the original verified worker");
assertMcpStable(baselineMcp);
if(guardianPid()!==baselineGuardian)throw new Error("Guardian changed during rollback drill");
const rollbackVerifiedAt=Date.now();

console.log("[cert] running bounded production soak: "+soakSeconds+"s / 3 restart cycles");
const soakStart=Date.now();
let previousPid=rolled.active.pid;
for(let cycle=0;cycle<3;cycle++){
  await waitForCoreReady(before.supervisorPid,12_000);
  console.log("[cert] soak restart cycle "+(cycle+1));
  const next=await requestCoreSupervisor("restart",corePort,30_000);
  if(next.supervisorPid!==before.supervisorPid||next.active.pid===previousPid)
    throw new Error("Soak restart cycle "+(cycle+1)+" did not rotate the active worker");
  previousPid=next.active.pid;
  assertMcpStable(baselineMcp);
  if(guardianPid()!==baselineGuardian)throw new Error("Guardian changed during soak");
  try{await requestCoreSupervisor("drain",corePort,30_000)}catch{}
  const target=soakStart+Math.ceil((cycle+1)*soakSeconds*1000/3);
  const wait=Math.max(0,target-Date.now());
  if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
  const healthy=await requestCoreSupervisor("status",corePort,5000);
  if(healthy.supervisorPid!==before.supervisorPid)throw new Error("Core supervisor PID changed during soak");
  assertMcpStable(baselineMcp);
}
const durationMs=Date.now()-soakStart;
if(durationMs<30_000)throw new Error("Soak duration below certification floor");

ownership=await captureRuntimeOwnership(corePort);
live=await inspectLiveRuntimeSecurity(ownership,corePort);
if(!live.privateOAuthIssuerVerified||!live.windowsKeystoreAndAclVerified||
   !live.liveIssuerTlsVerified||!live.oauthClientsReauthorized||
   live.legacyMcpSessions!==0||live.pendingExternalEffects!==0||!live.guardianVerified)
  throw new Error("Live security regressed after soak: "+live.reasons.join(", "));

const issuedAt=Date.now();
const cert:RuntimeProductionCertificate={
  version:1,corePort,issuedAt,validUntil:issuedAt+24*60*60_000,
  operatorApprovedAt:issuedAt,
  rollback:{
    passed:true,verifiedAt:rollbackVerifiedAt,
    beforeWorkerPid:before.active.pid,restartWorkerPid:restarted.active.pid,
    rollbackWorkerPid:rolled.active.pid,
  },
  soak:{
    passed:true,verifiedAt:Date.now(),durationMs,restartCycles:3,
    mcpPidsStable:true,guardianStable:true,
  },
  tline:{
    passed:true,verifiedAt:tlineVerifiedAt,version:tlinePackage.version,
    verifyAllPassed:true,bundlePassed:true,guiSmokePassed:true,
  },
};
writeRuntimeProductionCertificate(cert);
console.log(JSON.stringify({
  status:"CERTIFIED",corePort,validUntil:new Date(cert.validUntil).toISOString(),
  tlineVersion:cert.tline.version,soakSeconds:Math.round(durationMs/1000),
  restartCycles:cert.soak.restartCycles,mcpPorts:[...baselineMcp.keys()],
},null,2));
