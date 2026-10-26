/**
 * R3 independent local ingress canary. This is a proof of a separate process
 * and routing boundary, NOT a public tunnel or a production OAuth issuer.
 * Forwarding is loopback-only, pinned to a verified kernel listener PID and
 * refuses all owner-control, Core and unknown paths.
 */
import http from "node:http";
import {readListenerOwners} from "./coreMcpOwnershipAudit.js";
import {assertManagedMcpPort} from "./mcpOwnerStagingLease.js";

export function isPermittedMcpIngressPath(method:string,path:string):boolean{
  if(path.length>2048||path.includes("\\")||/%2f|%5c|%00/i.test(path))return false;
  let pathname:string;
  try{pathname=new URL(path,"http://127.0.0.1").pathname}catch{return false}
  if(pathname==="/mcp")return ["GET","POST","DELETE"].includes(method);
  if(pathname==="/oauth/authorize")return ["GET","POST"].includes(method);
  if(pathname==="/oauth/token"||pathname==="/oauth/register")return method==="POST";
  if(pathname.startsWith("/.well-known/"))return method==="GET" &&
    ["/.well-known/oauth-protected-resource",
     "/.well-known/oauth-protected-resource/mcp",
     "/.well-known/oauth-authorization-server",
     "/.well-known/openid-configuration"].includes(pathname);
  return false;
}
/**
 * The private ingress is not a trusted public edge: ignore client-supplied
 * routing / forwarded identity and hop-by-hop headers before proxying.
 * Preserve OAuth bearer, MCP session and content headers unchanged.
 */
const STRIP_INGRESS_HEADERS=new Set([
  "forwarded","connection","keep-alive","te","trailer","upgrade",
  "transfer-encoding","proxy-authorization","proxy-authenticate",
  "proxy-connection",
]);
export function sanitizedMcpIngressHeaders(
  incoming:http.IncomingHttpHeaders,targetPort:number,
):http.OutgoingHttpHeaders {
  const headers:http.OutgoingHttpHeaders={host:"127.0.0.1:"+targetPort};
  for(const [key,value] of Object.entries(incoming)){
    const lower=key.toLowerCase();
    if(lower==="host"||STRIP_INGRESS_HEADERS.has(lower)||
       lower.startsWith("x-forwarded-")||lower.startsWith("proxy-")||
       lower.startsWith("x-original-")||lower.startsWith("x-real-"))
      continue;
    if(value!==undefined)headers[lower]=value;
  }
  return headers;
}
export interface StagingIngressProof {
  ingressPort:number;targetPort:number;targetPid:number;
  ownerPid:number;protocol:"private_loopback_proxy";publicTunnelStarted:false;
}
export async function startVerifiedMcpIngress(input:{
  ingressPort:number;targetPort:number;targetPid:number;
}):Promise<{proof:StagingIngressProof;close:()=>Promise<void>}> {
  const {ingressPort,targetPort,targetPid}=input;
  assertManagedMcpPort(ingressPort);assertManagedMcpPort(targetPort);
  if(ingressPort===targetPort||!Number.isSafeInteger(targetPid)||targetPid<=0)
    throw new Error("Independent MCP ingress needs distinct verified owner");
  const verified=()=>readListenerOwners()?.get(targetPort)===targetPid;
  if(!verified())throw new Error("Target MCP owner PID is not verified by OS");
  const server=http.createServer((req,res)=>{
    if(!verified()){
      res.writeHead(503,{"Cache-Control":"no-store"});res.end();return;
    }
    const url=req.url||"/";
    if(!isPermittedMcpIngressPath(req.method||"",url)){
      res.writeHead(404,{"Cache-Control":"no-store"});res.end();return;
    }
    const cleanHeaders=sanitizedMcpIngressHeaders(req.headers,targetPort);
    const upstream=http.request({
      hostname:"127.0.0.1",port:targetPort,path:url,
      method:req.method,headers:cleanHeaders,timeout:5000,
    },up=>{
      res.writeHead(up.statusCode||502,up.headers);
      up.pipe(res);
    });
    upstream.on("timeout",()=>upstream.destroy(new Error("Upstream timeout")));
    upstream.on("error",()=>{
      if(!res.headersSent)res.writeHead(502,{"Cache-Control":"no-store"});
      res.end();
    });
    req.on("aborted",()=>upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve,reject)=>{
    server.once("error",reject);
    server.listen(ingressPort,"127.0.0.1",resolve);
  });
  return {proof:{ingressPort,targetPort,targetPid,ownerPid:process.pid,
    protocol:"private_loopback_proxy",publicTunnelStarted:false},
    close:()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
