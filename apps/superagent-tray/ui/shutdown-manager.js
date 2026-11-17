"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const state={preview:null,selected:new Set(),manualSelected:new Set(),
    progress:null,busy:false,loading:false,poller:null,lastTerminalRefresh:null};
  const invoke=(action,fields={})=>{
    const call=window.__TAURI__?.core?.invoke;
    if(!call)throw Error("Native SuperAgent Tray is required");
    return call("shutdown_manager_action",{action,...fields});
  };
  const active=item=>!["inactive","stopped","stale","embedded"].includes(item.state);
  const forceReady=()=>state.preview?.services?.filter(s=>active(s)&&s.forceSelectable===true)??[];
  const manualReady=()=>{
    const seen=new Set();
    return (state.preview?.services??[]).filter(s=>{
      if(!active(s)||s.manualKillSelectable!==true||
         !Number.isSafeInteger(s.pid)||s.pid<=4||seen.has(s.pid))return false;
      seen.add(s.pid);
      return true;
    });
  };
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
    $("shutdown-stop-selected").disabled=lock||!state.preview||state.selected.size===0;
    $("shutdown-exit-all").disabled=lock||!canExit();
    $("shutdown-force-all").disabled=lock||!state.preview||!forceReady().length||
      $("shutdown-force-confirm").value!=="FORCE STOP ALL";
    $("shutdown-manual-kill").disabled=lock||!state.preview||!state.manualSelected.size||
      $("shutdown-manual-confirm").value!=="KILL SELECTED";
    $("shutdown-manual-select-all").disabled=lock||!manualReady().length;
    $("shutdown-refresh").disabled=lock;
    $("shutdown-close").disabled=state.loading;
    const selectedPids=new Set((state.preview?.services??[])
      .filter(s=>state.manualSelected.has(s.id)&&s.manualKillSelectable)
      .map(s=>s.pid)).size;
    $("shutdown-selection-count").textContent=String(state.selected.size)+
      " graceful selected · "+String(selectedPids)+
      " manual PID(s) selected · "+String(manualReady().length)+" manual-eligible · "+
      String(counts().blocked)+" need graceful review";
  }
  function drawServices(){
    const list=$("shutdown-services");
    list.replaceChildren();
    const services=state.preview?.services??[];
    if(!services.length)node(list,"p","shutdown-empty",
      "No authenticated services available in this preview.");
    for(const item of services){
      const row=document.createElement("div");
      row.className="shutdown-service";
      row.dataset.state=item.selectable?"ready":item.forceSelectable?"force":
        item.manualKillSelectable?"manual":active(item)?"blocked":"inactive";
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
        item.processName?"OS "+item.processName:null,
        item.activeSessions!=null?item.activeSessions+" active jobs/sessions":null,
      ].filter(Boolean).join(" · ");
      node(copy,"small","",details||item.detail);
      if(item.manualKillSelectable && item.processPath)
        node(copy,"small","shutdown-executable","Executable: "+item.processPath);
      if(item.id?.startsWith("guardian-os:"))
        node(copy,"span","shutdown-explanation",
          "Local Guardian lease + live OS PID; Core API not required for manual kill.");
      if(item.forceSelectable&&!item.selectable&&active(item))
        node(copy,"span","shutdown-force-explanation",
          "Force stop available after explicit approval. May interrupt active sessions or public tunnels.");
      else if(item.blocker&&active(item))node(copy,"span","shutdown-blocker",item.blocker);
      else if(item.selectable)node(copy,"span","shutdown-explanation",item.detail);
      row.append(copy);
      node(row,"span","shutdown-status",item.selectable?"Ready":
        item.forceSelectable?"Force ready":item.manualKillSelectable?"Manual kill":
        active(item)?"Review":"Stopped");
      if(item.manualKillSelectable && active(item)){
        const killLabel=document.createElement("label");
        killLabel.className="shutdown-manual-choice";
        const kill=document.createElement("input");
        kill.type="checkbox";kill.value=item.id;
        kill.checked=state.manualSelected.has(item.id);
        kill.disabled=state.busy;
        kill.setAttribute("aria-label","Manually kill PID "+item.pid+" · "+item.label);
        kill.addEventListener("change",()=>{
          if(kill.checked)state.manualSelected.add(item.id);
          else state.manualSelected.delete(item.id);
          buttons();
        });
        killLabel.append(kill);
        node(killLabel,"span","","Kill PID");
        row.append(killLabel);
      }
      list.append(row);
    }
    const total=counts();
    $("shutdown-active-count").textContent=String(total.running);
    $("shutdown-ready-count").textContent=String(total.ready);
    $("shutdown-blocked-count").textContent=String(total.blocked);
    $("shutdown-all-note").textContent=state.preview?.exitReady
      ?"Full exit is available while all active owners are selected. If none are running, only the Tray will close."
      :"Graceful full exit is blocked. Manual Kill lets the owner explicitly select OS-observed Guardian, Cloudflare and Core Supervisor PIDs.";
    buttons();
  }
  function drawProgress(){
    const list=$("shutdown-progress-steps");
    const wrap=$("shutdown-progress");
    wrap.hidden=!state.progress;
    list.replaceChildren();
    if(!state.progress)return;
    const restarted=(state.progress.steps??[]).some(step=>step.status==="restarted");
    $("shutdown-progress-status").textContent=state.progress.stage==="running"
      ?"Owner shutdown in progress":restarted
      ?"A replacement PID was detected — review before retry":
      state.progress.stage==="complete"?"Selected PIDs verified stopped":
      "Shutdown partial — review remaining owners";
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
    if(!state.busy){
      state.preview=null;state.selected.clear();state.manualSelected.clear();
      $("shutdown-force-confirm").value="";
      $("shutdown-manual-confirm").value="";
      drawServices();
    }
    drawProgress();buttons();
    if(!state.busy&&state.poller!==null){
      clearInterval(state.poller);state.poller=null;
    }
    if(!state.busy && state.lastTerminalRefresh!==progress.runId){
      state.lastTerminalRefresh=progress.runId;
      // A terminal native operation invalidates the old owner list. Refresh
      // once only, preserving the operation receipt above for operator review.
      void Promise.resolve().then(async()=>{
        if($("shutdown-manager-dialog").hidden||state.busy||state.loading)return;
        await refresh();
        drawProgress();
      });
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
    state.loading=true;state.preview=null;state.selected.clear();state.manualSelected.clear();
    $("shutdown-force-confirm").value="";
    $("shutdown-manual-confirm").value="";
    buttons();feedback("Inspecting local OS owners, Guardian leases, Core health and active sessions...");
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
    if(state.busy||state.loading||!state.preview||(!exitAfter&&!state.selected.size))return;
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
  function selectManualAll(){
    if(state.busy||state.loading||!state.preview)return;
    for(const item of manualReady())state.manualSelected.add(item.id);
    drawServices();
  }
  async function manualKill(){
    if(state.busy||state.loading||!state.preview||!state.manualSelected.size||
       $("shutdown-manual-confirm").value!=="KILL SELECTED")return;
    state.loading=true;buttons();
    feedback("Awaiting native confirmation for individually selected OS PIDs…");
    try {
      const selected=Array.from(state.manualSelected);
      const response=await invoke("manual_kill",{
        previewId:state.preview.previewId,
        selected,forceConfirmation:"KILL SELECTED",
      });
      if(!response?.accepted||!response.runId)throw Error("Native manual kill approval rejected");
      state.busy=true;
      state.progress={runId:response.runId,stage:"running",exitAfter:false,
        steps:selected.map(id=>{
          const item=state.preview.services.find(s=>s.id===id);
          return {id,label:(item?.label||"Service")+" · PID "+(item?.pid||"-"),
            status:"queued",message:"Revalidating exact OS PID and process start time"};
        })};
      drawProgress();
      feedback("Manual kill authorized. Exact PID results will be verified independently.");
      startPolling();await pollStatus();
    }catch(error){feedback(safe(error),true);}
    finally{state.loading=false;buttons();}
  }
  async function forceAll(){
    if(state.busy||state.loading||!state.preview||
       $("shutdown-force-confirm").value!=="FORCE STOP ALL"||!forceReady().length)return;
    state.loading=true;buttons();feedback("Awaiting separate native force-stop approval…");
    try {
      const response=await invoke("force_all",{
        previewId:state.preview.previewId,forceConfirmation:"FORCE STOP ALL",
      });
      if(!response?.accepted||!response.runId)throw Error("Native force-stop approval rejected");
      state.busy=true;
      state.progress={runId:response.runId,stage:"running",exitAfter:false,
        steps:state.preview.services.filter(active).map(item=>({
          id:item.id,label:item.label,status:item.forceSelectable?"queued":"blocked",
          message:item.forceSelectable?"Registered owner awaiting final verification":
            "No authenticated force-stop permission for this owner",
        }))};
      drawProgress();
      feedback("Force stop approved for registered owners. Other processes remain under review.");
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
    $("shutdown-force-confirm")?.addEventListener("input",buttons);
    $("shutdown-manual-confirm")?.addEventListener("input",buttons);
    $("shutdown-manual-select-all")?.addEventListener("click",selectManualAll);
    $("shutdown-manual-kill")?.addEventListener("click",()=>{void manualKill();});
    $("shutdown-force-all")?.addEventListener("click",()=>{void forceAll();});
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