"use strict";
/**
 * Native Lifecycle console. No secret, arbitrary URL, shell or PID arguments
 * ever leave the JS layer. All mutable operations require a distinct
 * owner-bound plan, explicit human confirmation, and the native/Core gate.
 */
const life = (id) => document.getElementById(id);
const lifecycleServices = new Set(["core","tray","transport","channel_host","vision","guardian","daemon"]);
const lifecycleActions = new Set(["start","stop","restart","upgrade","rollback","recycle"]);
const lifecyclePlanFields = [
  "service","port","operationId","expectedBuildDigest",
  "expectedReleaseRevision","expectedCurrentDigest",
  "expectedOwnerPid","expectedInstanceId","expectedSupervisorPid",
  "expectedProcessIdentity","expectedLegacyCommandDigest","clientMode",
  "expectedWorkerPid","expectedRunning","noActiveJobs","noCoreShutdown",
  "noPublicIngress","corePort","channelMode","wsPort",
];
const lifecyclePorts = {core:7888,transport:7891,channel_host:7892,vision:8095,guardian:7888,daemon:7888};
const lifecycleInvoke = async (request) => {
  const fn=window.__TAURI__?.core?.invoke;
  if(typeof fn!=="function")throw new Error("Lifecycle management is available only in the native Tray desktop application");
  return fn("lifecycle_console_request",{request});
};
let lifecycleBusy=false;
let lifecyclePlan=null;
let lifecycleProfiles=null;
let lifecycleRevision=null;
let lifecycleLastRefresh=0;
function lifeFeedback(message,isError=false){
  const node=life("lifecycle-feedback");
  if(!node)return;
  node.textContent=String(message);
  node.classList.toggle("lifecycle-error",isError);
}
function lifeNode(tag,text,css=""){
  const node=document.createElement(tag);
  node.textContent=String(text);
  if(css)node.className=css;
  return node;
}
function lifeResetPlan(reason="A plan verifies ownership. Review it before confirmation."){
  lifecyclePlan=null;
  const node=life("lifecycle-plan-details");
  if(node)node.textContent=reason;
  const button=life("lifecycle-execute");
  if(button)button.disabled=true;
}
function lifeUpdatePort(){
  const service=life("lifecycle-service")?.value;
  const action=life("lifecycle-action")?.value;
  const port=life("lifecycle-port");
  if(port){
    port.disabled=service==="tray";
    if(service!=="tray"&&lifecyclePorts[service])port.value=String(lifecyclePorts[service]);
  }
  if(service==="core"&&action!=="recycle")life("lifecycle-action").value="recycle";
  else if(service!=="core"&&action==="recycle")life("lifecycle-action").value="restart";
  if(action==="upgrade"||action==="rollback"){
    if(service!=="tray")life("lifecycle-action").value=service==="core"?"recycle":"restart";
  }
  for(const option of Array.from(life("lifecycle-action")?.options||[])){
    if(option.value==="upgrade"||option.value==="rollback")option.disabled=service!=="tray";
    else if(option.value==="recycle")option.disabled=service!=="core";
    else if(service==="core")option.disabled=true;
    else option.disabled=false;
  }
  lifeResetPlan();
}
function lifeSelectProfile(){
  const service=life("lifecycle-profile-service")?.value;
  const profile=lifecycleProfiles?.find(item=>item.service===service);
  const enable=life("lifecycle-auto-recover");
  if(!profile){
    if(enable)enable.disabled=true;
    return;
  }
  if(enable){
    enable.disabled=!["tray","transport","channel_host","vision","guardian"].includes(service);
    enable.checked=profile.autoRecover===true;
  }
  life("lifecycle-failure-threshold").value=String(profile.failureThreshold);
  life("lifecycle-max-restarts").value=String(profile.maxRestartsPerHour);
}
function lifeRenderSummary(data){
  const summary=data?.summary||{};
  life("lifecycle-ready").textContent=String(summary.ready??"—");
  life("lifecycle-degraded").textContent=String(summary.degraded??"—");
  life("lifecycle-unavailable").textContent=String(summary.unavailable??"—");
  const digest=data?.trayRelease?.activeDigest;
  life("lifecycle-release").textContent=typeof digest==="string"?digest.slice(0,9):"Not staged";
  const holder=life("lifecycle-services");
  if(!holder)return;
  holder.replaceChildren();
  const checks=Array.isArray(data?.checks)?data.checks:[];
  for(const item of checks){
    const card=lifeNode("article","","lifecycle-service-card");
    const header=lifeNode("div","","lifecycle-service-head");
    header.append(lifeNode("strong",item.service||"Unknown service"),
      lifeNode("span",item.ready?"Ready":item.alive?"Degraded":"Inactive",
        "lifecycle-chip "+(item.ready?"success":item.alive?"warning":"muted")));
    const description=lifeNode("small",
      (item.ownerVerified?"Verified owner":"Owner not verified")+" · "+(item.state||"unknown"),
      "lifecycle-service-note");
    const deps=(Array.isArray(item.dependsOn)?item.dependsOn:[])
      .map(x=>x.service+": "+x.state).join(" · ");
    card.append(header,description);
    if(deps)card.append(lifeNode("small","Dependencies: "+deps,"lifecycle-service-note"));
    if(item.reason)card.append(lifeNode("small",item.reason,"lifecycle-service-note"));
    holder.append(card);
  }
  if(!checks.length)holder.append(lifeNode("p","No service health data returned","lifecycle-hint"));
}
function lifeRenderEvents(data){
  const holder=life("lifecycle-events");
  if(!holder)return;
  holder.replaceChildren();
  const events=Array.isArray(data?.events)?data.events:[];
  for(const event of events){
    const timestamp=Number.isFinite(event.at)?new Date(event.at).toLocaleString():"Unknown date";
    const item=lifeNode("div","","lifecycle-event");
    item.append(lifeNode("strong",(event.service||"service")+" · "+(event.action||"action")),
      lifeNode("span",(event.outcome||"unknown")+" · "+timestamp,"lifecycle-event-time"));
    if(event.errorCode)item.append(lifeNode("small",event.errorCode,"lifecycle-hint"));
    holder.append(item);
  }
  if(!events.length)holder.append(lifeNode("p","No lifecycle events recorded","lifecycle-hint"));
}
async function lifecycleRefresh(force=false){
  if(lifecycleBusy)return;
  if(!force&&Date.now()-lifecycleLastRefresh<8000)return;
  lifecycleLastRefresh=Date.now();
  lifeFeedback("Verifying service owners, dependencies and lifecycle history...");
  const trigger=life("lifecycle-refresh");
  if(trigger)trigger.disabled=true;
  try{
    const calls=await Promise.allSettled([
      lifecycleInvoke({action:"dashboard",limit:20}),
      lifecycleInvoke({action:"profile"}),
      lifecycleInvoke({action:"logs",limit:30}),
      lifecycleInvoke({action:"watchdog"}),
    ]);
    const [dashboard,profiles,logs,watchdog]=calls.map(x=>x.status==="fulfilled"?x.value:null);
    if(dashboard)lifeRenderSummary(dashboard);
    if(profiles&&Array.isArray(profiles.profiles)){
      lifecycleProfiles=profiles.profiles;
      lifecycleRevision=profiles.revision;
      lifeSelectProfile();
    }
    if(logs)lifeRenderEvents(logs);
    if(watchdog){
      const count=Array.isArray(watchdog.services)?watchdog.services.length:0;
      life("lifecycle-watchdog").textContent=
        "Watchdog advisory only · "+count+" service candidates · Automatic recovery requires a separately approved worker.";
    }
    const successful=[dashboard,profiles,logs,watchdog].filter(Boolean).length;
    lifeFeedback(successful===4?"Lifecycle dashboard updated from the selected authenticated Core.":
      successful?"Lifecycle partially available: "+successful+"/4 sections loaded.":
      "Lifecycle API unavailable. Start or select a Core with the updated native lifecycle endpoint.",
      successful===0);
  }catch(e){
    lifeFeedback("Lifecycle status could not be verified: "+String(e),true);
  }finally{
    if(trigger)trigger.disabled=false;
  }
}
async function lifecyclePrepare(){
  if(lifecycleBusy)return;
  const service=life("lifecycle-service")?.value;
  const action=life("lifecycle-action")?.value;
  if(!lifecycleServices.has(service)||!lifecycleActions.has(action))return;
  lifeResetPlan("Checking verified owner and preparing a non-mutating plan...");
  lifecycleBusy=true;
  try{
    const request={action:"plan",service,targetAction:action};
    if(service!=="tray"){
      const port=Number(life("lifecycle-port")?.value);
      if(!Number.isSafeInteger(port)||port<1024||port>65535)
        throw new Error("Enter a valid service port from 1024 to 65535.");
      request.port=port;
      if(service==="transport"&&action==="start")request.corePort=7888;
      if(service==="channel_host"&&action==="start"){
        request.channelMode="idle";
        request.wsPort=9225;
      }
    }
    const plan=await lifecycleInvoke(request);
    if(!plan||plan.service!==service||plan.action!==action||

       typeof plan.operationId!=="string")
      throw new Error("Selected Core did not return a valid owner-bound plan.");
    lifecyclePlan=Object.fromEntries(lifecyclePlanFields.filter(key=>
      Object.prototype.hasOwnProperty.call(plan,key)).map(key=>[key,plan[key]]));
    lifecyclePlan.action=action;
    const lines=[
      "Service: "+service,
      "Action: "+action,
      "Operation ID: "+plan.operationId,
      "Expected owner PID: "+(plan.expectedOwnerPid??"not specified"),
      "Build SHA-256: "+(plan.expectedBuildDigest??"not applicable"),
      "Safety: "+(plan.note||"Owner-attested, explicit approval required"),
    ];
    life("lifecycle-plan-details").textContent=lines.join("\n");
    life("lifecycle-execute").disabled=false;
    lifeFeedback("Plan prepared. Review the owner identity and consequences before executing.");
  }catch(e){
    lifeResetPlan("Plan rejected: "+String(e));
    lifeFeedback("Planning failed: "+String(e),true);
  }finally{lifecycleBusy=false;}
}
async function lifecycleExecute(){
  if(lifecycleBusy||!lifecyclePlan)return;
  const plan=lifecyclePlan;
  if(plan.service!==life("lifecycle-service")?.value||
     plan.action!==life("lifecycle-action")?.value){
    lifeResetPlan("Service/action changed. Create a new plan.");
    return;
  }
  const consequence=plan.action==="recycle"?
    "Recycle this exact legacy Core into a supervised Core. Existing Core API connections will disconnect briefly; MCP/tunnel owners are not restarted.":
    plan.action==="upgrade"?
      "Upgrade only this verified Tray. The current Tray window may close, then restart.":
      plan.action==="rollback"?
        "Rollback only this verified Tray. The window may close during restart.":
        "Execute "+plan.action+" on "+plan.service+" with the exact owner and operation ID?";
  if(!window.confirm(consequence+"\n\nOperation ID: "+plan.operationId+
      "\nDo not retry with a new ID if the result times out."))return;
  lifecycleBusy=true;
  let verifiedResult=false;
  life("lifecycle-execute").disabled=true;
  lifeFeedback("Executing owner-verified operation. Awaiting an attested result...");
  try{
    const result=await lifecycleInvoke({...plan,confirm:true});
    if(result?.replayed===true)lifeFeedback("Previous result returned; no duplicate mutation performed.");
    else if(result?.scheduled===true)
      lifeFeedback("Recycle accepted. The legacy Core will shut down gracefully and return under supervised lifecycle ownership.");
    else if(result?.changed===true||result?.verified===true)
      lifeFeedback("Operation completed and verified by the selected Core.");
    else lifeFeedback("Result returned. Review owner status before another operation.");
    lifeResetPlan("Operation completed. Prepare a new plan for another action.");
    verifiedResult=true;
  }catch(e){
    // Preserve same operation ID in memory. Never auto-retry after a timeout.
    life("lifecycle-plan-details").textContent=
      "OUTCOME NOT VERIFIED\nOperation ID: "+plan.operationId+
      "\nDo not create a new operation ID or retry automatically. Inspect lifecycle logs and reconcile through an authorized operator.\n"+String(e);
    lifeFeedback("Operation result uncertain or rejected. Original operation ID retained.",true);
  }finally{
    lifecycleBusy=false;
    if(verifiedResult)await lifecycleRefresh(true);
  }
}
async function lifecycleSavePolicy(){
  if(lifecycleBusy||!lifecycleProfiles||!lifecycleRevision)return;
  const service=life("lifecycle-profile-service")?.value;
  const failures=Number(life("lifecycle-failure-threshold")?.value);
  const budget=Number(life("lifecycle-max-restarts")?.value);
  const auto=life("lifecycle-auto-recover")?.checked===true;
  if(!lifecycleServices.has(service)||!Number.isSafeInteger(failures)||
     failures<2||failures>12||!Number.isSafeInteger(budget)||budget<0||budget>6){
    lifeFeedback("Invalid recovery policy range.",true);return;
  }
  if(!window.confirm("Change recovery policy for "+service+"?\n"+
    "This only changes configuration. No service restarts, and the watchdog remains opt-in."))return;
  lifecycleBusy=true;
  try{
    const result=await lifecycleInvoke({action:"configure",service,
      revision:lifecycleRevision,confirm:true,autoRecover:auto,
      failureThreshold:failures,maxRestartsPerHour:budget});
    if(result?.changed!==true)throw new Error("Core did not verify the profile update");
    lifeFeedback("Recovery policy saved. No service was restarted.");
    lifecycleLastRefresh=0;
  }catch(e){
    lifeFeedback("Recovery policy rejected: "+String(e),true);
  }finally{
    lifecycleBusy=false;
    void lifecycleRefresh(true);
  }
}
function lifecycleInstall(){
  life("lifecycle-refresh")?.addEventListener("click",()=>lifecycleRefresh(true));
  life("lifecycle-service")?.addEventListener("change",lifeUpdatePort);
  life("lifecycle-action")?.addEventListener("change",lifeUpdatePort);
  life("lifecycle-port")?.addEventListener("input",()=>lifeResetPlan("Port changed; prepare a new plan."));
  life("lifecycle-plan")?.addEventListener("click",lifecyclePrepare);
  life("lifecycle-execute")?.addEventListener("click",lifecycleExecute);
  life("lifecycle-profile-service")?.addEventListener("change",lifeSelectProfile);
  life("lifecycle-save-profile")?.addEventListener("click",lifecycleSavePolicy);
  window.addEventListener("superagent-core-selected",()=>{
    lifeResetPlan("Selected Core changed; request a new plan.");
    lifecycleLastRefresh=0;
    void lifecycleRefresh(true);
  });
  lifeUpdatePort();
}
window.__superagentLifecycleRefresh=lifecycleRefresh;
lifecycleInstall();
