"use strict";
/* Native-only Tray security settings. Never put credentials in URLs/storage. */
(function(){
  const $=id=>document.getElementById(id);
  const invoke=async(action,payload)=>{
    const fn=window.__TAURI__?.core?.invoke;
    if(typeof fn!=="function")throw Error("Native Tray access required");
    return fn("desktop_live_action",{action,payload:payload??null});
  };
  const mode=()=> $("tray-remote-mode")?.value==="quick"?"quick":"named";
  function updateMode(active=false){
    const quick=mode()==="quick";
    const origin=$("tray-remote-origin-row");
    const hint=$("tray-remote-quick-hint");
    if(origin)origin.hidden=quick;
    if(hint)hint.hidden=!quick;
    const control=$("tray-remote-mode");
    if(control)control.disabled=active;
    const start=$("tray-remote-start");
    if(start)start.textContent=quick?"Start Quick Tunnel":"Enable management gateway";
  }
  function showPublicUrl(value){
    const link=$("tray-remote-public-url");
    if(!link)return;
    let safe=false;
    try{
      const url=new URL(value);
      safe=url.origin===value && url.protocol==="https:" && !url.username && !url.password &&
        (url.hostname.endsWith(".trycloudflare.com")
          ? /^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(value)
          : /^[a-z0-9.-]+\.[a-z]{2,}$/.test(url.hostname));
    }catch{}
    link.hidden=!safe;
    if(safe)link.setAttribute("href",value);
    else link.removeAttribute("href");
  }
  async function refreshGateway(){
    const field=$("tray-remote-status"),start=$("tray-remote-start"),stop=$("tray-remote-stop");
    try{
      const result=await invoke("gateway-status");
      if(start)start.disabled=!result.configured || !!result.active || !!result.connecting;
      if(stop)stop.disabled=!result.active && !result.connecting;
      if(result.mode==="quick"||result.mode==="named"){
        const control=$("tray-remote-mode");
        if(control)control.value=result.mode;
      }
      updateMode(!!result.active||!!result.connecting);
      if(field)field.textContent=result.active
        ?(result.mode==="quick"
          ?"Tray Quick Tunnel ready: "+result.publicUrl+" · Public HTTPS reachability not independently verified."
          :"Management origin listening: "+result.publicUrl+" (private port "+result.originPort+"). Named Tunnel DNS/route not verified.")
        :result.connecting
          ?"Starting a dedicated, password-protected Tray Quick Tunnel…"
          :"Gateway inactive. Configure a password, then select Named or Quick Tunnel.";
      showPublicUrl(result.active?result.publicUrl:null);
    }catch{
      if(start)start.disabled=true;
      if(stop)stop.disabled=true;
      showPublicUrl(null);
      if(field)field.textContent="Remote gateway status unavailable. No activation possible.";
    }
  }
  async function refresh(){
    const field=$("tray-access-password-status");
    try{
      const value=await invoke("password-status");
      if(field)field.textContent=value.configured
        ?"Management password configured · remote exposure requires explicit activation"
        :"No password configured · remote management disabled";
    }catch{
      if(field)field.textContent="Password status unavailable · remote management disabled";
    }
    await refreshGateway();
  }
  async function startGateway(){
    const field=$("tray-remote-status");
    const port=Number($("tray-remote-port")?.value);
    const selected=mode();
    if(!Number.isSafeInteger(port)||port<1024||port>65535){
      if(field)field.textContent="Invalid internal origin port.";return;
    }
    let action="gateway-start-quick",payload={originPort:port};
    if(selected==="named"){
      const raw=$("tray-remote-origin")?.value?.trim();
      let normalized="";
      try{
        const u=new URL(raw);
        if(u.protocol!=="https:"||u.username||u.password||u.port||u.search||u.hash||
           u.pathname!=="/"||!u.hostname.includes(".")||u.hostname.endsWith(".trycloudflare.com"))
          throw Error("Invalid Named Tunnel HTTPS origin");
        normalized=u.origin;
      }catch{
        if(field)field.textContent="Enter a dedicated Named Tunnel HTTPS hostname, without a path or port.";
        return;
      }
      action="gateway-start";
      payload={publicOrigin:normalized,originPort:port};
    }
    const button=$("tray-remote-start");if(button)button.disabled=true;
    let failure="";
    try{
      if(field)field.textContent=selected==="quick"
        ?"Starting dedicated cloudflared Quick Tunnel for Tray only…"
        :"Starting Named Tunnel management origin…";
      const result=await invoke(action,payload);
      if(!result?.active||!result?.publicUrl)throw Error("Gateway not ready");
    }catch{
      failure=selected==="quick"
        ?"Quick Tunnel not started. Check cloudflared installation, internet access, and port availability."
        :"Gateway not started. Verify password, dedicated hostname and port.";
    }finally{
      await refreshGateway();
      if(failure&&field)field.textContent=failure;
    }
  }
  async function stopGateway(){
    const button=$("tray-remote-stop");if(button)button.disabled=true;
    const field=$("tray-remote-status");
    let failure="";
    try{
      const result=await invoke("gateway-stop");
      if(result?.active)throw Error("Not stopped");
    }catch{failure="Tray gateway shutdown could not be verified.";}
    finally{
      await refreshGateway();
      if(failure&&field)field.textContent=failure;
    }
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
      const result=await invoke("password-set",{newPassword:value,
        ...(current?.value?{currentPassword:current.value}:{})});
      if(!result?.configured)throw Error("Password save unverified");
      if(feedback)feedback.textContent="Password updated. All previous remote sessions revoked.";
    }catch{
      if(feedback)feedback.textContent="Password not changed. Check the current password and local Core.";
    }finally{
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
    $("tray-remote-mode")?.addEventListener("change",()=>updateMode());
    $("settings-tab-btn-security")?.addEventListener("click",()=>void refresh());
    updateMode();
    void refresh();
    setInterval(()=>{if(!$("settings-subpage-security")?.hidden)void refreshGateway();},15000);
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install);
  else install();
})();
