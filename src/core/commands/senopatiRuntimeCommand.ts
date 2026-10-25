/** Local-only Senopati slash command; no tool authorization. */
import {registry} from "./registry.js";
import type {SlashCommand} from "./types.js";
import {getModernPolicy} from "../senopatiModernBert.js";
import {readSenopatiLifecycleConfig,setSenopatiLifecycleConfig}
 from "../senopatiLifecycle.js";
import {sharedSenopatiStatus} from "../senopatiSharedClient.js";
import {readSenopatiWatchdogStatus} from "../senopatiWatchdogStatus.js";
import {senopatiWindowsStartupStatus} from "../senopatiWindowsStartup.js";

export const senopatiRuntimeCommand:SlashCommand={
 name:"senopati",
 description:"Inspect/configure shared Senopati lifecycle without touching other services",
 async execute(args,ctx){
  const items=args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const action=items[0]||"status";
  if(action==="help"){
   ctx.addLine({type:"system",content:[
    "/senopati status",
    "/senopati autostart on|off",
    "Terminal: superagent senopati doctor|start|restart|stop",
    "Windows login: superagent senopati login status|install|remove",
    "No model prediction grants tool or tenant permissions.",
   ].join("\n"),timestamp:Date.now()});
   return;
  }
  if(action==="autostart"){
   if(items[1]!=="on" && items[1]!=="off"){
    ctx.addLine({type:"error",content:"Use /senopati autostart on|off",
      timestamp:Date.now()});
    return;
   }
   const setting=setSenopatiLifecycleConfig({
    autoStartOnAppLaunch:items[1]==="on",keepModelAfterClientExit:true,
   });
   ctx.addLine({type:"system",content:
    "Senopati app-launch autostart: "+(setting.autoStartOnAppLaunch?"ON":"OFF")+
    ". Existing model process and tunnels were not restarted.",
    timestamp:Date.now()});
   return;
  }
  if(action!=="status"){
   ctx.addLine({type:"error",content:"Use /senopati status or /senopati help",
    timestamp:Date.now()});
   return;
  }
  try{
   const [model,watch]=await Promise.all([
    sharedSenopatiStatus(),Promise.resolve(readSenopatiWatchdogStatus()),
   ]);
   const cfg=getModernPolicy();
   const startup=readSenopatiLifecycleConfig();
   const windows=senopatiWindowsStartupStatus();
   const modelLabel=model?"ONLINE PID "+model.pid+" ("+model.rssMiB+" MiB RAM)":
    "OFFLINE (legacy fallback)";
   const watchLabel=watch?.alive?"ONLINE PID "+watch.pid:"OFFLINE";
   ctx.addLine({type:"system",content:[
    "SENOPATI SHARED CLASSIFIER",
    "Backend: "+cfg.backend+" / "+cfg.precision+" / "+cfg.inferenceMode,
    "Model: "+modelLabel,
    "Watchdog: "+watchLabel,
    "Tokenizer: "+(model?.tokenizerEngine||"not loaded"),
    "Active requests: "+(model?.active||0)+", queued: "+(model?.queued||0),
    "Autostart on CLI/T-Line launch: "+(startup.autoStartOnAppLaunch?"ON":"OFF"),
    "Windows logon startup: "+(windows.managed?"INSTALLED":"NOT INSTALLED"),
    "Original destructive guardrail stays active; no classifier permissions.",
   ].join("\n"),timestamp:Date.now()});
  }catch(error){
   ctx.addLine({type:"error",content:String(error),timestamp:Date.now()});
  }
 },
};
registry.register(senopatiRuntimeCommand);
