"use strict";
/**
 * Native Lifecycle console. No secret, arbitrary URL, shell or PID arguments
 * ever leave the JS layer. All mutable operations require a distinct
 * owner-bound plan, explicit human confirmation, and the native/Core gate.
 */
const life = (id) => document.getElementById(id);
const lifecycleServices = new Set(["core","tray","transport","channel_host","vision","guardian","daemon"]);
const lifecycleActions = new Set(["start","stop","restart","upgrade","rollback","drain","recycle"]);
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
let lifecycleOwnerEpoch=0;
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
  const choice=life("lifecycle-action");
  if(service==="core"&&!["restart","rollback","drain","recycle"].includes(choice.value))
    choice.value="restart";
  else if(service!=="core"&&["recycle","drain"].includes(choice.value))
    choice.value="restart";
  else if(service!=="tray"&&service!=="core"&&["upgrade","rollback"].includes(choice.value))
    choice.value="restart";
  else if(service==="core"&&choice.value==="upgrade")
    choice.value="restart";
  for(const option of Array.from(choice?.options||[])){
    if(option.value==="upgrade")option.disabled=service!=="tray";
    else if(option.value==="rollback")option.disabled=service!=="tray"&&service!=="core";
    else if(option.value==="recycle"||option.value==="drain")
      option.disabled=service!=="core";
    else if(service==="core")option.disabled=option.value!=="restart";
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
let lifecycleMuseControlsNode = null;
function lifeUpdateMuseQuickControls() {
  const holder = lifecycleMuseControlsNode;
  if (!holder) return;
  holder.replaceChildren();
  const state = window.__superagentMuseControlState?.() || {available:false};
  const running = state.running === true;
  const options = running
    ? [["stop","Stop Muse Watch"],["restart","Restart Muse Watch"],
       ...(state.configStale ? [["apply-restart","Apply & Restart"]] : [])]
    : [["start-telegram","Start Muse · Telegram"],
       ["start-websocket","Start Muse · WebSocket"],
       ["start-tunnel","Start Muse · Tunnel"]];
  holder.append(lifeNode("small",
    state.available
      ? running ? "Core-local watcher active. Changes refuse queued or running tasks."
        : "Select a transport. The saved Muse settings are used for startup."
      : "Select a verified local Core in Runtime Detection to enable Muse controls.",
    "lifecycle-service-note"));
  for (const [action,label] of options) {
    const button = lifeNode("button",label,"button ghost");
    button.type = "button";
    button.disabled = !state.available || (running && !state.ownerPresent);
    button.addEventListener("click",()=>window.__superagentMuseQuickAction?.(action));
    holder.append(button);
  }
}
window.__superagentLifecycleUpdateMuseControls = lifeUpdateMuseQuickControls;

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
  lifecycleMuseControlsNode = null;
  const checks=Array.isArray(data?.checks)?data.checks:[];
  for(const item of checks){
    const card=lifeNode("article","","lifecycle-service-card");
    const header=lifeNode("div","","lifecycle-service-head");
    header.append(lifeNode("strong",item.service||"Unknown service"),
      lifeNode("span",item.ready?"Ready":item.state==="unverified"?"Unverified":
        item.alive?"Degraded":item.state==="inactive"?"Inactive":"Unknown",
        "lifecycle-chip "+(item.ready?"success":item.alive||item.state==="unverified"?"warning":"muted")));
    const description=lifeNode("small",
      (item.ownerVerified?"Verified owner":"Owner not verified")+" · "+(item.state||"unknown"),
      "lifecycle-service-note");
    const deps=(Array.isArray(item.dependsOn)?item.dependsOn:[])
      .map(x=>x.service+": "+x.state).join(" · ");
    card.append(header,description);
    if(deps)card.append(lifeNode("small","Dependencies: "+deps,"lifecycle-service-note"));
    if(item.reason)card.append(lifeNode("small",item.reason,"lifecycle-service-note"));
    if((item.service==="core"||item.service==="tray")&&data?.safeLifecycle){
      const verdict=data.safeLifecycle[item.service];
      const ready=verdict?.ready===true&&verdict?.mutationAuthorized===false;
      const codes=Array.isArray(verdict?.reasons)?verdict.reasons.join(", "):"NO_VERIFIED_EVIDENCE";
      card.append(lifeNode("small",
        ready?"Safe Restart: READY for a new owner-bound plan; approval still required":
        "Safe Restart: NO-GO · "+(verdict?.planErrorCode||codes),
        "lifecycle-service-note"));
    }
    holder.append(card);
    if(item.service==="muse"){
      const coreMuseCard=lifeNode("article","","lifecycle-service-card");
      coreMuseCard.append(lifeNode("strong","Core-local Muse Watch"),
        lifeNode("small",
          "Controls for the selected authenticated Core. Independent Muse/Telegram channel hosts have separate owners and status.",
          "lifecycle-service-note"));
      lifecycleMuseControlsNode=lifeNode("div","","runtime-lifecycle-group");
      lifecycleMuseControlsNode.setAttribute("aria-label","Core-local Muse Watch controls");
      coreMuseCard.append(lifecycleMuseControlsNode);
      holder.append(coreMuseCard);
    }
  }
  if(!checks.length)holder.append(lifeNode("p","No service health data returned","lifecycle-hint"));
  lifeUpdateMuseQuickControls();
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
  const epoch=lifecycleOwnerEpoch;
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
    // Discard responses to an earlier selected Core.
    if(epoch!==lifecycleOwnerEpoch)return;
    if(dashboard)lifeRenderSummary(dashboard);
    else {
      // Never leave a previous successful health snapshot visible as current.
      for(const id of ["lifecycle-ready","lifecycle-degraded","lifecycle-unavailable",
        "lifecycle-release"])life(id).textContent="—";
      const list=life("lifecycle-services");
      list.replaceChildren(lifeNode("p",
        "Owner status unavailable. Refresh before preparing a lifecycle plan.",
        "lifecycle-hint"));
      lifeResetPlan("Current Core ownership could not be verified; do not execute an earlier plan.");
      if(recyclePlan&&!recycleBusy)
        recycleInvalidate("Current Core ownership could not be verified. Generate a fresh recycle plan.");
    }
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
    const age=dashboard&&Number.isFinite(dashboard.observedAt)?
      " · inspected "+new Date(dashboard.observedAt).toLocaleTimeString():"";
    lifeFeedback(!dashboard?
      "Owner health unavailable; no previous health snapshot is trusted. "+successful+"/4 sections loaded.":
      successful===4?"Lifecycle dashboard updated from the selected authenticated Core"+age+".":
      "Lifecycle partially available: "+successful+"/4 sections loaded"+age+".",
      !dashboard);
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
  const epoch=lifecycleOwnerEpoch;
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
    if(epoch!==lifecycleOwnerEpoch)
      throw new Error("SELECTED_CORE_CHANGED_DURING_PLAN");
    if(!plan||plan.service!==service||plan.action!==action||

       typeof plan.operationId!=="string")
      throw new Error("Selected Core did not return a valid owner-bound plan.");
    if(service==="core"&&["restart","rollback","drain"].includes(action)&&
       (!Number.isSafeInteger(plan.expectedSupervisorPid)||
        !Number.isSafeInteger(plan.expectedWorkerPid)||
        typeof plan.expectedBuildDigest!=="string"))
      throw new Error("CORE_OWNER_BOUND_PLAN_REQUIRED: update Core and prepare a new plan.");
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
  const epoch=lifecycleOwnerEpoch;
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
        plan.service==="core"?
          "Rollback only the supervised Core generation. Existing sessions may be transferred or retained; MCP and tunnels are unaffected.":
          "Rollback only this verified Tray. The window may close during restart.":
        "Execute "+plan.action+" on "+plan.service+" with the exact owner and operation ID?";
  if(!window.confirm(consequence+"\n\nOperation ID: "+plan.operationId+
      "\nDo not retry with a new ID if the result times out."))return;
  lifecycleBusy=true;
  let verifiedResult=false;
  let mutationDispatched=false;
  life("lifecycle-execute").disabled=true;
  lifeFeedback("Revalidating safe restart readiness before execution...");
  try{
    if(plan.action==="restart"&&["core","tray"].includes(plan.service)){
      const snapshot=await lifecycleInvoke({action:"dashboard",limit:5});
      if(epoch!==lifecycleOwnerEpoch)
        throw new Error("SELECTED_CORE_CHANGED_DURING_PREFLIGHT");
      const gate=snapshot?.safeLifecycle?.[plan.service];
      if(gate?.ready!==true||gate?.mutationAuthorized!==false)
        throw new Error("SAFE_LIFECYCLE_RESTART_NO_GO: resolve build/owner/journal blockers.");
    }
    if(epoch!==lifecycleOwnerEpoch)
      throw new Error("SELECTED_CORE_CHANGED_BEFORE_DISPATCH");
    mutationDispatched=true;
    const result=await lifecycleInvoke({...plan,confirm:true});
    if(epoch!==lifecycleOwnerEpoch)
      throw new Error("SELECTED_CORE_CHANGED_OUTCOME_UNKNOWN");
    if(result?.replayed===true)lifeFeedback("Previous result returned; no duplicate mutation performed.");
    else if(result?.scheduled===true)
      lifeFeedback("Recycle accepted. The legacy Core will shut down gracefully and return under supervised lifecycle ownership.");
    else if(result?.changed===true||result?.verified===true)
      lifeFeedback("Operation completed and verified by the selected Core.");
    else lifeFeedback("Result returned. Review owner status before another operation.");
    lifeResetPlan("Operation completed. Prepare a new plan for another action.");
    verifiedResult=true;
  }catch(e){
    if(!mutationDispatched){
      lifeResetPlan("Safe preflight rejected; nothing was executed.\n"+String(e));
      lifeFeedback("Safe lifecycle NO-GO. No process was changed.",true);
    }else{
      // After an uncertain transport result never replay with a new ID.
      life("lifecycle-plan-details").textContent=
        "OUTCOME NOT VERIFIED\nOperation ID: "+plan.operationId+
        "\nDo not retry automatically. Inspect logs and use operator reconciliation.\n"+String(e);
      lifeFeedback("Operation result uncertain or rejected. Original operation ID retained.",true);
    }
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
    lifecycleOwnerEpoch+=1;
    lifeResetPlan("Selected Core changed; request a new plan.");
    lifecycleLastRefresh=0;
    void lifecycleRefresh(true);
  });
  lifeUpdatePort();
}
window.__superagentLifecycleRefresh=lifecycleRefresh;
lifecycleInstall();


/**
 * Global recycle is a distinct owner-checked transaction. Analyze creates only
 * a durable, expiring plan; execution uses the exact original operation ID.
 * The selected Core rechecks every preserved owner before touching a service.
 */
let recyclePlan=null;
let recyclePrepared=false;
let recycleBusy=false;
let recycleNeedsReconcile=false;
function recycleFeedback(message,error=false){
  const node=life("recycle-status-banner");
  if(!node)return;
  node.textContent=String(message);
  node.classList.toggle("recycle-error",error);
}
function recycleButtons(){
  life("recycle-analyze-btn").disabled=recycleBusy;
  life("recycle-plan-btn").disabled=recycleBusy||!recyclePlan;
  life("recycle-confirm-btn").disabled=recycleBusy||!recyclePrepared||
    !recyclePlan||recycleNeedsReconcile;
  life("recycle-reconcile-btn").disabled=recycleBusy||!recycleNeedsReconcile||
    !recyclePlan;
}
function recycleInvalidate(message="Analyze Recycle to generate a new owner-bound plan."){
  recyclePlan=null;
  recyclePrepared=false;
  recycleNeedsReconcile=false;
  const card=life("recycle-plan-card");
  if(card)card.hidden=true;
  const strip=life("recycle-timeline-strip");
  if(strip)strip.hidden=true;
  recycleButtons();
  recycleFeedback(message);
}
function recyclePhase(phase){
  const strip=life("recycle-timeline-strip");
  if(!strip)return;
  strip.hidden=false;
  const steps=["precheck","draining","migrating","verifying","completed"];
  const phaseIndex=steps.indexOf(phase);
  for(const el of Array.from(strip.querySelectorAll?.("[data-step]")||[])){
    const index=steps.indexOf(el.getAttribute("data-step"));
    el.classList.toggle("active",index===phaseIndex&&phase!=="completed");
    el.classList.toggle("completed",index>=0&&
      (index<phaseIndex||phase==="completed"&&index<=phaseIndex));
  }
}
function recycleRender(plan,inventory){
  const table=life("recycle-table-body");
  table.replaceChildren();
  const byName=new Map((Array.isArray(inventory?.services)?inventory.services:[])
    .map(item=>[item.service,item]));
  for(const child of plan.children){
    const before=byName.get(child.service);
    const tr=document.createElement("tr");
    for(const value of [
      child.service,
      before?.state||"Not verified",
      before?.ownerPid??"—",
      child.disposition,
      (Array.isArray(child.dependencyState)?child.dependencyState:[]).join(", ")||"—",
      child.reasonCode+": "+child.note,
    ])tr.append(lifeNode("td",value));
    table.append(tr);
  }
  for(const [id,value] of [
    ["recycle-metric-id",plan.operationId.slice(0,8)],
    ["recycle-metric-mutations",plan.summary.mutations],
    ["recycle-metric-noops",plan.summary.noops],
    ["recycle-metric-blocked",plan.summary.blocked],
    ["recycle-metric-expires",new Date(plan.expiresAt).toLocaleTimeString()],
  ])life(id).textContent=String(value);
  life("recycle-plan-card").hidden=true;
}
function recyclePlanExpired(){
  return !recyclePlan||!Number.isSafeInteger(recyclePlan.expiresAt)||
    Date.now()>=recyclePlan.expiresAt;
}
async function recycleAnalyze(){
  if(recycleBusy||lifecycleBusy)return;
  const epoch=lifecycleOwnerEpoch;
  recycleInvalidate("Inspecting owners and generating a non-executing recycle plan...");
  recycleBusy=true;
  lifecycleBusy=true;
  recycleButtons();
  try{
    const inventory=await lifecycleInvoke({action:"inventory",service:"all"});
    const plan=await lifecycleInvoke({action:"plan",service:"all",targetAction:"recycle"});
    if(epoch!==lifecycleOwnerEpoch)
      throw new Error("SELECTED_CORE_CHANGED_DURING_RECYCLE_ANALYSIS");
    if(plan?.version!==1||typeof plan.operationId!=="string"||
      !Array.isArray(plan.children)||!plan.summary||
      plan.publicTunnelMutationAllowed!==false||
      plan.arbitraryPidKillAllowed!==false||
      !Number.isSafeInteger(plan.expiresAt)||Date.now()>=plan.expiresAt)
      throw new Error("Global recycle plan failed integrity/expiration checks");
    recyclePlan=plan;
    recycleRender(plan,inventory);
    recycleFeedback("Analysis prepared: "+plan.summary.mutations+" migrations, "+
      plan.summary.noops+" preserved, "+plan.summary.blocked+
      " blocked. Review the table and select Prepare Recycle Plan. No service changed.");
  }catch(error){
    recycleInvalidate("Recycle analysis failed safely: "+String(error));
    life("recycle-status-banner").classList.toggle("recycle-error",true);
  }finally{
    lifecycleBusy=false;
    recycleBusy=false;
    recycleButtons();
  }
}
function recyclePrepare(){
  if(recycleBusy||lifecycleBusy||!recyclePlan)return;
  if(recyclePlanExpired()){
    recycleInvalidate("Recycle plan expired. Re-analyze the current service owners.");
    return;
  }
  if(recyclePlan.summary.blocked>0){
    recycleFeedback("NO-GO: "+recyclePlan.summary.blocked+
      " services are blocked. Resolve them and generate a fresh plan.",true);
    return;
  }
  if(recyclePlan.summary.mutations===0){
    recycleFeedback("No migration is necessary. All eligible services are preserved or inactive.");
    return;
  }
  recyclePrepared=true;
  life("recycle-plan-card").hidden=false;
  recyclePhase("precheck");
  recycleButtons();
  recycleFeedback("Owner-bound recycle plan prepared. Review the expiry and impacts. "+
    "Execution still requires explicit confirmation and independent Core preflight.");
}
async function recycleExecute(){
  if(recycleBusy||lifecycleBusy||!recyclePrepared||recycleNeedsReconcile||
    !recyclePlan)return;
  if(recyclePlanExpired()){
    recycleInvalidate("Recycle plan expired. Re-analyze before any mutation.");
    return;
  }
  const epoch=lifecycleOwnerEpoch;
  const operationId=recyclePlan.operationId;
  if(!window.confirm("Execute global recycle with exactly this original operation ID?\n"+
    "Only proven legacy owners may be migrated. Core, Tray or Vision may restart.\n"+
    "Existing public tunnels and OAuth MCP owners must remain untouched.\n\n"+
    "Operation ID: "+operationId+"\n"+
    "Do not repeat this operation after a timeout."))return;
  recycleBusy=true;
  lifecycleBusy=true;
  recycleButtons();
  recyclePhase("migrating");
  recycleFeedback("Executing the reviewed plan. Do not retry if the connection drops...");
  let dispatched=false;
  try{
    if(epoch!==lifecycleOwnerEpoch)
      throw new Error("SELECTED_CORE_CHANGED_BEFORE_RECYCLE");
    dispatched=true;
    const result=await lifecycleInvoke({
      action:"recycle",service:"all",operationId,confirm:true,
    });
    if(epoch!==lifecycleOwnerEpoch)
      throw new Error("SELECTED_CORE_CHANGED_OUTCOME_UNKNOWN");
    if(!result||result.operationId!==operationId||
       !["completed","reconciled"].includes(result.status))
      throw new Error("Outcome not conclusively verified");
    recyclePhase("completed");
    recycleFeedback(result.replayed===true?
      "Previously completed operation verified; nothing ran twice.":
      "Recycle completed with owner re-verification. Refresh health to inspect service state.");
    recyclePlan=null;
    recyclePrepared=false;
  }catch(error){
    // Even a rejected remote request may have run before the response vanished.
    // An operator must review the original ID; no automatic retry.
    recycleNeedsReconcile=dispatched;
    recyclePrepared=false;
    recycleFeedback("OUTCOME UNKNOWN for "+operationId+
      ". Inspect the operation journal before manual reconciliation. "+
      String(error),true);
  }finally{
    lifecycleBusy=false;
    recycleBusy=false;
    recycleButtons();
  }
}
async function recycleReconcile(){
  if(recycleBusy||lifecycleBusy||!recycleNeedsReconcile||!recyclePlan)return;
  const epoch=lifecycleOwnerEpoch;
  const operationId=recyclePlan.operationId;
  if(!window.confirm("I reviewed the original operation journal and confirmed "+
    "the service owners are safe to reconcile.\n"+
    "This does not retry the recycle or terminate processes.\n"+
    "Original operation ID: "+operationId))return;
  recycleBusy=true;
  lifecycleBusy=true;
  recycleButtons();
  try{
    if(epoch!==lifecycleOwnerEpoch)
      throw new Error("SELECTED_CORE_CHANGED_BEFORE_RECONCILE");
    const result=await lifecycleInvoke({
      action:"reconcile",service:"all",operationId,confirm:true,reviewed:true,
    });
    if(epoch!==lifecycleOwnerEpoch)
      throw new Error("SELECTED_CORE_CHANGED_OUTCOME_UNKNOWN");
    if(result?.status!=="reconciled"||result.operationId!==operationId)
      throw new Error("Reconciliation was not verified");
    recycleNeedsReconcile=false;
    recyclePlan=null;
    recyclePhase("completed");
    recycleFeedback("Original operation reconciled. Generate a new plan for any further actions.");
  }catch(error){
    recycleFeedback("Reconciliation refused or uncertain for "+operationId+
      "; no automatic retry. "+String(error),true);
  }finally{
    recycleBusy=false;
    lifecycleBusy=false;
    recycleButtons();
  }
}
function recycleInstall(){
  life("recycle-analyze-btn")?.addEventListener("click",recycleAnalyze);
  life("recycle-plan-btn")?.addEventListener("click",recyclePrepare);
  life("recycle-confirm-btn")?.addEventListener("click",recycleExecute);
  life("recycle-reconcile-btn")?.addEventListener("click",recycleReconcile);
  window.addEventListener("superagent-core-selected",()=>
    recycleInvalidate("Selected Core changed. Re-analyze service ownership."));
  recycleButtons();
}
window.__superagentRecycleAnalyze=recycleAnalyze;
recycleInstall();
