"use strict";
/* Native owner-only Tray password settings. No password in localStorage or URLs. */
(function(){
  const $=id=>document.getElementById(id);
  const invoke=async(action,payload)=>{
    const fn=window.__TAURI__?.core?.invoke;
    if(typeof fn!=="function")throw Error("Native Tray access required");
    return fn("desktop_live_action",{action,payload:payload??null});
  };
  async function refresh(){
    const field=$("tray-access-password-status");
    try{
      const value=await invoke("password-status");
      if(field)field.textContent=value.configured
        ?"Management password configured · remote exposure disabled until host-only gateway passes security review"
        :"No password configured · remote management disabled";
    }catch{
      if(field)field.textContent="Password status unavailable · remote management disabled";
    }
    await refreshGateway();
  }
  async function refreshGateway(){
    const field=$("tray-remote-status");
    const start=$("tray-remote-start");
    const stop=$("tray-remote-stop");
    try {
      const result=await invoke("gateway-status");
      if(start)start.disabled=!result.configured||!!result.active;
      if(stop)stop.disabled=!result.active;
      if(field)field.textContent=result.active
        ?"Management origin listening: "+result.publicUrl+" (private port "+result.originPort+"). DNS/Named Tunnel route NOT verified."
        :"Gateway inactive. Password and a dedicated Named Tunnel are required.";
    }catch{
      if(start)start.disabled=true;
      if(stop)stop.disabled=true;
      if(field)field.textContent="Remote gateway status unavailable. No activation possible.";
    }
  }
  async function startGateway(){
    const field=$("tray-remote-status");
    const url=$("tray-remote-origin")?.value?.trim();
    const port=Number($("tray-remote-port")?.value);
    let normalized="";
    try {
      const u=new URL(url);
      if(u.protocol!=="https:"||u.username||u.password||u.port||u.search||u.hash||
         u.pathname!=="/"||!u.hostname.includes("."))throw Error("Bad HTTPS origin");
      normalized=u.origin;
    }catch{
      if(field)field.textContent="Enter a dedicated HTTPS hostname (no path, port, or credentials).";
      return;
    }
    if(!Number.isSafeInteger(port)||port<1024||port>65535){
      if(field)field.textContent="Invalid internal origin port.";
      return;
    }
    const button=$("tray-remote-start");if(button)button.disabled=true;
    try{
      const result=await invoke("gateway-start",{publicOrigin:normalized,originPort:port});
      if(!result?.active)throw Error("Not active");
      if(field)field.textContent="Gateway active. Named Tunnel DNS/route must be verified separately.";
    }catch{
      if(field)field.textContent="Could not start remote gateway. Verify password, hostname and dedicated port.";
    }finally{await refreshGateway();}
  }
  async function stopGateway(){
    const button=$("tray-remote-stop");if(button)button.disabled=true;
    const field=$("tray-remote-status");
    try{
      const result=await invoke("gateway-stop");
      if(result?.active)throw Error("Not stopped");
      if(field)field.textContent="Remote management gateway stopped.";
    }catch{
      if(field)field.textContent="Gateway shutdown not verified.";
    }finally{await refreshGateway();}
  }
  async function submit(event){
    event.preventDefault();
    const current=$("tray-access-password-current");
    const next=$("tray-access-password-new");
    const confirm=$("tray-access-password-confirm");
    const button=$("tray-access-password-save");
    const feedback=$("tray-access-password-feedback");
    if(!next||!confirm||!button)return;
    const value=next.value;
    if(value.length<12||value.length>128||value!==confirm.value){
      if(feedback)feedback.textContent="Use 12–128 characters and make both passwords match.";
      return;
    }
    button.disabled=true;
    try{
      const result=await invoke("password-set",{
        newPassword:value,
        ...(current?.value?{currentPassword:current.value}:{})
      });
      if(!result?.configured)throw Error("Password save unverified");
      if(feedback)feedback.textContent="Password updated. Remote management remains disabled.";
    }catch{if(feedback)feedback.textContent="Password not changed. Check the current password and local Core.";}
    finally {
      if(current)current.value="";
      next.value="";
      confirm.value="";
      button.disabled=false;
      await refresh();
    }
  }
  function install(){
    $("tray-access-password-form")?.addEventListener("submit",submit);
    $("tray-remote-start")?.addEventListener("click",()=>void startGateway());
    $("tray-remote-stop")?.addEventListener("click",()=>void stopGateway());
    $("settings-tab-btn-security")?.addEventListener("click",()=>void refresh());
    void refresh();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install);
  else install();
})();