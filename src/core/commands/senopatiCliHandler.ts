/** Operator-facing Senopati lifecycle CLI.
 *
 * superagent senopati status | start | restart | stop | doctor
 * superagent senopati autostart on|off
 * superagent senopati login status|install|remove
 *
 * Control plane is local and does not expose model RPC over HTTP/tunnels.
 */
import path from "node:path";
import {spawn} from "node:child_process";
import {getPackageRootDir} from "../config/paths.js";
import {getModernPolicy} from "../senopatiModernBert.js";
import {
 readSenopatiLifecycleConfig,setSenopatiLifecycleConfig,
 senopatiLifecycleConfigPath,
} from "../senopatiLifecycle.js";
import {readSenopatiWatchdogStatus} from "../senopatiWatchdogStatus.js";
import {
 sharedSenopatiStatus,stopSharedSenopati,
} from "../senopatiSharedClient.js";
import {
 senopatiWindowsStartupStatus,installSenopatiWindowsStartup,
 uninstallSenopatiWindowsStartup,
} from "../senopatiWindowsStartup.js";

const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function output(value:unknown):void{
 console.log(JSON.stringify(value,null,2));
}
async function executeWatchdog(subcommand:"start"|"stop"):Promise<boolean>{
 if(!(process.versions as any).bun)throw new Error("Bun runtime required");
 const script=path.join(getPackageRootDir(),"scripts","senopati-watchdog.ts");
 return new Promise<boolean>(resolve=>{
  const child=spawn(process.execPath,[script,subcommand],{
   cwd:getPackageRootDir(),windowsHide:true,stdio:"ignore",env:{...process.env},
  });
  let finished=false;
  const complete=(success:boolean)=>{
   if(finished)return;
   finished=true;clearTimeout(deadline);resolve(success);
  };
  const deadline=setTimeout(()=>{
   child.kill();complete(false);
  },15_000);
  child.once("error",()=>complete(false));
  child.once("exit",code=>complete(code===0));
 });
}
async function healthyWithin(
 maximumMs:number,
 predicate:(pid:number)=>boolean=()=>true,
):Promise<Awaited<ReturnType<typeof sharedSenopatiStatus>>>{
 const expiry=Date.now()+maximumMs;
 do{
  const health=await sharedSenopatiStatus();
  if(health && predicate(health.pid))return health;
  await sleep(350);
 }while(Date.now()<expiry);
 return null;
}
export async function handleSenopatiCliCommand(args:string[]):Promise<number>{
 const [action="status",sub]=args;
 try {
  if(["help","--help","-h"].includes(action)){
   console.log([
    "Senopati shared inference lifecycle",
    "  superagent senopati status",
    "  superagent senopati doctor",
    "  superagent senopati start",
    "  superagent senopati restart",
    "  superagent senopati stop",
    "  superagent senopati autostart on|off",
    "  superagent senopati login status|install|remove",
    "All lifecycle actions are local; tool permission remains independent.",
   ].join("\n"));
   return 0;
  }
  if(action==="status" || action==="doctor"){
   const [watchdog,model]=await Promise.all([
    Promise.resolve(readSenopatiWatchdogStatus()),sharedSenopatiStatus(),
   ]);
   const policy=getModernPolicy();
   const healthy=Boolean(
    model && watchdog?.alive && model.precision===policy.precision &&
    policy.inferenceMode==="shared_only");
   const report={
    mode:action,healthy,
    policy:{backend:policy.backend,enabled:policy.enabled,
      precision:policy.precision,inferenceMode:policy.inferenceMode,
      preserveLegacySafety:policy.preserveLegacySafety,
      noAuthorizationFromModel:policy.noAuthorizationFromModel},
    model:model||"offline",
    watchdog:watchdog||"offline",
    lifecycle:readSenopatiLifecycleConfig(),
    lifecycleFile:senopatiLifecycleConfigPath(),
    windowsLogon:senopatiWindowsStartupStatus(),
    toolExecutionAllowedByClassifier:false,
   };
   output(report);
   return action==="doctor"&&!healthy?2:0;
  }
  if(action==="autostart"){
   if(sub!=="on" && sub!=="off"){
    throw new Error("Usage: superagent senopati autostart on|off");
   }
   const updated=setSenopatiLifecycleConfig({
    autoStartOnAppLaunch:sub==="on",keepModelAfterClientExit:true,
   });
   output({updated,modelNotRestarted:true});
   return 0;
  }
  if(action==="login"){
   if(!sub || sub==="status"){
    output(senopatiWindowsStartupStatus());return 0;
   }
   if(sub==="install"){
    output({installed:true,file:installSenopatiWindowsStartup(),
      scope:"current Windows user at logon"});
    return 0;
   }
   if(sub==="remove"){
    output({removed:uninstallSenopatiWindowsStartup()});return 0;
   }
   throw new Error("Usage: superagent senopati login status|install|remove");
  }
  if(action==="start"){
   const policy=getModernPolicy();
   if(!policy.enabled || policy.inferenceMode!=="shared_only"){
    throw new Error("Enable guarded shared_only Senopati routing first");
   }
   const ok=await executeWatchdog("start");
   if(!ok)throw new Error("Watchdog launcher failed");
   const health=await healthyWithin(25_000);
   output({started:Boolean(health),health:health||"offline",
      modelAndWatchdogOnly:true});
   return health?0:2;
  }
  if(action==="restart"){
   const policy=getModernPolicy();
   if(!policy.enabled || policy.inferenceMode!=="shared_only"){
    throw new Error("Guarded shared_only policy required");
   }
   const before=await sharedSenopatiStatus();
   const watch=readSenopatiWatchdogStatus();
   if(!watch?.alive && !(await executeWatchdog("start"))){
    throw new Error("Watchdog could not be started");
   }
   if(before){
    if(!(await stopSharedSenopati()))throw new Error("Model refused controlled stop");
   }
   const after=await healthyWithin(35_000,pid=>!before || pid!==before.pid);
   output({restarted:Boolean(after),previousModelPid:before?.pid||null,
     newModelPid:after?.pid||null,allExternalSessionsUntouched:true});
   return after?0:2;
  }
  if(action==="stop"){
   // Owner-safe explicit shutdown: stop monitoring FIRST so it won't race to
   // relaunch the model while graceful inference drain is underway.
   const watch=readSenopatiWatchdogStatus();
   const watchStopped=!watch?.alive || await executeWatchdog("stop");
   if(!watchStopped)throw new Error("Refused model shutdown: watchdog did not stop");
   const model=await sharedSenopatiStatus();
   const modelStopped=!model || await stopSharedSenopati();
   output({watchdogStopped:watchStopped,modelStopAcknowledged:modelStopped,
      externalTunnelsSessionsCliUnaffected:true});
   return modelStopped?0:2;
  }
  throw new Error("Unknown command; run superagent senopati help");
 }catch(error){
  console.error("Senopati lifecycle: "+String(error));
  return 1;
 }
}
