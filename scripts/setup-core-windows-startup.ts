/**
 * Windows logon startup provisioning for Core Boot. DEFAULT IS PREVIEW.
 *
 * Staging:
 *   bun scripts/setup-core-windows-startup.ts --port 7903 --profile <stage> --apply
 * Production:
 *   bun scripts/setup-core-windows-startup.ts --port 7888 --production --apply
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createCoreWindowsStartupPlan } from "../src/core/runtime/coreWindowsStartup.js";
import { auditCoreColdStart } from "../src/core/runtime/coreColdStartAudit.js";
import { readListenerOwners, readMcpStateInventory } from "../src/core/runtime/coreMcpOwnershipAudit.js";
import { requestCoreSupervisor } from "../src/core/runtime/coreSupervisor.js";
import { readCoreGuardianLease } from "../src/core/runtime/coreGuardian.js";
import { assessWindowsStartupRegistrationR5 } from "../src/core/runtime/coreWindowsStartupGuardR5.js";

const args=process.argv.slice(2);
const index=args.indexOf("--port");
const port=index<0?7888:Number(args[index+1]);
const modeIndex=args.indexOf("--client-mode");
const clientMode=modeIndex<0?"tline":args[modeIndex+1];
const apply=args.includes("--apply");
const production=args.includes("--production");
const profileIndex=args.indexOf("--profile");
const profileInput=profileIndex<0?undefined:args[profileIndex+1];

if(profileIndex>=0&&(!profileInput||profileInput.startsWith("--")))
  throw new Error("--profile requires an absolute pre-existing isolated staging directory");
if(production&&profileInput) throw new Error("--production and --profile are mutually exclusive");
for(const value of args){
  if(!["--port","--client-mode","--apply","--profile","--production","7888",String(port),
    clientMode,profileInput].includes(value)) throw new Error("Unknown option: "+value);
}
if(clientMode!=="tline"&&clientMode!=="chrome-extension") throw new Error("Invalid client mode");

const bunExecutable=process.execPath;
const cliFile=path.resolve(import.meta.dir,"..","dist","cli.js");
if(!fs.existsSync(cliFile)) throw new Error("Run bun run build first; compiled Core CLI unavailable");
const userHome=process.env.USERPROFILE||os.homedir();
const legacyRoot=path.join(userHome,".superagent-r");
const stageRoot=path.join(userHome,".superagent-local-staging");
let stageProfile:string|undefined;
if(profileInput){
  if(!path.isAbsolute(profileInput)) throw new Error("Isolated profile path must be absolute");
  const stageRootReal=fs.realpathSync(stageRoot);
  const resolved=path.resolve(profileInput);
  stageProfile=fs.realpathSync(resolved);
  const relative=path.relative(stageRootReal,stageProfile);
  if(relative===""||relative===".."||relative.startsWith(".."+path.sep)||path.isAbsolute(relative)||
     fs.lstatSync(resolved).isSymbolicLink()||!fs.lstatSync(stageProfile).isDirectory())
    throw new Error("Isolated profile must be an existing real child of the staging root");
}
if(!production&&apply&&!stageProfile)
  throw new Error("Staging --apply requires --profile; use explicit --production for port 7888");

const root=path.join(stageProfile??legacyRoot,"windows-startup");
const launcherFile=path.join(root,"core-boot-"+port+".ps1");
const plan=createCoreWindowsStartupPlan({port,clientMode,bunExecutable,cliFile,launcherFile,isolatedStageProfile:stageProfile});

console.log(JSON.stringify({
  type:"core-windows-logon-startup",mode:apply?"APPLY":"PREVIEW_ONLY",
  target:production?"PRODUCTION":"STAGING",taskName:plan.taskName,trigger:"current user logon",
  isolatedStageProfile:stageProfile??null,launcherFile:plan.launcherFile,cliFile,bunExecutable,
  registerCommand:plan.registerCommand,inspectCommand:plan.inspectCommand,removeCommand:plan.removeCommand,
  note:production
    ?"Production startup invokes fail-closed core boot; verified cold reset archives stale runtime state and never replays prior work."
    :"Staging startup remains isolated and never touches production listeners.",
},null,2));

if(!apply) process.exit(0);
if(process.platform!=="win32") throw new Error("Cannot install Windows task on non-Windows");

const inspectScript=[
  "$ErrorActionPreference='Stop'",
  "$existing=Get-ScheduledTask -TaskName "+JSON.stringify(plan.taskName)+" -ErrorAction SilentlyContinue",
  "if($null -eq $existing){[Console]::Write('ABSENT')}else{[Console]::Write('PRESENT')}",
].join(";");
const inspect=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",inspectScript],
  {encoding:"utf8",timeout:10_000,windowsHide:true,maxBuffer:8192});
const taskStatus=inspect.status===0&&inspect.stdout?.trim()==="ABSENT"?false:
  inspect.status===0&&inspect.stdout?.trim()==="PRESENT"?true:null;

const ownerMap=readListenerOwners();
let cold;
let supervisedCoreVerified=false,guardianVerified=false,independentMcpVerified=false;
const listenerPid=ownerMap?.get(port)??null;

if(production){
  if(port!==7888) throw new Error("Production startup is restricted to Core port 7888");
  cold=await auditCoreColdStart(port);
  try{
    const core=await requestCoreSupervisor("status",port,1600);
    supervisedCoreVerified=core.publicPort===port&&core.supervisorPid>0&&listenerPid===core.supervisorPid;
  }catch{}
  try{
    const guardian=readCoreGuardianLease(port);
    if(guardian){
      let alive=false;try{process.kill(guardian.pid,0);alive=true}catch{}
      guardianVerified=alive&&(guardian.supervisorPid===undefined||guardian.supervisorPid===listenerPid);
    }
  }catch{}
  const inventory=readMcpStateInventory();
  independentMcpVerified=inventory.directory==="present"&&inventory.rejected===0&&inventory.records.length>0&&
    ownerMap!==null&&inventory.records.every(record=>ownerMap.get(record.port)===record.pid&&record.pid!==listenerPid);
}else{
  if(!stageProfile) throw new Error("Staging registration requires --profile");
  const previousProfile=process.env.SUPERAGENT_CONFIG_DIR;
  try{process.env.SUPERAGENT_CONFIG_DIR=stageProfile;cold=await auditCoreColdStart(port)}
  finally{
    if(previousProfile===undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR=previousProfile;
  }
}
const decision=assessWindowsStartupRegistrationR5({
  port,stageProfileVerified:Boolean(stageProfile),ownerInventoryVerified:ownerMap!==null,
  listenerPid,scheduledTaskPresent:taskStatus,coldAssessment:cold!.assessment,
  productionRequested:production,supervisedCoreVerified,guardianVerified,independentMcpVerified,
});
const expected=production?"production_registration_candidate":"staging_registration_candidate";
if(decision.status!==expected)
  throw new Error("Windows startup registration refused: "+decision.blockers.join(", "));
console.log("Windows startup preflight passed: "+decision.status+". Task will not be started now.");

const stat=fs.existsSync(root)?fs.lstatSync(root):null;
if(stat&&(!stat.isDirectory()||stat.isSymbolicLink())) throw new Error("Unsafe startup plan directory");
fs.mkdirSync(root,{recursive:true,mode:0o700});
if(fs.existsSync(launcherFile)) throw new Error("Startup launcher already exists; no overwrite. Inspect before manual removal.");
const handle=fs.openSync(launcherFile,"wx",0o600);
try{fs.writeFileSync(handle,plan.launcherContent);fs.fsyncSync(handle)}finally{fs.closeSync(handle)}

const finalOwners=readListenerOwners();
if(!finalOwners) throw new Error("OS listener ownership became unverifiable before task registration");
if(production){
  if(finalOwners.get(port)!==listenerPid) throw new Error("Production Core listener changed before task registration");
}else if(finalOwners.has(port)) throw new Error("Staging listener appeared before task registration");

const encoded=Buffer.from(plan.registerCommand,"utf16le").toString("base64");
const proc=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",encoded],
  {encoding:"utf8",timeout:20_000,windowsHide:true,maxBuffer:12_000});
if(proc.status!==0) throw new Error("Task registration failed without starting Core. Launcher retained for inspection. "+(proc.stderr||"").slice(0,400));
console.log("Windows per-user logon task registered (not started). Verify with: "+plan.inspectCommand);
