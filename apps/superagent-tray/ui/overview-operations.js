"use strict";
/* Hallmark · pre-emit critique: P4 H4 E4 S5 R5 V4
 * Operator cockpit: read-only by default. Mutations use the existing
 * authenticated, owner-bound native lifecycle and shutdown approval gates.
 */
(() => {
  const $ = id => document.getElementById(id);
  const essential = new Set(["core", "mcp", "tray"]);
  const optional = new Set(["transport", "channel_host", "muse", "telegram", "vision", "guardian", "rest_tunnel", "muse_tunnel"]);
  const servicePorts = {core:7888, transport:7891, channel_host:7892, vision:8095, guardian:7888, daemon:7888};
  const permitted = new Set(["core", "tray", "transport", "channel_host", "vision", "guardian", "daemon"]);
  const planFields = ["service", "port", "operationId", "expectedBuildDigest", "expectedReleaseRevision",
    "expectedCurrentDigest", "expectedOwnerPid", "expectedInstanceId", "expectedSupervisorPid",
    "expectedProcessIdentity", "expectedLegacyCommandDigest", "clientMode", "expectedWorkerPid",
    "expectedRunning", "noActiveJobs", "noCoreShutdown", "noPublicIngress", "corePort", "channelMode", "wsPort"];
  const state = {loading:false, lastSeen:null, plan:null, dashboard:null, events:[], history:[],
    filter:"all", agentFilter:"all", agentRows:[], agentDetails:null,
    metrics:null, errors:[], ready:false, operationBusy:false};
  const call = (name, args={}) => {
    const invoke = window.__TAURI__?.core?.invoke;
    if(typeof invoke !== "function") throw Error("Native Tray IPC is unavailable");
    return invoke(name, args);
  };
  const lifecycle = request => call("lifecycle_console_request", {request});
  const text = (id, value) => {const el=$(id); if(el) el.textContent=String(value ?? "—");};
  const element = (tag, className, value) => {
    const node=document.createElement(tag);
    if(className) node.className=className;
    if(value!==undefined) node.textContent=String(value);
    return node;
  };
  const append = (parent, tag, className, value) => {
    const node=element(tag,className,value); parent.append(node); return node;
  };
  const number = value => Number.isFinite(value) ? value : null;
  const fmt = value => number(value)===null ? "—" : new Intl.NumberFormat("en-US").format(value);
  const bytes = value => number(value)===null ? "—" : (value/1048576).toFixed(1)+" MiB";
  const localTime = value => {
    const when=new Date(value);
    return Number.isFinite(when.getTime()) ? when.toLocaleTimeString() : "Unknown";
  };
  const visible = () => {
    const page=$("page-overview");
    return Boolean(page && !page.hidden && page.classList.contains("active"));
  };
  function notify(message, type="info") {
    text("op-feedback",message);
    const el=$("op-feedback");
    if(el) el.dataset.tone=type;
    window.TrayFeedback?.notify?.({kind:type==="error"?"error":"info",message,scope:"overview"});
  }
  function sectionError(id, message) {
    const host=$(id);
    if(host) host.replaceChildren(element("p","op-empty",message));
  }
  function badge(row, label, tone) {
    const el=append(row,"span","op-chip "+tone,label);
    el.setAttribute("aria-label",label);
    return el;
  }
  function health(item) {
    if(item.ready===true && (item.ownerVerified!==false || item.state==="embedded")) return ["Ready","good"];
    if(item.state==="unverified" || item.state==="unknown") return ["Unverified","bad"];
    if(item.dependencyBlocked || item.state==="degraded" || item.alive && !item.ready)
      return ["Degraded","bad"];
    if(item.state==="inactive" || item.state==="stopped") {
      return optional.has(item.service) || item.service==="daemon"
        ? ["Optional off","muted"] : ["Unavailable","bad"];
    }
    return ["Not ready","bad"];
  }
  function renderReadiness(data) {
    const root=$("op-service-list");
    if(!root)return;
    root.replaceChildren();
    const checks=Array.isArray(data?.checks)?data.checks:[];
    if(!checks.length){sectionError("op-service-list","Lifecycle readiness unavailable; no prior snapshot is trusted.");return;}
    const marked=checks.filter(item=>item.ready===true).length;
    const needed=checks.filter(item=>essential.has(item.service));
    const essentialReady=needed.length===essential.size && needed.every(item=>item.ready===true);
    text("op-readiness",marked+"/"+checks.length+" ready");
    text("op-essential",essentialReady?"Essential stack ready":"Essential stack needs review");
    const unknown=checks.filter(item=>health(item)[1]==="bad").length;
    text("op-readiness-detail",unknown+" require inspection · inactive optional services are not failures");
    for(const item of checks){
      const row=append(root,"div","op-service");
      const copy=append(row,"div","op-service-copy");
      const heading=append(copy,"strong","",String(item.service||"unknown").replace(/_/g," "));
      if(essential.has(item.service))heading.classList.add("op-essential");
      const dep=Array.isArray(item.dependsOn)?item.dependsOn.map(x=>x.service+" "+x.state).join(", "):"";
      append(copy,"small","",[
        item.state==="embedded"?"Embedded service":item.ownerVerified?"Verified owner":"Owner not verified",
        item.reason||item.state||"No status",
        dep?"Depends on "+dep:""
      ].filter(Boolean).join(" · "));
      const [label,tone]=health(item);
      badge(row,label,tone);
    }
    const sync=Number(data.observedAt);
    state.lastSeen=Number.isFinite(sync)?sync:null;
    text("op-observed",state.lastSeen?"Verified "+localTime(state.lastSeen):"No trustworthy timestamp");
  }
  function renderConnectedAgents(details, listId="op-connected-agent-list",
      summaryId="op-connected-agent-summary", filter=state.agentFilter) {
    const root=$(listId);
    if(!root)return;
    root.replaceChildren();
    const verified=details?.connectedAgentsState==="verified" &&
      Array.isArray(details.connectedAgents);
    const rows=verified ? details.connectedAgents : null;
    if(!rows) {
      state.agentRows=[];
      text(summaryId,"Session-level owner evidence unavailable");
      append(root,"p","op-empty","Unavailable — verify the MCP owner and backend health. A previous identity sighting does not mean an active session.");
      return;
    }
    // Labels are untrusted MCP initialize.clientInfo strings; auth and
    // lifecycle are verified separately by the native owner path.
    state.agentRows=rows.filter(row => row && typeof row.sessionHandle==="string" &&
      /^ses_[a-f0-9]{12}$/.test(row.sessionHandle) &&
      typeof row.principalHandle==="string" && /^idh_[a-f0-9]{16}$/.test(row.principalHandle) &&
      ["oauth","static-bearer"].includes(row.authMode) &&
      ["active","idle","retiring"].includes(row.state));
    const active=state.agentRows.filter(x=>x.state==="active").length;
    const idle=state.agentRows.filter(x=>x.state==="idle").length;
    const retiring=state.agentRows.filter(x=>x.state==="retiring").length;
    const observed=number(details.connectedAgentsObservedAt);
    text(summaryId,state.agentRows.length+
      " sessions · "+active+" busy · "+idle+" idle · "+retiring+" retiring"+
      (observed!==null?" · sampled "+localTime(observed):""));
    const filtered=state.agentRows.filter(x=>filter==="all"||x.state===filter);
    if(!filtered.length){
      append(root,"p","op-empty",state.agentRows.length?"No sessions match this filter.":
        "No active MCP sessions in the verified owner registry.");
      return;
    }
    for(const item of filtered.slice(0,64)){
      const row=append(root,"article","op-client-row");
      const primary=append(row,"div","op-client-primary");
      const heading=append(primary,"div","op-client-heading");
      append(heading,"strong","",item.claimedClientName||"Unidentified MCP client");
      badge(heading,item.state,item.state==="active"?"good":item.state==="retiring"?"bad":"muted");
      append(primary,"small","",item.claimedClientName?
        "Client-reported name · not independently verified":
        "No clientInfo.name supplied");
      const identity=append(row,"div","op-client-identity");
      append(identity,"span","",item.authMode==="oauth"?"OAuth authenticated":"Bearer authenticated");
      append(identity,"code","",item.principalHandle);
      append(identity,"code","",item.sessionHandle);
      const activity=append(row,"div","op-client-activity");
      const seen=number(item.lastSeenAt);
      append(activity,"strong","",number(item.inFlight)!==null?item.inFlight+" request(s)":"Requests unknown");
      append(activity,"small","",seen!==null?"Last seen "+new Date(seen).toLocaleString():"Last activity unavailable");
      append(activity,"small","",item.lastToolRequest?"Requested tool: "+item.lastToolRequest:
        "No tool request recorded");
    }
  }
  // Shared renderer for Runtime Detection → MCP; no second identity cache.
  window.__superagentRenderMcpClientList = details =>
    renderConnectedAgents(details,"runtime-mcp-connected-list","runtime-mcp-connected-summary","all");

  function renderMcp(data) {
    const owner=Array.isArray(data?.services)?data.services.find(x=>x.service==="mcp"):null;
    const details=owner?.details;
    if(!details || owner.ownershipVerified!==true) {
      for(const id of ["op-mcp-sessions","op-mcp-inflight","op-mcp-backend","op-mcp-principals",
        "op-mcp-rejected","op-mcp-oldest","op-mcp-generations","op-mcp-capacity",
        "op-mcp-busy","op-mcp-retiring"])text(id,"—");
      text("op-mcp-note","Authenticated MCP owner telemetry unavailable");
      return;
    }
    const counts=details.sessionTelemetry||{};
    text("op-mcp-sessions",fmt(details.activeSessions));
    text("op-mcp-inflight",fmt(details.inFlightRequests));
    text("op-mcp-backend",details.backendHealthy===true?"Healthy":details.backendHealthy===false?"Unhealthy":"Unverified");
    text("op-mcp-principals",fmt(counts.activePrincipals));
    text("op-mcp-rejected",fmt(counts.rejectedTotal));
    text("op-mcp-oldest",number(counts.oldestIdleMs)!==null?Math.round(counts.oldestIdleMs/1000)+"s idle":"—");
    text("op-mcp-generations",fmt(details.backendGenerations));
    text("op-mcp-note",counts.affinityDrift?"Session affinity drift detected":
      "MCP sessions are logical client sessions, not operating-system processes. Idle sessions expire automatically.");
    text("op-mcp-capacity",number(counts.capacity)!==null?String(counts.capacity):"—");
    text("op-mcp-busy",number(counts.inFlightSessions)!==null?String(counts.inFlightSessions):"—");
    text("op-mcp-retiring",number(counts.retiringSessions)!==null?String(counts.retiringSessions):"—");
  }
  function renderResources(data, metrics) {
    const mcp=Array.isArray(data?.services)?data.services.find(x=>
      x.service==="mcp" && x.ownershipVerified===true):null;
    const sampleAt=number(metrics?.observedAt);
    const current=sampleAt!==null && sampleAt>0 && Math.abs(Date.now()-sampleAt)<90000 &&
      Array.isArray(metrics?.processes);
    const memory=(current && metrics?.mcpTelemetry) || mcp?.details?.memoryTelemetry;
    text("op-mcp-rss",bytes(memory?.rssBytes));
    text("op-mcp-heap",bytes(memory?.heapUsedBytes));
    const trend=memory?.trend;
    text("op-memory-trend",trend?.suspicious===true?"Suspicious growth":trend?.suspicious===false?
      "No suspicious trend":"Trend unavailable");
    const root=$("op-process-resources");
    const chart=$("op-resource-history");
    if(chart)chart.replaceChildren();
    if(!root)return;
    root.replaceChildren();
    if(!current){
      state.history=[];
      text("op-resources-status","Native CPU/RAM sample unavailable or stale — verify the local Core and Tray.");
      append(root,"p","op-empty","No current verified owner process sample. MCP memory is shown only when separately authenticated.");
      return;
    }
    const processes=metrics.processes.filter(item=>item &&
      typeof item.service==="string" && number(item.cpuPct)!==null &&
      number(item.rssBytes)!==null && item.rssBytes>=0);
    for(const item of processes){
      const row=append(root,"div","op-resource-row");
      append(row,"span","",item.service.replace(/_/g," "));
      append(row,"strong","",item.cpuPct.toFixed(1)+"% CPU");
      append(row,"span","",bytes(item.rssBytes));
    }
    if(!processes.length)append(root,"p","op-empty","No current OS process has a verified owner.");
    text("op-resources-status",processes.length+
      " verified process(es) sampled at "+localTime(sampleAt)+" · RAM totals count each PID once.");
    const sample=processes.reduce((sum,item)=>sum+item.rssBytes,0);
    if(sample>0 && sampleAt!==state.history[state.history.length-1]?.at){
      state.history.push({at:sampleAt,value:sample});
      if(state.history.length>24)state.history.shift();
    }
    if(!chart)return;
    const max=Math.max(...state.history.map(x=>x.value),1);
    for(const point of state.history){
      const bar=append(chart,"span","op-history-bar");
      bar.style.height=Math.max(5,Math.round(100*point.value/max))+"%";
      bar.title=bytes(point.value)+" verified owner RSS at "+localTime(point.at);
    }
  }
  function renderSecurity(results) {
    const [mode,registry,input,requests,identities]=results;
    text("op-chat-yolo",typeof mode==="string"?mode.toUpperCase():"Unavailable");
    text("op-desktop-policy",typeof input?.mode==="string"?input.mode:"Unavailable");
    const rules=Array.isArray(registry?.rules)?registry.rules:null;
    text("op-security-rules",rules?rules.length+" registered":"Unavailable");
    text("op-trusted-targets",Array.isArray(input?.targets)?String(input.targets.length):"Unavailable");
    const req=Array.isArray(requests?.requests)?requests.requests:Array.isArray(requests)?requests:null;
    const ids=Array.isArray(identities?.identities)?identities.identities:Array.isArray(identities)?identities:null;
    text("op-mcp-requests",req?String(req.length):"Unavailable");
    text("op-mcp-identities",ids?String(ids.length):"Unavailable");
    const claims=document.getElementById("op-security-boundary");
    if(claims)claims.textContent="Chat Agent YOLO never authorizes MCP access. MCP grants, native host policy and app/window approvals remain independent.";
    const consistent=rules && input && typeof mode==="string";
    text("op-security-evidence",consistent?"Configured · enforcement is checked per action":"Security telemetry incomplete · never assume Enforced");
  }
  function renderEvents(dashboard, logs) {
    const core=Array.isArray(window.__superagentOverviewState?.activities)?
      window.__superagentOverviewState.activities : [];
    const life=Array.isArray(dashboard?.timeline)?dashboard.timeline:
      Array.isArray(logs?.events)?logs.events:[];
    const combined=[
      ...core.map(x=>({at:Number(x.timestamp)||Date.parse(x.timestamp),service:x.tag||"event",title:x.title||"Event",code:x.subtitle||"",status:x.status||"unknown"})),
      ...life.map(x=>({at:Number(x.at),service:x.service||"runtime",title:(x.service||"service")+" · "+(x.action||"event"),code:x.errorCode||"",status:x.outcome||"unknown"}))
    ].filter(x=>Number.isFinite(x.at) && x.at>0).sort((a,b)=>b.at-a.at).slice(0,40);
    state.events=combined;
    drawEvents();
  }
  function drawEvents(){
    const root=$("op-events");
    if(!root)return;
    root.replaceChildren();
    const filtered=state.events.filter(x=>state.filter==="all"||
      x.service.toLowerCase().includes(state.filter));
    if(!filtered.length){append(root,"p","op-empty","No matching authenticated events recorded.");return;}
    for(const item of filtered.slice(0,16)){
      const row=append(root,"li","op-event");
      const top=append(row,"div","op-event-head");
      append(top,"strong","",item.title);
      badge(top,item.status,item.status==="succeeded"||item.status==="success"?"good":
        item.status==="blocked"||item.status==="error"?"bad":"muted");
      append(row,"small","",localTime(item.at)+" · "+item.service+(item.code?" · "+item.code:""));
    }
  }
  function resetReadiness(message){
    state.dashboard=null;state.lastSeen=null;
    for(const id of ["op-readiness","op-essential","op-readiness-detail","op-observed"])
      text(id,id==="op-readiness"?"—":message);
    sectionError("op-service-list",message);
    renderMcp(null);state.agentDetails=null;renderConnectedAgents(null);renderResources(null,state.metrics);
    state.events=[];drawEvents();
    state.plan=null;setPlan(null);
  }
  async function refresh(){
    if(state.loading || !visible())return;
    state.loading=true;
    text("op-refresh-state","Checking authenticated owners…");
    text("op-resources-status","Sampling verified process owners…");
    const requests=[
      lifecycle({action:"dashboard",limit:35}), lifecycle({action:"logs",limit:40}),
      call("get_yolo_mode"),call("get_permanent_access_registry"),
      call("get_desktop_input_policy"),
      call("mcp_project_access_action",{action:"requests",payload:{}}),
      call("mcp_project_access_action",{action:"identities",payload:{}}),
      call("get_overview_owner_metrics"),
      call("mcp_project_access_action",{action:"connected_clients",payload:{}})
    ];
    // Refresh the native process monitor as soon as its own sample arrives;
    // slow security/agent queries must not block CPU/RAM visualization.
    void requests[7].then(metrics=>{
      state.metrics=metrics;
      renderResources(null,metrics);
    },()=>{
      state.metrics=null;
      renderResources(null,null);
    });
    const calls=await Promise.allSettled(requests);
    const results=calls.map(x=>x.status==="fulfilled"?x.value:null);
    const names=["lifecycle","events","chat yolo","access rules","desktop policy","mcp requests","mcp identities","resources","connected clients"];
    state.errors=names.filter((name,i)=>results[i]===null);
    if(results[0] && Array.isArray(results[0].checks)){
      state.dashboard=results[0];
      renderReadiness(results[0]);
      renderMcp(results[0]);
      const owner=results[0].services?.find(x=>x.service==="mcp");
      const clients=results[8];
      state.agentDetails=owner?.ownershipVerified===true && clients?.success===true &&
        clients?.state==="verified" && Array.isArray(clients.clients)
          ? {connectedAgentsState:"verified",connectedAgents:clients.clients,
             connectedAgentsObservedAt:clients.observedAt} : null;
      renderConnectedAgents(state.agentDetails);
      renderResources(results[0],state.metrics);
      renderEvents(results[0],results[1]);
      if(state.plan && !state.dashboard.services?.some(s=>s.service===state.plan.service &&
        s.ownerPid===state.plan.expectedOwnerPid)) {state.plan=null;setPlan(null);}
    } else resetReadiness("Lifecycle owner status unavailable; no cached green health is trusted.");
    renderSecurity(results.slice(2,7));
    text("op-refresh-state",state.errors.length?"Partial telemetry: "+state.errors.join(", "):
      "All available sources checked at "+localTime(Date.now()));
    const quality=$("op-refresh-state");
    if(quality)quality.dataset.tone=state.errors.length?"warning":"success";
    state.loading=false;
  }
  function setPlan(plan){
    const el=$("op-lifecycle-plan");
    if(el)el.textContent=plan?
      plan.service+" · "+plan.action+" · owner "+(plan.expectedOwnerPid??"verified in native gate")+
      " · operation "+plan.operationId+
      "\nReview exact owner, current sessions, dependencies and expected outcome before approval.":
      "No plan prepared. Only a fresh authenticated owner plan can authorize an operation.";
    const btn=$("op-lifecycle-execute");
    if(btn)btn.disabled=!plan||state.operationBusy;
  }
  function currentService(){
    const service=$("op-lifecycle-service")?.value;
    return permitted.has(service)?service:null;
  }
  function currentAction(service){
    const action=$("op-lifecycle-action")?.value;
    if(service==="core"||service==="tray")return action==="restart"?action:null;
    return ["start","stop","restart"].includes(action)?action:null;
  }
  function invalidatePlan(){
    state.plan=null;setPlan(null);
  }
  async function prepare(){
    if(state.operationBusy)return;
    const service=currentService();
    const action=currentAction(service);
    if(!service||!action){notify("Select an allowed service/action combination.","error");return;}
    invalidatePlan();state.operationBusy=true;
    text("op-lifecycle-plan","Checking authenticated ownership and safety prerequisites…");
    try {
      const inventory=state.dashboard?.services?.find(x=>x.service===service);
      const port=service==="tray"?undefined:inventory?.port||servicePorts[service];
      const request={action:"plan",service,targetAction:action};
      if(port)request.port=port;
      const plan=await lifecycle(request);
      if(plan?.service!==service || plan?.action!==action || typeof plan.operationId!=="string" ||
        plan.operationId.length<8)throw Error("Owner returned no valid operation plan");
      if(service==="core" && (!Number.isSafeInteger(plan.expectedSupervisorPid) ||
        !Number.isSafeInteger(plan.expectedWorkerPid) ||
        typeof plan.expectedBuildDigest!=="string"))throw Error("Core restart requires owner-bound evidence");
      state.plan=plan;setPlan(plan);
      notify("Plan prepared. Review owner evidence and confirm explicitly.");
    } catch(err){invalidatePlan();notify(String(err?.message||err),"error");}
    finally{state.operationBusy=false;}
  }
  async function execute(){
    const plan=state.plan;
    if(!plan||state.operationBusy||
       currentService()!==plan.service||currentAction(plan.service)!==plan.action)return;
    if(!window.confirm("Execute "+plan.action+" on "+plan.service+"?\n"+
      "Operation ID: "+plan.operationId+"\n"+
      "This will change the verified service. Continue only if sessions are safe to interrupt."))return;
    state.operationBusy=true;setPlan(plan);
    try {
      const evidence=await lifecycle({action:"dashboard",limit:5});
      const owner=evidence?.services?.find(x=>x.service===plan.service);
      if(!owner || (plan.expectedOwnerPid && owner.ownerPid!==plan.expectedOwnerPid))
        throw Error("Owner changed since plan; prepare a fresh plan");
      const args={action:plan.action,service:plan.service,confirm:true};
      for(const key of planFields)if(Object.prototype.hasOwnProperty.call(plan,key))args[key]=plan[key];
      const result=await lifecycle(args);
      notify(result?.success===false?"Owner rejected operation; inspect diagnostics":
        "Owner replied. Refresh and verify state before any further operation.",
        result?.success===false?"error":"info");
    } catch(err){notify(String(err?.message||err),"error");}
    finally{state.operationBusy=false;invalidatePlan();void refresh();}
  }
  function bind(){
    $("op-refresh")?.addEventListener("click",()=>{void refresh();});
    $("op-client-filter")?.addEventListener("change",e=>{
      state.agentFilter=String(e.target.value||"all");
      renderConnectedAgents(state.agentDetails);
    });
    $("op-event-filter")?.addEventListener("change",e=>{
      state.filter=String(e.target.value||"all");drawEvents();
    });
    $("op-lifecycle-service")?.addEventListener("change",()=> {
      invalidatePlan();const val=currentService();
      const action=$("op-lifecycle-action");
      if(action && (val==="core"||val==="tray"))action.value="restart";
    });
    $("op-lifecycle-action")?.addEventListener("change",invalidatePlan);
    $("op-lifecycle-prepare")?.addEventListener("click",()=>{void prepare();});
    $("op-lifecycle-execute")?.addEventListener("click",()=>{void execute();});
    $("op-shutdown-open")?.addEventListener("click",()=>{
      const dialog=$("shutdown-manager-dialog");
      if(typeof window.__superagentShutdownManagerOpen==="function" && dialog) {
        void Promise.resolve().then(()=>window.__superagentShutdownManagerOpen())
          .catch(err=>notify("Cannot open Shutdown Manager: "+String(err?.message||err),"error"));
      } else notify("Shutdown review is not installed in this Tray build; use the native tray Exit App menu.","error");
    });
    window.addEventListener("superagent-core-selected",()=>{
      invalidatePlan();state.history=[];void refresh();
    });
    if(typeof window.setInterval==="function")window.setInterval(()=>{if(visible())void refresh();},15000);
    void refresh();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",bind);
  else bind();
})();