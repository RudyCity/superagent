import { isCertifiedIngressStagedFile, getIngressReceiptByStagedPath } from "../mcp/mcpUploadIngress.js";
import path from "node:path";

/** File-safe MCP Chrome metadata and narrowly scoped leased Delegate upload certification. */
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
   case "extract_links":
     return exactWith("sessionToken")&&leased();
   case "navigate": {
     if(!exactWith("sessionToken","expectedRevision","url")||
       !leased()||!revision()||typeof a.url!=="string"||a.url.length>4096)return false;
     return certifiedRemoteWebUrl(a.url);
   }
   case "click": {
     if(!exactWith("sessionToken","expectedRevision","selector","index")||
       !leased()||!revision())return false;
     const selector=typeof a.selector==="string" ? a.selector : undefined;
     const hasSelector=selector!==undefined;
     const hasIndex=a.index!==undefined;
     if(hasSelector===hasIndex)return false;
     return selector!==undefined
       ? selector.length>0&&selector.length<=512&&!/[\0\r\n]/.test(selector)
       : Number.isSafeInteger(a.index)&&Number(a.index)>=1&&Number(a.index)<=250;
   }
   case "type": {
     if(!exactWith("sessionToken","expectedRevision","selector","index","text")||
       !leased()||!revision()||typeof a.text!=="string"||a.text.length>10000)return false;
     const selector=typeof a.selector==="string" ? a.selector : undefined;
     const hasSelector=selector!==undefined;
     const hasIndex=a.index!==undefined;
     if(hasSelector===hasIndex)return false;
     return selector!==undefined
       ? selector.length>0&&selector.length<=512&&!/[\0\r\n]/.test(selector)
       : Number.isSafeInteger(a.index)&&Number(a.index)>=1&&Number(a.index)<=250;
   }
   default:return false;
 }
}

/**
 * Returns the one explicitly selected local source path for a secure Delegate upload.
 * Shape certification does not grant file access: the permanent host registry and
 * stageUploadArtifact independently re-check read permission before opening it.
 */
export function getCertifiedBrowserUploadSourcePath(call: BrowserCall): string | null {
  if (call.name !== "superagent_chrome_cdp" && call.name !== "superagent_control_chrome_cdp") return null;
  const a = call.args;
  if (!a || typeof a !== "object" || Array.isArray(a) || a.command !== "upload_file") return null;
  const allowed = ["command", "transport", "delegateClientId", "targetId", "sessionToken",
    "expectedRevision", "confirmUpload", "filePath", "selector", "inputIndex", "expectedMime", "expectedSha256"];
  if (!exact(a, allowed) || a.transport !== "delegate" || a.confirmUpload !== true) return null;
  if (typeof a.delegateClientId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(a.delegateClientId)) return null;
  const target = typeof a.targetId === "string"
    ? /^delegate:([A-Za-z0-9_-]{8,80}):([1-9][0-9]{0,9})$/.exec(a.targetId) : null;
  if (!target || target[1] !== a.delegateClientId || !Number.isSafeInteger(Number(target[2]))) return null;
  if (typeof a.sessionToken !== "string" || a.sessionToken.length < 16 ||
      a.sessionToken.length > 256 || /[\r\n\0]/.test(a.sessionToken)) return null;
  if (!Number.isSafeInteger(a.expectedRevision) || Number(a.expectedRevision) < 0) return null;
  if (typeof a.filePath !== "string" || !a.filePath.trim() || a.filePath.length > 4096 ||
      !(path.isAbsolute(a.filePath) || path.win32.isAbsolute(a.filePath)) || /[\0\r\n]/.test(a.filePath)) return null;
  if (a.selector !== undefined && (typeof a.selector !== "string" || !a.selector.length ||
      a.selector.length > 512 || /[\0\r\n]/.test(a.selector))) return null;
  if (a.inputIndex !== undefined && (!Number.isSafeInteger(a.inputIndex) ||
      Number(a.inputIndex) < 0 || Number(a.inputIndex) > 249)) return null;
  if (a.selector !== undefined && a.inputIndex !== undefined) return null;
  if (a.expectedMime !== undefined && (typeof a.expectedMime !== "string" || a.expectedMime.length > 127 ||
      !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(a.expectedMime))) return null;
  if (a.expectedSha256 !== undefined && (typeof a.expectedSha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(a.expectedSha256))) return null;
  return a.filePath;
}

function hasDelegateUploadLease(a: Record<string, unknown>, requireRevision: boolean): boolean {
  if (a.transport !== "delegate" || typeof a.delegateClientId !== "string" ||
      !/^[A-Za-z0-9_-]{8,80}$/.test(a.delegateClientId)) return false;
  const target = typeof a.targetId === "string"
    ? /^delegate:([A-Za-z0-9_-]{8,80}):([1-9][0-9]{0,9})$/.exec(a.targetId) : null;
  if (!target || target[1] !== a.delegateClientId || !Number.isSafeInteger(Number(target[2]))) return false;
  if (typeof a.sessionToken !== "string" || a.sessionToken.length < 16 ||
      a.sessionToken.length > 256 || /[\r\n\0]/.test(a.sessionToken)) return false;
  return !requireRevision || (Number.isSafeInteger(a.expectedRevision) && Number(a.expectedRevision) >= 0);
}

/**
 * Certifies only exact, leased Delegate upload/verification requests.
 * Raw sources are checked against the permanent native file registry before
 * staging; staged files must have a live host-owned ingress receipt.
 */
export function certifiedBrowserUpload(call: BrowserCall): boolean {
  if (call.name !== "superagent_chrome_cdp" && call.name !== "superagent_control_chrome_cdp") return false;
  const a = call.args;
  if (!a || typeof a !== "object" || Array.isArray(a)) return false;
  const cmd = a.command || a.cmd;

  if (cmd === "upload_file" && getCertifiedBrowserUploadSourcePath(call)) return true;

  if (cmd === "verify_upload") {
    const allowed = ["command", "transport", "delegateClientId", "targetId", "sessionToken",
      "selector", "inputIndex", "successSelector", "expectedNames", "fileNames"];
    if (!exact(a, allowed) || !hasDelegateUploadLease(a, false)) return false;
    if (a.selector !== undefined && (typeof a.selector !== "string" || !a.selector.length ||
        a.selector.length > 512 || /[\0\r\n]/.test(a.selector))) return false;
    if (a.inputIndex !== undefined && (!Number.isSafeInteger(a.inputIndex) ||
        Number(a.inputIndex) < 0 || Number(a.inputIndex) > 249)) return false;
    if (a.successSelector !== undefined && (typeof a.successSelector !== "string" ||
        !a.successSelector.length || a.successSelector.length > 512 || /[\0\r\n]/.test(a.successSelector))) return false;
    const names = a.expectedNames ?? a.fileNames;
    return names === undefined || (Array.isArray(names) && names.length <= 10 &&
      names.every(name => typeof name === "string" && name.length <= 255));
  }

  if (cmd !== "upload_file" && cmd !== "handle_file_chooser") return false;
  const allowed = ["command", "transport", "delegateClientId", "targetId", "sessionToken",
    "expectedRevision", "confirmUpload", "files", "filePaths", "paths", "filePath", "path",
    "selector", "inputIndex", "arm", "triggerSelector", "nativeDialog", "confirmNativeDialog", "windowTitle"];
  if (!exact(a, allowed) || !hasDelegateUploadLease(a, true) || a.confirmUpload !== true) return false;
  if (a.selector !== undefined && (typeof a.selector !== "string" || !a.selector.length ||
      a.selector.length > 512 || /[\0\r\n]/.test(a.selector))) return false;
  if (a.inputIndex !== undefined && (!Number.isSafeInteger(a.inputIndex) ||
      Number(a.inputIndex) < 0 || Number(a.inputIndex) > 249)) return false;
  if (a.selector !== undefined && a.inputIndex !== undefined) return false;
  if (a.triggerSelector !== undefined && (typeof a.triggerSelector !== "string" ||
      !a.triggerSelector.length || a.triggerSelector.length > 512 || /[\0\r\n]/.test(a.triggerSelector))) return false;
  if (a.arm !== undefined && typeof a.arm !== "boolean") return false;
  if (a.arm === true && (cmd !== "handle_file_chooser" || typeof a.triggerSelector !== "string")) return false;
  if (a.nativeDialog === true && (cmd !== "handle_file_chooser" || a.confirmNativeDialog !== true)) return false;
  if (a.confirmNativeDialog !== undefined && typeof a.confirmNativeDialog !== "boolean") return false;
  if (a.windowTitle !== undefined && (typeof a.windowTitle !== "string" || a.windowTitle.length > 256)) return false;
  const raw = a.files ?? a.filePaths ?? a.paths ?? a.filePath ?? a.path;
  const inputs = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  if (inputs.length < 1 || inputs.length > 10) return false;
  return inputs.every(p => {
    if (typeof p !== "string" || !isCertifiedIngressStagedFile(p)) return false;
    const receipt = getIngressReceiptByStagedPath(p);
    return Boolean(receipt && receipt.targetId === a.targetId && receipt.sessionToken === a.sessionToken);
  });
}