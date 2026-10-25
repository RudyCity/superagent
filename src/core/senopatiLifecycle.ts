/** V6.9 lifecycle bridge for SuperAgent CLI and T-Line REST core.
 *
 * Starts only the model-specific watchdog. It does not kill/restart the
 * caller, desktop app, browser, MCP, tunnels, or other agent processes.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {spawn} from "node:child_process";
import crypto from "node:crypto";
import {getPackageRootDir,getRootConfigDir} from "./config/paths.js";
import {getModernPolicy, type ModernPolicy} from "./senopatiModernBert.js";

export type SenopatiLifecycleResult =
  "disabled" | "not-configured" | "already-running" | "started" | "launch-failed";

export type SenopatiLifecycleConfig={
 autoStartOnAppLaunch:boolean;
 keepModelAfterClientExit:true;
};
export const DEFAULT_SENOPATI_LIFECYCLE:SenopatiLifecycleConfig={
 autoStartOnAppLaunch:true,keepModelAfterClientExit:true,
};
export function senopatiLifecycleConfigPath():string {
 return path.join(getRootConfigDir(),"senopati-lifecycle.json");
}
export function parseSenopatiLifecycleConfig(value:unknown):SenopatiLifecycleConfig{
 if(!value || typeof value!=="object" || Array.isArray(value)) {
  throw new Error("Invalid lifecycle config");
 }
 const p=value as Partial<SenopatiLifecycleConfig>;
 if(typeof p.autoStartOnAppLaunch!=="boolean" ||
    p.keepModelAfterClientExit!==true)throw new Error("Unsafe Senopati lifecycle config");
 return {autoStartOnAppLaunch:p.autoStartOnAppLaunch,keepModelAfterClientExit:true};
}
export function readSenopatiLifecycleConfig():SenopatiLifecycleConfig{
 const file=senopatiLifecycleConfigPath();
 if(!fs.existsSync(file)){
  // Isolated test/staging profiles must explicitly opt into a heavyweight
  // background model. Only the canonical per-user profile auto-starts by
  // default. This also protects REST server smoke tests from leaked daemons.
  const expected=path.resolve(os.homedir(),".superagent-r").toLowerCase();
  const actual=path.resolve(getRootConfigDir()).toLowerCase();
  return {autoStartOnAppLaunch:actual===expected,
   keepModelAfterClientExit:true};
 }
 try{
  const stat=fs.lstatSync(file);
  if(!stat.isFile() || stat.isSymbolicLink() ||
     stat.size<10 || stat.size>2048)throw new Error("Unsafe lifecycle file");
  return parseSenopatiLifecycleConfig(JSON.parse(fs.readFileSync(file,"utf8")));
 }catch{
  // Broken config fails closed rather than spawning surprise background work.
  return {autoStartOnAppLaunch:false,keepModelAfterClientExit:true};
 }
}
export function setSenopatiLifecycleConfig(input:SenopatiLifecycleConfig):SenopatiLifecycleConfig{
 const config=parseSenopatiLifecycleConfig(input);
 const file=senopatiLifecycleConfigPath();
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 const tmp=file+"."+process.pid+"."+crypto.randomUUID()+".tmp";
 try{
  fs.writeFileSync(tmp,JSON.stringify(config,null,2)+"\n",
    {encoding:"utf8",mode:0o600,flag:"wx"});
  fs.renameSync(tmp,file);
 }finally{try{fs.rmSync(tmp,{force:true});}catch{}}
 return config;
}
let startupPromise:Promise<SenopatiLifecycleResult>|null=null;
export function eligibleForSenopatiLifecycle(
  policy:Pick<ModernPolicy,"backend"|"enabled"|"inferenceMode">,
  options:{disable?:boolean;coreWorker?:boolean;testMode?:boolean}={},
):boolean {
 return !options.disable && !options.coreWorker && !options.testMode &&
  policy.enabled===true &&
  policy.backend==="mmbert-v64-seed73" &&
  policy.inferenceMode==="shared_only";
}
export async function startSenopatiLifecycle(
 options:{launch?:()=>Promise<boolean>;check?:()=>Promise<boolean>}={},
):Promise<SenopatiLifecycleResult>{
 if(process.env.SUPERAGENT_SENOPATI_AUTOSTART==="0" ||
    !readSenopatiLifecycleConfig().autoStartOnAppLaunch)return "disabled";
 const policy=getModernPolicy();
 if(!eligibleForSenopatiLifecycle(policy,{
  coreWorker:process.env.SUPERAGENT_CORE_WORKER==="1",
  testMode:process.env.NODE_ENV==="test" ||
           Boolean(process.env.VITEST) || Boolean(process.env.BUN_TEST),
 }))return "not-configured";
 if(startupPromise)return startupPromise;
 startupPromise=(async()=>{
  try{
   if(options.check ? await options.check() : await watchdogIsHealthy(policy.precision)){
    return "already-running";
   }
   const ok=await (options.launch?options.launch():spawnWatchdogLauncher());
   return ok?"started":"launch-failed";
  }catch{return "launch-failed";}
 })();
 try{return await startupPromise;}
 finally{startupPromise=null;}
}
async function watchdogIsHealthy(precision:string):Promise<boolean>{
 const {readSenopatiWatchdogStatus}=await import("./senopatiWatchdogStatus.js");
 const owner=readSenopatiWatchdogStatus();
 if(!owner?.alive)return false;
 const {sharedSenopatiStatus}=await import("./senopatiSharedClient.js");
 const model=await sharedSenopatiStatus();
 return Boolean(model && model.precision===precision);
}
async function spawnWatchdogLauncher():Promise<boolean>{
 const root=getPackageRootDir();
 const script=path.join(root,"scripts","senopati-watchdog.ts");
 if(!fs.existsSync(script) || !(process.versions as any).bun)return false;
 return new Promise(resolve=>{
  const child=spawn(process.execPath,[script,"start"],{
    cwd:root,windowsHide:true,stdio:"ignore",env:{...process.env},
  });
  let completed=false;
  const finish=(ok:boolean)=>{
   if(completed)return;
   completed=true;
   clearTimeout(timer);
   resolve(ok);
  };
  const timer=setTimeout(()=>{
   // Kill only our short-lived launch CLI, not the watchdog/model.
   child.kill();
   finish(false);
  },15_000);
  child.once("error",()=>finish(false));
  child.once("exit",code=>finish(code===0));
 });
}
/** Kick off owner-safe startup without blocking CLI/UI. */
export function scheduleSenopatiLifecycle():void {
 void startSenopatiLifecycle().catch(()=>{});
}
