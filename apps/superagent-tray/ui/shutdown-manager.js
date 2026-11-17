"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const state={preview:null,selected:new Set(),progress:null,busy:false,loading:false,poller:null};
  const invoke=(action,fields={})=>{
    const call=window.__TAURI__?.core?.invoke;
    if(!call)throw Error("Native SuperAgent Tray is required");
    return call("shutdown_manager_action",{action,...fields});
  };
  const active=item=>!["inactive","stopped","stale","embedded"].includes(item.state);
  function node(parent,tag,className,value){
    const element=document.createElement(tag);
    if(className)element.className=className;
    element.textContent=String(value??"");
    parent.append(element);
    return element;
  }
  function safe(error){
    const value=String(error?.message??error);
    const found=value.match(/SHUTDOWN_[A-Z0-9_]+/);
    return found?found[0].replace(/_/g," "):
      "Owner verification failed. Inspect Runtime Detection before retrying.";
  }
  function feedback(value,error=false){
    const el=$("shutdown-feedback");
    if(el){el.textContent=value;el.dataset.tone=error?"error":"neutral";}
  }
  function counts(){
    const running=(state.preview?.services??[]).filter(active);
    return {running:running.length,ready:running.filter(s=>s.selectable).length,
      blocked:running.filter(s=>!s.selectable).length};
  }
  function canExit(){
    return state.preview?.exitReady===true &&
      state.preview.services.filter(active).every(s=>s.selectable&&state.selected.has(s.id));
  }
  function buttons(){
    const lock=state.busy||state.loading;
    $("shutdown-stop-selected").disabled=lock||state.selected.size===0;
    $("shutdown-exit-all").disabled=lock||state.selected.size===0||!canExit();
    $("shutdown-refresh").disabled=lock;
    $("shutdown-close").disabled=state.loading;
    $("shutdown-selection-count").textContent=String(state.selected.size)+
      " selected · "+String(counts().blocked)+" require separate review";
  }
  function drawServices(){
    const list=$("shutdown-services");
    list.replaceChildren();
    const services=state.preview?.services??[];
    if(!services.length)node(list,"p","shutdown-empty",
      "No authenticated services available in this preview.");
    for(const item of services){
      const row=document.createElement("label");
      row.className="shutdown-service";
      row.dataset.state=item.selectable?"ready":active(item)?"blocked":"inactive";
      const checkbox=document.createElement("input");
      checkbox.type="checkbox";checkbox.value=item.id;
      checkbox.checked=state.selected.has(item.id);
      checkbox.disabled=state.busy||!item.selectable;
      checkbox.setAttribute("aria-label","Stop "+item.label);
      checkbox.addEventListener("change",()=>{
        if(checkbox.checked)state.selected.add(item.id);
        else state.selected.delete(item.id);
        buttons();
      });
      row.append(checkbox);
      const copy=document.createElement("span");
      copy.className="shutdown-service-copy";
      node(copy,"strong","",item.label);
      const details=[
        item.port?"Port "+item.port:null,
        item.pid?"PID "+item.pid:null,
        item.activeSessions!=null?item.activeSessions+" active jobs/sessions":null,
      ].filter(Boolean).join(" · ");
      node(copy,"small","",details||item.detail);
      if(item.blocker&&active(item))node(copy,"span","shutdown-blocker",item.blocker);
      else if(item.selectable)node(copy,"span","shutdown-explanation",item.detail);
      row.append(copy);
      node(row,"span","shutdown-status",item.selectable?"Ready":
        active(item)?"Review":"Stopped");
      list.append(row);
    }
    const total=counts();
    $("shutdown-active-count").textContent=String(total.running);
    $("shutdown-ready-count").textContent=String(total.ready);
    $("shutdown-blocked-count").textContent=String(total.blocked);
    $("shutdown-all-note").textContent=state.preview?.exitReady
      ?"Full exit requires every active verified owner to remain selected."
      :"Full exit is blocked by busy, external or unverified owners. Stop Selected remains available.";
    buttons();
  }
  function drawProgress(){
    const list=$("shutdown-progress-steps");
    const wrap=$("shutdown-progress");
    wrap.hidden=!state.progress;
    list.replaceChildren();
    if(!state.progress)return;
    $("shutdown-progress-status").textContent=state.progress.stage==="running"
      ?"Graceful shutdown in progress":state.progress.stage==="complete"
      ?"Selected services verified stopped":"Stopped with blockers — review required";
    for(const step of state.progress.steps??[]){
      const row=document.createElement("li");
      row.className="shutdown-step";row.dataset.status=step.status;
      node(row,"strong","",step.label);
      node(row,"span","shutdown-step-state",step.status);
      node(row,"small","",step.message);
      list.append(row);
    }
    if(state.progress.error)feedback(state.progress.error,true);
  }
  function acceptProgress(progress){
    if(!progress||!Array.isArray(progress.steps))return;
    if(state.progress&&state.progress.runId!==progress.runId&&state.busy)return;
    state.progress=progress;state.busy=progress.stage==="running";
    drawProgress();buttons();
    if(!state.busy&&state.poller!==null){
      clearInterval(state.poller);state.poller=null;
    }
  }
  async function pollStatus(){
    try {
      const response=await invoke("status");
      if(response?.progress)acceptProgress(response.progress);
    }catch{
      if(state.busy)feedback("Shutdown status unavailable. Do not retry until ownership is reviewed.",true);
    }
  }
  function startPolling(){
    if(state.poller!==null)return;
    state.poller=setInterval(()=>{void pollStatus();},1000);
  }
  async function refresh(){
    if(state.busy||state.loading)return;
    state.loading=true;state.preview=null;state.selected.clear();
    buttons();feedback("Checking authenticated owners, open sessions and scheduled jobs...");
    try {
      const response=await invoke("preview");
      if(!response?.preview||!Array.isArray(response.preview.services))
        throw Error("Invalid owner inventory");
      state.preview=response.preview;
      for(const item of response.preview.services){
        if(item.selectable&&active(item))state.selected.add(item.id);
      }
      drawServices();
      feedback(response.preview.warning||
        (counts().blocked?"Some active services require separate owner review.":
          "Preview ready. Confirm your choice in the native security dialog."),
        Boolean(response.preview.warning));
    }catch(error){feedback(safe(error),true);drawServices();}
    finally{state.loading=false;buttons();}
  }
  async function execute(exitAfter){
    if(state.busy||state.loading||!state.preview||!state.selected.size)return;
    if(exitAfter&&!canExit()){
      feedback("Resolve all blockers and select every active owner before exiting.",true);
      return;
    }
    state.loading=true;buttons();feedback("Awaiting native confirmation...");
    try{
      const response=await invoke("execute",{
        previewId:state.preview.previewId,
        selected:Array.from(state.selected),
        exitAfter,
      });
      if(!response?.accepted||!response.runId)throw Error("Native approval rejected");
      state.busy=true;
      state.progress={runId:response.runId,stage:"running",exitAfter,
        steps:Array.from(state.selected).map(id=>({
          id,label:state.preview.services.find(s=>s.id===id)?.label||"Service",
          status:"queued",message:"Awaiting owner verification",
        }))};
      drawProgress();
      feedback("Native approval accepted. Stopping in dependency order.");
      startPolling();await pollStatus();
    }catch(error){feedback(safe(error),true);}
    finally{state.loading=false;buttons();}
  }
  async function open(){
    $("shutdown-manager-dialog").hidden=false;
    $("shutdown-close").focus();
    try{
      const response=await invoke("status");
      if(response?.progress)acceptProgress(response.progress);
      if(response?.busy){
        state.busy=true;startPolling();buttons();
        feedback("A previous shutdown remains active. Monitoring its status.");
        return;
      }
    }catch{}
    await refresh();
  }
  function close(){
    $("shutdown-manager-dialog").hidden=true;
    // Hiding the UI never cancels or repeats a native operation.
  }
  function install(){
    $("shutdown-close")?.addEventListener("click",close);
    $("shutdown-cancel")?.addEventListener("click",close);
    $("shutdown-refresh")?.addEventListener("click",()=>{void refresh();});
    $("shutdown-stop-selected")?.addEventListener("click",()=>{void execute(false);});
    $("shutdown-exit-all")?.addEventListener("click",()=>{void execute(true);});
    $("shutdown-manager-dialog")?.addEventListener("keydown",event=>{
      if(event.key==="Escape"&&!state.busy)close();
    });
    $("shutdown-manager-dialog")?.addEventListener("click",event=>{
      if(event.target===$("shutdown-manager-dialog")&&!state.busy)close();
    });
    window.__TAURI__?.event?.listen?.("desktop-open-shutdown-manager",()=>{void open();});
    window.__TAURI__?.event?.listen?.("shutdown-manager-progress",event=>acceptProgress(event?.payload));
    window.__superagentShutdownManagerOpen=open;
    buttons();
  }
  install();
})();