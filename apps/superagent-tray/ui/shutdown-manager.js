"use strict";
(() => {
  const $=id=>document.getElementById(id);
  const state={
    preview:null,
    selected:new Set(),
    progress:null,
    busy:false,
    loading:false,
    poller:null,
    lastTerminalRefresh:null,
  };

  const invoke=(action,fields={})=>{
    const call=window.__TAURI__?.core?.invoke;
    if(!call)throw Error("Native SuperAgent Tray is required");
    return call("shutdown_manager_action",{action,...fields});
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
      "Force operation failed. Refresh the process list before retrying.";
  }

  function feedback(value,error=false){
    const el=$("shutdown-feedback");
    if(!el)return;
    el.textContent=value;
    el.dataset.tone=error?"error":"neutral";
  }

  function visibleProcesses(){
    const byPid=new Map();
    for(const item of state.preview?.services??[]){
      if(!Number.isSafeInteger(item.pid)||item.pid<=0)continue;
      const current=byPid.get(item.pid);
      if(!current || (!current.manualKillSelectable && item.manualKillSelectable)){
        byPid.set(item.pid,item);
      }
    }
    return Array.from(byPid.values());
  }

  function forceableProcesses(){
    return visibleProcesses().filter(item=>item.manualKillSelectable===true);
  }

  function selectedProcesses(){
    const selected=state.selected;
    return forceableProcesses().filter(item=>selected.has(item.id));
  }

  function buttons(){
    const lock=state.busy||state.loading;
    const forceable=forceableProcesses();
    const allSelected=forceable.length>0&&forceable.every(item=>state.selected.has(item.id));
    $("shutdown-select-all").disabled=lock||!forceable.length||allSelected;
    $("shutdown-clear").disabled=lock||state.selected.size===0;
    $("shutdown-refresh").disabled=lock;
    $("shutdown-force-selected").disabled=lock||selectedProcesses().length===0||
      $("shutdown-force-confirm").value!=="FORCE SELECTED";
    $("shutdown-close").disabled=state.loading;

    $("shutdown-selection-count").textContent=
      selectedProcesses().length+" selected · "+forceable.length+" forceable";
    $("shutdown-process-summary").textContent=
      forceable.length+" forceable process"+(forceable.length===1?"":"es");
  }

  function drawServices(){
    const list=$("shutdown-services");
    list.replaceChildren();
    const processes=visibleProcesses();

    if(!processes.length){
      node(list,"p","shutdown-empty","No live process-backed entries were found.");
      buttons();
      return;
    }

    for(const item of processes){
      const forceable=item.manualKillSelectable===true;
      const row=document.createElement("label");
      row.className="shutdown-service";
      row.dataset.state=forceable?"force":"protected";

      const checkbox=document.createElement("input");
      checkbox.type="checkbox";
      checkbox.value=item.id;
      checkbox.checked=state.selected.has(item.id);
      checkbox.disabled=state.busy||!forceable;
      checkbox.setAttribute("aria-label",
        (forceable?"Force ":"Protected ")+item.label+" PID "+item.pid);
      checkbox.addEventListener("change",()=>{
        if(checkbox.checked)state.selected.add(item.id);
        else state.selected.delete(item.id);
        buttons();
      });
      row.append(checkbox);

      const copy=document.createElement("span");
      copy.className="shutdown-service-copy";
      node(copy,"strong","",item.label||item.processName||("PID "+item.pid));
      const details=[
        "PID "+item.pid,
        item.processName||null,
        item.port?"Port "+item.port:null,
      ].filter(Boolean).join(" · ");
      node(copy,"small","",details);

      if(item.processPath){
        const executable=node(copy,"small","shutdown-executable",item.processPath);
        executable.setAttribute("title",item.processPath);
      }else if(item.detail){
        node(copy,"small","shutdown-explanation",item.detail);
      }
      row.append(copy);

      node(row,"span","shutdown-status",forceable?"Force":"Protected");
      list.append(row);
    }
    buttons();
  }

  function drawProgress(){
    const wrap=$("shutdown-progress");
    const list=$("shutdown-progress-steps");
    wrap.hidden=!state.progress;
    list.replaceChildren();
    if(!state.progress)return;

    const restarted=(state.progress.steps??[]).some(step=>step.status==="restarted");
    $("shutdown-progress-status").textContent=
      state.progress.stage==="running"?"Force operation in progress":
      restarted?"A replacement PID was detected":
      state.progress.stage==="complete"?"Selected processes verified stopped":
      "Force operation partial";

    for(const step of state.progress.steps??[]){
      const row=document.createElement("li");
      row.className="shutdown-step";
      row.dataset.status=step.status;
      node(row,"strong","",step.label);
      node(row,"span","shutdown-step-state",step.status);
      node(row,"small","",step.message);
      list.append(row);
    }
    if(state.progress.error)feedback(safe(state.progress.error),true);
  }

  function acceptProgress(progress){
    if(!progress||!Array.isArray(progress.steps))return;
    if(state.progress&&state.progress.runId!==progress.runId&&state.busy)return;
    state.progress=progress;
    state.busy=progress.stage==="running";

    if(!state.busy){
      state.preview=null;
      state.selected.clear();
      $("shutdown-force-confirm").value="";
      drawServices();
    }

    drawProgress();
    buttons();

    if(!state.busy&&state.poller!==null){
      clearInterval(state.poller);
      state.poller=null;
    }

    if(!state.busy&&state.lastTerminalRefresh!==progress.runId){
      state.lastTerminalRefresh=progress.runId;
      void Promise.resolve().then(async()=>{
        if($("shutdown-manager-dialog").hidden||state.busy||state.loading)return;
        await refresh();
        drawProgress();
      });
    }
  }

  async function pollStatus(){
    try{
      const response=await invoke("status");
      if(response?.progress)acceptProgress(response.progress);
    }catch{
      if(state.busy)feedback(
        "Force status is unavailable. Refresh before issuing another force operation.",true);
    }
  }

  function startPolling(){
    if(state.poller!==null)return;
    state.poller=setInterval(()=>{void pollStatus();},1000);
  }

  async function refresh(){
    if(state.busy||state.loading)return;
    state.loading=true;
    state.preview=null;
    state.selected.clear();
    $("shutdown-force-confirm").value="";
    buttons();
    feedback("Reading local process inventory…");

    try{
      const response=await invoke("preview");
      if(!response?.preview||!Array.isArray(response.preview.services)){
        throw Error("Invalid process inventory");
      }
      state.preview=response.preview;
      drawServices();
      const count=forceableProcesses().length;
      feedback(count
        ?count+" process"+(count===1?" is":"es are")+" forceable. Owner status is ignored."
        :"No forceable process was found.");
    }catch(error){
      feedback(safe(error),true);
      drawServices();
    }finally{
      state.loading=false;
      buttons();
    }
  }

  function selectAll(){
    if(state.busy||state.loading||!state.preview)return;
    state.selected.clear();
    for(const item of forceableProcesses())state.selected.add(item.id);
    drawServices();
  }

  function clearSelection(){
    if(state.busy||state.loading)return;
    state.selected.clear();
    drawServices();
  }

  async function forceSelected(){
    if(state.busy||state.loading||!state.preview||
       $("shutdown-force-confirm").value!=="FORCE SELECTED")return;
    const selected=selectedProcesses().map(item=>item.id);
    if(!selected.length)return;

    state.loading=true;
    buttons();
    feedback("Awaiting native confirmation for "+selected.length+" selected process(es)…");

    try{
      const response=await invoke("force_selected",{
        previewId:state.preview.previewId,
        selected,
        forceConfirmation:"FORCE SELECTED",
      });
      if(!response?.accepted||!response.runId){
        throw Error("Native force approval rejected");
      }

      state.busy=true;
      state.progress={
        runId:response.runId,
        stage:"running",
        exitAfter:false,
        steps:selectedProcesses().map(item=>({
          id:item.id,
          label:(item.label||item.processName||"Process")+" · PID "+item.pid,
          status:"queued",
          message:"Awaiting exact PID, executable and process-start verification",
        })),
      };
      drawProgress();
      feedback("Force approved. Verifying and terminating selected OS processes.");
      startPolling();
      await pollStatus();
    }catch(error){
      feedback(safe(error),true);
    }finally{
      state.loading=false;
      buttons();
    }
  }

  async function open(){
    $("shutdown-manager-dialog").hidden=false;
    $("shutdown-close").focus();
    try{
      const response=await invoke("status");
      if(response?.progress)acceptProgress(response.progress);
      if(response?.busy){
        state.busy=true;
        startPolling();
        buttons();
        feedback("A force operation is already running. Monitoring its status.");
        return;
      }
    }catch{}
    await refresh();
  }

  function close(){
    $("shutdown-manager-dialog").hidden=true;
  }

  function install(){
    $("shutdown-close")?.addEventListener("click",close);
    $("shutdown-cancel")?.addEventListener("click",close);
    $("shutdown-refresh")?.addEventListener("click",()=>{void refresh();});
    $("shutdown-select-all")?.addEventListener("click",selectAll);
    $("shutdown-clear")?.addEventListener("click",clearSelection);
    $("shutdown-force-confirm")?.addEventListener("input",buttons);
    $("shutdown-force-selected")?.addEventListener("click",()=>{void forceSelected();});
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
