/** File-safe MCP Chrome metadata certification; all other browser operations remain denied. */
type BrowserCall = {name:string; args?:Record<string,unknown>};
const exact=(o:Record<string,unknown>,keys:string[])=>Object.keys(o).every(k=>keys.includes(k));
export function certifiedBrowserObservation(call:BrowserCall):boolean{
 const a=call.args;
 if(!a||typeof a!=="object"||Array.isArray(a))return false;
 if(call.name==="superagent_list_running_chrome")return Object.keys(a).length===0;
 if(call.name==="superagent_browser_gateway")
   return a.action==="identity"&&exact(a,["action","agentId"]) ||
     a.action==="policy"&&exact(a,["action"]);
 if(call.name==="superagent_chrome_cdp_observe"||
   call.name==="superagent_chrome_cdp"||call.name==="superagent_control_chrome_cdp"){
   if(a.command!=="list_targets"&&a.command!=="transport_status")return false;
   if(a.transport==="delegate"){
     if(!exact(a,["command","transport","delegateClientId"]))return false;
     return a.delegateClientId===undefined ||
       (typeof a.delegateClientId==="string"&&/^[A-Za-z0-9_-]{8,80}$/.test(a.delegateClientId));
   }
   if(a.transport!==undefined&&a.transport!=="managed")return false;
   if(!exact(a,["command","transport","debug_port"]))return false;
   return a.debug_port===undefined ||
     (Number.isSafeInteger(a.debug_port)&&Number(a.debug_port)>=1024&&Number(a.debug_port)<=65535);
 }
 return false;
}


/**
 * Permanent-file-policy-certified browser workflows cannot use loopback,
 * private-network literals or local hostnames as a tunnel to files served by
 * an unrelated local process. Private development sites need a separate
 * explicitly reviewed access path; the general CDP tool is not exempted.
 */
export function certifiedRemoteWebUrl(raw:unknown):boolean {
 if(typeof raw!=="string"||!raw||raw.length>4096)return false;
 if(raw.includes(String.fromCharCode(92))||/[\u0000-\u001f]/.test(raw))return false;
 try {
   const url=new URL(raw);
   if(url.protocol!=="http:"&&url.protocol!=="https:")return false;
   if(url.username||url.password)return false;
   const host=url.hostname.toLowerCase().replace(/\.$/,"");
   if(!host||host==="localhost"||host.endsWith(".localhost")||
      host.endsWith(".local")||host.endsWith(".internal")||
      host.endsWith(".test")||host.endsWith(".invalid"))return false;
   // Refuse IP-literal targets (public/private) in this high-trust workflow.
   // Named public web origins are supported; no private network discovery.
   if(!host.includes(".")||host.includes(":")||/^[0-9.]+$/.test(host))return false;
   return true;
 }catch{return false;}
}

/**
 * Narrow, audited Delegate web workflow. This certifies argument shapes only:
 * the MCP executor still requires OAuth write scope, an independent human MCP
 * Connection Controls grant and a verified per-transport Delegate principal.
 * The extension rechecks the tab's current URL on every debugger attachment
 * and CDP command. There is no raw Runtime.evaluate, cookie, terminal, file,
 * screenshot, upload, new_tab or arbitrary nested payload in this contract.
 */
export function certifiedDelegateWebAction(call:BrowserCall):boolean{
 if(call.name!=="superagent_chrome_cdp_web" && call.name!=="superagent_chrome_cdp")
   return false;
 const a=call.args;
 if(!a||typeof a!=="object"||Array.isArray(a))return false;
 if(a.transport!=="delegate"||typeof a.delegateClientId!=="string"||
   !/^[A-Za-z0-9_-]{8,80}$/.test(a.delegateClientId))return false;
 const target=typeof a.targetId==="string"
   ? /^delegate:([A-Za-z0-9_-]{8,80}):([1-9][0-9]{0,9})$/.exec(a.targetId) : null;
 if(!target||target[1]!==a.delegateClientId||
   !Number.isSafeInteger(Number(target[2]))||Number(target[2])<1)return false;
 if(typeof a.command!=="string")return false;
 const command=a.command;
 const allow=["command","transport","delegateClientId","targetId"];
 const token=()=>typeof a.sessionToken==="string"&&a.sessionToken.length>=16&&
   a.sessionToken.length<=256&&!/[\r\n\0]/.test(a.sessionToken);
 const exactWith=(...keys:string[])=>exact(a,[...allow,...keys]);
 const leased=()=>token();
 const revision=()=>Number.isSafeInteger(a.expectedRevision)&&Number(a.expectedRevision)>=0;
 switch(command){
   case "claim_target":
     return exactWith(); // The Core mints a fresh unforgeable lease capability.
   case "release_target":
   case "heartbeat_session":
   case "session_participants":
     return exactWith("sessionToken")&&leased();
   case "snapshot":
   case "read_page":
     return exactWith("sessionToken")&&leased();
   case "navigate": {
     if(!exactWith("sessionToken","expectedRevision","url")||
       !leased()||!revision()||typeof a.url!=="string"||a.url.length>4096)return false;
     return certifiedRemoteWebUrl(a.url);
   }
   case "click": {
     if(!exactWith("sessionToken","expectedRevision","selector","index")||
       !leased()||!revision())return false;
     const hasSelector=typeof a.selector==="string";
     const hasIndex=a.index!==undefined;
     if(hasSelector===hasIndex)return false;
     return hasSelector
       ? a.selector.length>0&&a.selector.length<=512&&!/[\0\r\n]/.test(a.selector)
       : Number.isSafeInteger(a.index)&&Number(a.index)>=1&&Number(a.index)<=250;
   }
   case "type": {
     if(!exactWith("sessionToken","expectedRevision","selector","index","text")||
       !leased()||!revision()||typeof a.text!=="string"||a.text.length>10000)return false;
     const hasSelector=typeof a.selector==="string";
     const hasIndex=a.index!==undefined;
     if(hasSelector===hasIndex)return false;
     return hasSelector
       ? a.selector.length>0&&a.selector.length<=512&&!/[\0\r\n]/.test(a.selector)
       : Number.isSafeInteger(a.index)&&Number(a.index)>=1&&Number(a.index)<=250;
   }
   default:return false;
 }
}
