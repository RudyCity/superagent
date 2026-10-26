/**
 * Phase 5l: verified operator-gated, ISOLATED Core canary generation.
 * Never changes or adopts the original owner, snapshot, sessions or ports.
 * No LLM, chat/tool POST, external channel, scheduled task or handover.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { reconcileCoreRecoveryEvidence } from "./coreColdReconciliation.js";
import { auditCoreColdStart } from "./coreColdStartAudit.js";
import { getRootConfigDir } from "../config/paths.js";

const APPROVAL = "START_ISOLATED_CANARY";
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function shaFile(file:string):string {
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>6*1024*1024) throw new Error("Unsafe original recovery metadata");
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function compareOriginalMetadata(snapshotFolder:string, originalPort:number):void {
  const root=getRootConfigDir();
  const manifest=JSON.parse(fs.readFileSync(path.join(snapshotFolder,"manifest.json"),"utf8")) as {
    files:Array<{name:string;sha256:string}>;
  };
  const sources=[
    ["core-checkpoint.json","core-checkpoint-"+originalPort+".json"],
    ["core-supervisor.json","core-supervisor-"+originalPort+".json"],
    ["core-guardian.json","core-guardian-"+originalPort+".json"],
  ] as const;
  for(const [name,leaf] of sources) {
    const archive=manifest.files.find(x=>x.name===name);
    const source=path.join(root,leaf);
    if(fs.existsSync(source)!==Boolean(archive)) throw new Error("Original Core metadata changed since snapshot");
    if(archive && shaFile(source)!==archive.sha256) throw new Error("Original Core metadata hash changed");
  }
  // Archived receipts are immutable evidence. Any new or changed original
  // receipt must be assessed by a fresh snapshot, never silently ignored.
  const recorded=new Map(manifest.files.filter(x=>x.name.startsWith("receipts/"))
    .map(x=>[x.name,x.sha256]));
  const base=path.join(root,"core-session-receipts");
  const found=new Map<string,string>();
  if(fs.existsSync(base)){
    const st=fs.lstatSync(base);
    if(!st.isDirectory()||st.isSymbolicLink())throw new Error("Unsafe original receipts");
    for(const bucket of fs.readdirSync(base,{withFileTypes:true})){
      if(!bucket.isDirectory()||!/^[a-f0-9]{2}$/.test(bucket.name)) throw new Error("Unexpected receipt bucket");
      for(const file of fs.readdirSync(path.join(base,bucket.name),{withFileTypes:true})){
        if(!file.isFile()||!/^[a-f0-9]{64}\.json$/.test(file.name)) throw new Error("Unexpected receipt");
        const key="receipts/"+bucket.name+"/"+file.name;
        found.set(key,shaFile(path.join(base,bucket.name,file.name)));
        if(found.size>20_000) throw new Error("Too many receipts");
      }
    }
  }
  if(recorded.size!==found.size) throw new Error("Original receipt inventory changed");
  for(const [name,digest] of recorded) if(found.get(name)!==digest)
    throw new Error("Original receipt modified since snapshot");
}
async function portAvailable(p:number):Promise<boolean> {
  return await new Promise(resolve=>{
    const srv=net.createServer();
    srv.once("error",()=>resolve(false));
    srv.listen(p,"127.0.0.1",()=>srv.close(()=>resolve(true)));
  });
}
export interface CoreCanaryPreflight {
  version:1; originalPort:number; targetPort:number;
  snapshotId:string; snapshotVerified:true;
  originalCoreOffline:true; originalMetadataUnchanged:true;
  originalSessionsMigrated:false; automaticToolReplayAllowed:false;
  productionHandoverAuthorized:false;
  activation:"explicit_only";
}
export async function preflightIsolatedCoreCanary(snapshotFolder:string,targetPort:number):Promise<CoreCanaryPreflight> {
  if(!Number.isInteger(targetPort)||targetPort<1024||targetPort>65535||targetPort===7888)
    throw new Error("Canary port must be an alternate non-default loopback port");
  const evidence=reconcileCoreRecoveryEvidence(snapshotFolder);
  if(evidence.port===targetPort)throw new Error("Canary cannot bind original Core port");
  if(!evidence.snapshotIntegrity || evidence.snapshotIntegrity!=="ok")
    throw new Error("Recovery canary requires intact offline SQLite snapshot");
  if(!evidence.checkpointPresent)throw new Error("Recovery canary requires original checkpoint proof");
  const before=await auditCoreColdStart(evidence.port);
  if(before.snapshot.ownerOnline || before.snapshot.foreignListenerDetected)
    throw new Error("Original Core online or unknown listener; canary refused");
  if(before.snapshot.checkpoint!=="valid")throw new Error("Original Core checkpoint must be valid");
  compareOriginalMetadata(snapshotFolder,evidence.port);
  if(!await portAvailable(targetPort))throw new Error("Canary target port occupied");
  const after=await auditCoreColdStart(evidence.port);
  if(JSON.stringify(before.snapshot)!==JSON.stringify(after.snapshot))
    throw new Error("Original Core state changed during preflight");
  compareOriginalMetadata(snapshotFolder,evidence.port);
  return {version:1,originalPort:evidence.port,targetPort,
    snapshotId:evidence.snapshotId,snapshotVerified:true,
    originalCoreOffline:true,originalMetadataUnchanged:true,
    originalSessionsMigrated:false,automaticToolReplayAllowed:false,
    productionHandoverAuthorized:false,activation:"explicit_only"};
}
interface Discovery {supervisorPid:number;publicPort:number;controlPort:number;controlToken:string}
function readOwnedDiscovery(config:string,port:number):Discovery {
  const file=path.join(config,"core-supervisor-"+port+".json");
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>2048)throw new Error("Unsafe canary discovery");
  const info=JSON.parse(fs.readFileSync(file,"utf8")) as Discovery;
  if(info.publicPort!==port||!Number.isSafeInteger(info.supervisorPid)||
     !Number.isInteger(info.controlPort)||info.controlPort<1||
     !/^[a-f0-9]{64}$/.test(info.controlToken))throw new Error("Invalid canary identity");
  return info;
}
async function authenticatedStatus(discovery:Discovery):Promise<{supervisorPid:number;publicPort:number;active:{pid:number}}> {
  return await new Promise((resolve,reject)=>{
    const req=http.request({host:"127.0.0.1",port:discovery.controlPort,
      method:"GET",path:"/status",timeout:1200,
      headers:{Authorization:"Bearer "+discovery.controlToken}},res=>{
        let body="";res.setEncoding("utf8");
        res.on("data",chunk=>{body+=chunk;if(body.length>4096)req.destroy();});
        res.on("end",()=>{
          try {
            if(res.statusCode!==200)throw new Error("Unverified canary status");
            resolve(JSON.parse(body));
          }catch(e){reject(e);}
        });
      });
    req.on("timeout",()=>req.destroy(new Error("Canary timeout")));
    req.on("error",reject);req.end();
  });
}
function sanitizedEnv(profile:string,home:string):NodeJS.ProcessEnv {
  const env={...process.env};
  for(const key of Object.keys(env)){
    if(/(?:KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|AUTH|WEBHOOK|OPENROUTER|ANTHROPIC|GROQ|MUSE|TELEGRAM|CLOUDFLARE)/i.test(key) ||
       /^(?:SUPERAGENT_CORE_|SUPERAGENT_SESSION_ID$)/i.test(key))delete env[key];
  }
  env.SUPERAGENT_CONFIG_DIR=profile;
  env.SUPERAGENT_CORE_STAGING="1";
  // Independent staging owner must not start or replace a shared inference
  // watchdog/model, even if the parent workstation enables it by default.
  env.SUPERAGENT_SENOPATI_AUTOSTART="0";
  env.HOME=home;env.USERPROFILE=home;
  return env;
}
export interface CoreCanaryResult {
  version:1; passed:boolean; snapshotId:string; originalPort:number;
  isolatedPort:number; supervisorOwned:boolean; workerOwned:boolean;
  previousSessionsImported:false; toolRequestsMade:0;
  productionStateModified:false; productionHandoverAuthorized:false;
  externalChannelsRestarted:false; ownerTerminatedAfterCheck:boolean;
  elapsedMs:number;
}
export async function runIsolatedCoreCanary(options:{
  snapshotFolder:string; targetPort:number; approved:string;
  cliEntrypoint?:string; timeoutMs?:number;
}):Promise<CoreCanaryResult>{
  if(options.approved!==APPROVAL)throw new Error("Operator approval phrase required: "+APPROVAL);
  const timeoutMs=options.timeoutMs??28_000;
  if(!Number.isInteger(timeoutMs)||timeoutMs<5000||timeoutMs>60_000)throw new Error("Invalid canary timeout");
  const preflight=await preflightIsolatedCoreCanary(options.snapshotFolder,options.targetPort);
  const cli=path.resolve(options.cliEntrypoint||process.argv[1]||"");
  if(!fs.existsSync(cli)||path.basename(cli)!=="cli.js")throw new Error("Require built SuperAgent CLI");
  const base=path.join(os.homedir(),".superagent-local-staging");
  fs.mkdirSync(base,{recursive:true,mode:0o700});
  const session=fs.mkdtempSync(path.join(base,"core-approved-canary-"));
  const config=path.join(session,"config");
  const workspace=path.join(session,"workspace");
  fs.mkdirSync(config,{mode:0o700});fs.mkdirSync(workspace,{mode:0o700});
  let child:ChildProcess|undefined,workerPid:number|undefined;
  let workerOwned=false,ownerOwned=false,terminated=false;
  const start=Date.now();
  try{
    // Fresh profile with no recovery state and no inherited provider credentials.
    child=spawn(process.execPath,[cli,"core","start","--port",String(options.targetPort),
      "--client-mode","tline"],{
      cwd:workspace,env:sanitizedEnv(config,session),stdio:"ignore",windowsHide:true,
    });
    if(!child.pid)throw new Error("Canary spawn returned no PID");
    let verified=false;
    while(Date.now()-start<timeoutMs){
      if(child.exitCode!==null||child.signalCode!==null)throw new Error("Canary Core exited");
      try{
        const d=readOwnedDiscovery(config,options.targetPort);
        if(d.supervisorPid!==child.pid)throw new Error("Canary supervisor ownership mismatch");
        const s=await authenticatedStatus(d);
        if(s.supervisorPid===child.pid&&s.publicPort===options.targetPort&&
           Number.isSafeInteger(s.active?.pid)&&s.active.pid>0){
          ownerOwned=true;workerOwned=true;workerPid=s.active.pid;verified=true;break;
        }
      }catch(e){if(String(e).includes("ownership mismatch"))throw e;}
      await pause(220);
    }
    if(!verified)throw new Error("Canary owner failed authenticated readiness");
    // The target now belongs to the verified canary, so recheck ONLY the
    // untouched original namespace, rather than probing target availability.
    const originalAfter=await auditCoreColdStart(preflight.originalPort);
    if(originalAfter.snapshot.ownerOnline||originalAfter.snapshot.foreignListenerDetected||
       originalAfter.snapshot.checkpoint!=="valid")
      throw new Error("Original Core ownership changed while canary ran");
    const evidenceAfter=reconcileCoreRecoveryEvidence(options.snapshotFolder);
    if(evidenceAfter.port!==preflight.originalPort ||
       evidenceAfter.snapshotId!==preflight.snapshotId)
      throw new Error("Recovery snapshot identity changed during canary");
    compareOriginalMetadata(options.snapshotFolder,preflight.originalPort);
  }finally{
    // Only a newly spawned exact child and its VERIFIED active worker may be
    // terminated. Never signal an original worker or external service.
    if(child?.pid){
      // Avoid a PID-reuse kill: use the original ChildProcess handle and only
      // tree-kill when its authenticated owner identity was already verified.
      const childStillRunning=child.exitCode===null&&child.signalCode===null;
      if(childStillRunning && process.platform==="win32" && ownerOwned) {
        spawnSync("taskkill",["/T","/F","/PID",String(child.pid)],{
          timeout:5000,windowsHide:true,stdio:"ignore",
        });
      } else if(childStillRunning) {
        if(process.platform!=="win32" && workerOwned && workerPid)
          try{process.kill(workerPid,"SIGTERM");}catch{}
        try{child.kill("SIGTERM");}catch{}
      }
      await pause(250);
      terminated=child.exitCode!==null||child.signalCode!==null;
      if(!terminated)await pause(350);
      terminated=child.exitCode!==null||child.signalCode!==null;
    }
    // Never delete a failure's private staging checkpoint; it may be needed
    // for diagnosing an unexpectedly surviving test-owned process.
  }
  if(!terminated)throw new Error("Isolated canary termination not verified; review owned staging process");
  return {version:1,passed:true,snapshotId:preflight.snapshotId,
    originalPort:preflight.originalPort,isolatedPort:preflight.targetPort,
    supervisorOwned:ownerOwned,workerOwned,previousSessionsImported:false,
    toolRequestsMade:0,productionStateModified:false,
    productionHandoverAuthorized:false,externalChannelsRestarted:false,
    ownerTerminatedAfterCheck:terminated,elapsedMs:Date.now()-start};
}
