/**
 * Narrow authenticated-desktop lifecycle adapter. Called by the existing
 * loopback Core bearer gate; webview has no credentials, shell or raw URLs.
 */
import type http from "node:http";
import {manageServices,validateManageServicesArgs,type ManageServicesArgs}
  from "./serviceManager.js";

const SERVICES=new Set(["core","mcp","transport","channel_host","muse",
  "telegram","vision","guardian","daemon","tray","process_supervisor"]);
const READ=new Set(["status","inventory","health","doctor","dashboard","logs","profile","watchdog"]);
const MUTATE=new Set(["configure","reconcile","start","stop","restart",
  "upgrade","rollback","drain","reload","recycle"]);
const PLAN=new Set(["start","stop","restart","upgrade","rollback","drain","reload","recycle"]);
function errorCode(message:string){
  const code=message.match(/(?:SERVICE|TRAY|DAEMON|GUARDIAN|VISION|SIDECAR|LIFECYCLE|MCP|CORE|GLOBAL_RECYCLE)_[A-Z0-9_]{2,90}/);
  return code?.[0]??"DESKTOP_LIFECYCLE_REJECTED";
}
export function parseNativeTrayLifecycleRequest(raw:unknown):ManageServicesArgs {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))
    throw new Error("DESKTOP_LIFECYCLE_INVALID_OBJECT");
  const data=raw as Record<string,unknown>;
  const operation=validateManageServicesArgs(data);
  if(!(READ.has(operation.action)||MUTATE.has(operation.action)||operation.action==="plan"))
    throw new Error("DESKTOP_LIFECYCLE_ACTION_DENIED");
  if(operation.service&&operation.service!=="all"&&!SERVICES.has(operation.service))
    throw new Error("DESKTOP_LIFECYCLE_TUNNEL_MUTATION_UNAVAILABLE");
  if(operation.action==="plan"){
    const isGlobalRecycle = operation.service === "all" && operation.targetAction === "recycle";
    if(!isGlobalRecycle && (!operation.service||operation.service==="all"||!operation.targetAction||!PLAN.has(operation.targetAction)))
      throw new Error("DESKTOP_LIFECYCLE_EXACT_PLAN_REQUIRED");
    if(!isGlobalRecycle &&
       ((operation.service==="core"&&
         !["recycle","restart","rollback","drain"].includes(operation.targetAction!))||
        operation.service==="mcp"||operation.service==="muse"||
        operation.service==="telegram"||operation.service==="process_supervisor"))
      throw new Error("DESKTOP_LIFECYCLE_PLAN_TARGET_RESTRICTED");
  }
  if(MUTATE.has(operation.action)){
    const isRecycleMutation = operation.action === "recycle" &&
      (operation.service === "all" || operation.service === "core" || operation.service === "tray" || operation.service === "vision");
    const isReconcileMutation = operation.action === "reconcile" &&
      (operation.service === "all" || ["tray","transport","channel_host","vision","guardian","daemon"].includes(operation.service ?? ""));
    if(!operation.service||(!isRecycleMutation && !isReconcileMutation && operation.service==="all")||operation.confirm!==true)
      throw new Error("DESKTOP_LIFECYCLE_EXPLICIT_CONFIRMATION_REQUIRED");
    const isOwnerBoundCore=operation.service==="core"&&
      ["restart","rollback","drain"].includes(operation.action);
    if(!["tray","transport","channel_host","vision","guardian","daemon"].includes(operation.service)&&
       !isOwnerBoundCore && !isRecycleMutation && !isReconcileMutation)
      throw new Error("DESKTOP_LIFECYCLE_MUTATION_TARGET_RESTRICTED");
    if(isOwnerBoundCore&&
       (!operation.expectedBuildDigest||!operation.expectedSupervisorPid||
        !operation.expectedWorkerPid||operation.port!==7888))
      throw new Error("DESKTOP_LIFECYCLE_CORE_OWNER_BOUND_PLAN_REQUIRED");
    if(operation.action!=="configure"&&operation.action!=="reconcile"&&
       typeof operation.operationId!=="string")
      throw new Error("DESKTOP_LIFECYCLE_OPERATION_ID_REQUIRED");
  }
  if(operation.action==="watchdog"&&operation.confirm===true)
    throw new Error("DESKTOP_LIFECYCLE_WATCHDOG_AUTOMATION_RESTRICTED");
  // No new process auto-recovery setting from native UI without an operator
  // explicitly editing policy. Configuration remains confirmed and revisioned.
  return operation;
}
export function nativeLifecycleLoopbackOnly(req:http.IncomingMessage):boolean {
  const ip=req.socket.remoteAddress??"";
  const host=String(req.headers.host??"");
  const port=/^(?:127\.0\.0\.1|localhost):([0-9]{4,5})$/i.exec(host);
  return (ip==="127.0.0.1"||ip==="::1"||ip==="::ffff:127.0.0.1")&&
    !!port&&Number(port[1])>=1024&&Number(port[1])<=65535&&
    !req.headers.origin&&!req.headers["x-forwarded-for"]&&
    !req.headers["x-forwarded-host"]&&!req.headers["cf-connecting-ip"]&&
    !req.headers["cf-ray"]&&!req.headers["forwarded"];
}
/**
 * Display projection: hide credentials, raw local paths and public tunnel
 * endpoints from the WebView. Lifecycle plans keep only owner attestation
 * fields, never bearer tokens or native process command lines.
 */
export function sanitizeNativeLifecycleView(value:unknown,depth=0):unknown{
  if(depth>14)throw new Error("DESKTOP_LIFECYCLE_RESPONSE_TOO_DEEP");
  if(Array.isArray(value))return value.slice(0,250)
    .map(item=>sanitizeNativeLifecycleView(item,depth+1));
  if(value&&typeof value==="object"){
    const output:Record<string,unknown>={};
    for(const [key,item] of Object.entries(value as Record<string,unknown>)){
      if(/(?:token|secret|password|credential|authorization|publicUrl|localUrl|endpoint|bootstrap|privateKey|executablePath|commandLine|setupSnippet)/i.test(key))
        continue;
      output[key]=sanitizeNativeLifecycleView(item,depth+1);
    }
    return output;
  }
  if(typeof value==="string")
    return value.replace(/Bearer\s+[A-Za-z0-9_.~-]+/gi,"Bearer [REDACTED]")
      .replace(/https?:\/\/[^\s"'<>]+/gi,"[endpoint redacted]")
      .replace(/[A-Za-z]:\\[^\r\n"'<>]+/g,"[path redacted]")
       .replace(/\\\\[^\r\n"'<>]+/g,"[path redacted]")
      .slice(0,800);
  if(typeof value==="number")return Number.isFinite(value)?value:null;
  if(typeof value==="boolean"||value===null)return value;
  return null;
}

export async function handleNativeTrayLifecycleHttp(
  req:http.IncomingMessage,
  res:http.ServerResponse,
  readBody:(req:http.IncomingMessage)=>Promise<string>,
  sendJSON:(res:http.ServerResponse,status:number,payload:unknown)=>void,
):Promise<void>{
  res.setHeader("Cache-Control","no-store");
  if(!nativeLifecycleLoopbackOnly(req)){
    sendJSON(res,403,{success:false,error:"DESKTOP_LIFECYCLE_LOOPBACK_ONLY"});
    return;
  }
  if(req.method!=="POST"){
    sendJSON(res,405,{success:false,error:"DESKTOP_LIFECYCLE_POST_REQUIRED"});
    return;
  }
  try{
    const body=await readBody(req);
    if(Buffer.byteLength(body,"utf8")>4096)
      throw new Error("DESKTOP_LIFECYCLE_BODY_TOO_LARGE");
    const data=parseNativeTrayLifecycleRequest(JSON.parse(body));
    const outcome=await manageServices(data);
    sendJSON(res,200,{success:true,data:sanitizeNativeLifecycleView(outcome)});
  }catch(e){
    // Only stable allowlisted codes escape native boundary; raw tokens,
    // internal filesystem paths and command-line output remain server-side.
    const code=errorCode(e instanceof Error?e.message:"");
    sendJSON(res,409,{success:false,error:code});
  }
}
