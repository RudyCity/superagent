"use strict";
/* Hallmark · pre-emit critique: P5 H4 E4 S5 R5 V4 */
/* Project-local archives. No HTTP video, dynamic HTML, or WebView bearer. */
(() => {
  const el=id=>document.getElementById(id);
  const data={project:"",records:[],loading:false,query:"",filter:"all"};
  const key="superagent.recordings.project.v1";
  const node=(tag,cls,text)=>{
    const n=document.createElement(tag);
    if(cls)n.className=cls;
    if(text!==undefined)n.textContent=String(text);
    return n;
  };
  const notice=(message,error=false)=>{
    const n=el("recordings-status");
    if(n){n.textContent=String(message);n.dataset.error=error?"true":"false";}
  };
  async function native(action,payload) {
    const invoke=window.__TAURI__?.core?.invoke;
    if(typeof invoke!=="function")throw Error("Recording Manager requires native SuperAgent Tray.");
    return invoke("recordings_action",{action,payload:payload??null});
  }
  function choose(folder) {
    data.project=folder;
    const n=el("recordings-project-path");
    if(n)n.textContent=folder||"No project selected";
    try{if(folder)window.localStorage?.setItem(key,folder);}catch{}
  }
  function actionButton(label,operation,record,disabled=false) {
    const button=node("button","button ghost recordings-row-action",label);
    button.type="button";button.disabled=disabled;
    button.addEventListener("click",async()=>{
      if(data.loading)return;
      data.loading=true;button.disabled=true;
      try{
        const result=await native(operation,{
          projectDirectory:data.project,recordingId:record.recordingId,
        });
        if(result?.success===false)throw Error("Recording operation was rejected.");
        notice(operation==="delete"?"Recording deleted.":operation==="stop"?
          "Recording finalization requested.":operation==="export-zip"?"ZIP exported and local folder opened.":"Local system viewer launch requested.");
        data.loading=false;
        await refresh();
      }catch(err){
        notice(String(err?.message||"Recording operation failed."),true);
      }finally{data.loading=false;button.disabled=false;}
    });
    return button;
  }
  function render() {
    const list=el("recordings-list");if(!list)return;
    list.replaceChildren();
    const visible=data.records.filter(r=>{
      const needle=data.query.trim().toLowerCase();
      return(data.filter==="all"||r.status===data.filter)&&
        (!needle||(String(r.recordingId)+" "+String(r.source)+" "+String(r.status)).toLowerCase().includes(needle));
    });
    if(!visible.length) {
      list.append(node("p","recordings-empty",data.project?
        "No recordings match this project or filter.":"Choose a project to view its recordings."));
      return;
    }
    for(const r of visible) {
      const item=node("article","recordings-item");
      const info=node("div","recordings-description");
      const identity=node("div","recordings-identity");
      const name=r.source==="delegate-cdp-exact-tab"?"Chrome Delegate":
        r.source==="managed-cdp-exact-tab"?"Managed Chrome":"CDP session";
      identity.append(node("strong","recordings-name",name),node("code","recordings-id",r.recordingId));
      const meta=node("div","recordings-meta");
      const started=r.startedAt?new Date(r.startedAt):null;
      meta.append(node("span","",started&&!Number.isNaN(started.getTime())?
        started.toLocaleString():"Start time unavailable"));
      meta.append(node("span","",Number(r.frameCount||0)+" frames · "+Number(r.droppedFrames||0)+" dropped"));
      if(r.videoBytes)meta.append(node("span","",(r.videoBytes/1048576).toFixed(1)+" MB"));
      info.append(identity,meta);
      const state=node("span","recordings-state recordings-state-"+r.status,r.status);
      const actions=node("div","recordings-row-actions");
      if(r.hasVideo&&r.status==="saved"){actions.append(actionButton("Play","open-video",r));actions.append(actionButton("Export ZIP","export-zip",r));}
      actions.append(actionButton("Folder","open-folder",r));
      if(r.status==="recording"||r.status==="stopping")
        actions.append(actionButton("Stop","stop",r,r.status==="stopping"));
      else actions.append(actionButton("Delete","delete",r));
      item.append(info,state,actions);list.append(item);
    }
  }
  async function refresh() {
    if(!data.project||data.loading){render();return;}
    data.loading=true;notice("Reading project recording inventory…");
    try{
      const result=await native("list",{projectDirectory:data.project});
      if(!Array.isArray(result?.recordings))throw Error("Inventory unavailable.");
      data.records=result.recordings;render();
      notice(data.records.length+" recording(s) found in this project.");
    }catch(err){data.records=[];render();notice(String(err?.message||"Unable to read recordings."),true);}
    finally{data.loading=false;}
  }
  function boot() {
    try{const saved=window.localStorage?.getItem(key);if(saved)choose(saved);}catch{}
    el("recordings-pick")?.addEventListener("click",async()=>{
      try{
        const selected=await native("pick-project",null);
        if(!selected?.projectDirectory)return;
        choose(selected.projectDirectory);data.records=[];await refresh();
      }catch(err){notice(String(err?.message||"Project picker unavailable."),true);}
    });
    el("recordings-refresh")?.addEventListener("click",()=>void refresh());
    el("recordings-search")?.addEventListener("input",event=>{
      data.query=String(event.target.value||"").slice(0,100);render();
    });
    el("recordings-filter")?.addEventListener("change",event=>{
      data.filter=String(event.target.value||"all");render();
    });
    window.__superagentRecordingsRefresh=()=>void refresh();
    window.setInterval?.(()=>{
      const page=el("page-recordings");
      if(page&&!page.hidden&&!document.hidden&&!data.loading)void refresh();
    },5000);
    render();
    if(data.project)void refresh();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);
  else boot();
})();
