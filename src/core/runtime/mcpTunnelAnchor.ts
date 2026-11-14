/**
 * Stage 3: independent, long-lived Cloudflare Quick Tunnel ingress.
 *
 * Anchor owns only the public tunnel + loopback listener, not the MCP owner,
 * OAuth writer or tool worker. Targets are authenticated loopback MCP owners.
 * Switching requires explicit plan/review and a drained old owner. The anchor
 * never replays POST/tools/call, migrates sessions or silently adopts a port.
 *
 * Deploy only for a new, independently reviewed tunnel; migrating an existing
 * Quick Tunnel to this process cannot preserve its random hostname.
 */
import crypto from "node:crypto";
import http, {type IncomingMessage,type ServerResponse} from "node:http";
import {startQuickTunnel,stopQuickTunnel,getTunnelStatus} from "../remoteAgent/cloudflareTunnel.js";
import {readListenerOwners} from "./coreMcpOwnershipAudit.js";
import {isPermittedMcpIngressPath,sanitizedMcpIngressHeaders} from "./mcpIngressStage.js";
import {validateMcpNamedHostname} from "./mcpNamedTunnelConfig.js";

export interface AnchorMcpOwnerTarget {
  port:number;
  pid:number;
  startedAt:number;
  nonce:string;
}
export interface McpTunnelAnchorOptions {
  port:number;
  nonce:string;
  createdAt:number;
  /** Externally operated named connector: NEVER start/stop Quick Tunnel. */
  externalNamedHostname?:string;
  /** An operator-reviewed, nonce-authenticated shutdown callback, Named only. */
  onStopRequested?:()=>Promise<void>;
}
export interface TunnelAnchorDeps {
  startTunnel?:(port:number)=>Promise<{publicUrl:string,pid?:number}>;
  stopTunnel?:(port:number)=>Promise<unknown>;
  verifyListener?:(port:number,pid:number)=>boolean;
}
export interface McpTunnelAnchorHandle {
  publicUrl:string;
  port:number;
  close:()=>Promise<void>;
}
type OwnerStatus={
  kind:string;pid:number;port:number;startedAt:number;
  publicUrl:string;ingressMode?:string;reloadable?:boolean;
  backendHealthy?:boolean;draining?:boolean;activeSessions?:number;
  inFlightRequests?:number;inFlightToolCalls?:number;oauthEnabled?:boolean;oauthStatePersistent?:boolean;
  safeToolsOnly?:boolean;
};
function shaEqual(received:string,expected:string):boolean{
  if(!received||!expected)return false;
  const a=crypto.createHash("sha256").update(received).digest();
  const b=crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a,b);
}
function validTarget(value:unknown,anchorPort:number):value is AnchorMcpOwnerTarget{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const v=value as Partial<AnchorMcpOwnerTarget>;
  return Number.isSafeInteger(v.port)&&v.port!>=1024&&v.port!<=65535&&
    v.port!==anchorPort&&v.port!==7888&&
    Number.isSafeInteger(v.pid)&&v.pid!>0&&
    Number.isSafeInteger(v.startedAt)&&v.startedAt!>0&&
    typeof v.nonce==="string"&&/^[a-f0-9]{64}$/.test(v.nonce);
}
function publicOrigin(raw:string):string{
  const url=new URL(raw);
  if(url.protocol!=="https:"||!url.hostname||url.username||url.password||
     url.search||url.hash||url.pathname!=="/"||url.port)
    throw Error("MCP_ANCHOR_INVALID_PUBLIC_URL");
  return url.origin;
}
async function readJsonBounded(req:IncomingMessage):Promise<Record<string,unknown>>{
  const chunks:Buffer[]=[];
  let bytes=0;
  for await(const part of req){
    bytes+=part.length;
    if(bytes>4096)throw Error("MCP_ANCHOR_CONTROL_TOO_LARGE");
    chunks.push(Buffer.from(part));
  }
  const body=JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if(!body||typeof body!=="object"||Array.isArray(body))
    throw Error("MCP_ANCHOR_INVALID_CONTROL_PAYLOAD");
  return body as Record<string,unknown>;
}
export async function startMcpTunnelAnchor(
  opts:McpTunnelAnchorOptions,deps:TunnelAnchorDeps={},
):Promise<McpTunnelAnchorHandle>{
  if(!Number.isSafeInteger(opts.port)||opts.port<1024||opts.port>65535||
     opts.port===7888||!Number.isSafeInteger(opts.createdAt)||opts.createdAt<=0||
     !/^[a-f0-9]{64}$/.test(opts.nonce))
    throw Error("MCP_ANCHOR_INVALID_IDENTITY");
  if(getTunnelStatus(opts.port).isRunning)
    throw Error("MCP_ANCHOR_PORT_HAS_EXISTING_TUNNEL");
  const namedHost=opts.externalNamedHostname
    ? validateMcpNamedHostname(opts.externalNamedHostname) : null;
  if(namedHost&&(deps.startTunnel||deps.stopTunnel))
    throw Error("MCP_NAMED_ANCHOR_EXTERNAL_CONNECTOR_ONLY");
  const verifyListener=deps.verifyListener??((port,pid)=>readListenerOwners()?.get(port)===pid);
  const launch=deps.startTunnel??(async port=>{
    const tunnel=await startQuickTunnel({port,host:"127.0.0.1",path:"",serviceKind:"mcp-http"});
    return {publicUrl:tunnel.publicUrl,pid:tunnel.pid};
  });
  const stop=deps.stopTunnel??(async port=>stopQuickTunnel(port,"mcp-http"));
  let current:AnchorMcpOwnerTarget|null=null;
  let inFlight=0;
  let switching=false;
  let closing=false;
  let shutdownRequested=false;
  let ownedTunnel=false;
  let tunnelPid:number|null=null;
  let baseUrl="";
  let plan:null|{
    id:string;expiresAt:number;expectedPreviousPid:number|null;
    target:AnchorMcpOwnerTarget;requiresDrain:boolean;
  }=null;

  const readOwner=async(target:AnchorMcpOwnerTarget):Promise<OwnerStatus>=>{
    if(!validTarget(target,opts.port)||!verifyListener(target.port,target.pid))
      throw Error("MCP_ANCHOR_TARGET_LISTENER_UNVERIFIED");
    const response=await fetch("http://127.0.0.1:"+target.port+"/_internal/owner/status",{
      headers:{Host:"127.0.0.1:"+target.port,Authorization:"Bearer "+target.nonce,
        Accept:"application/json"},
      signal:AbortSignal.timeout(2500),
    });
    if(response.status!==200)throw Error("MCP_ANCHOR_TARGET_AUTH_FAILED");
    const text=await response.text();
    if(text.length>16384)throw Error("MCP_ANCHOR_TARGET_RESPONSE_TOO_LARGE");
    const s=JSON.parse(text) as OwnerStatus;
    if(s.kind!=="private_mcp_owner"||s.pid!==target.pid||
       s.port!==target.port||s.startedAt!==target.startedAt||
       s.publicUrl!==baseUrl+"/mcp"||s.ingressMode!=="external-anchor"||
       s.reloadable!==true||s.backendHealthy!==true||
       !Number.isSafeInteger(s.activeSessions)||s.activeSessions!<0||
       !Number.isSafeInteger(s.inFlightRequests)||s.inFlightRequests!<0||
       typeof s.draining!=="boolean"||typeof s.oauthEnabled!=="boolean"||
        typeof s.safeToolsOnly!=="boolean"||
       (s.oauthEnabled===true&&s.oauthStatePersistent!==true))
      throw Error("MCP_ANCHOR_TARGET_STATUS_UNVERIFIED");
    return s;
  };
  const redactStatus=()=>({
    version:1,kind:"mcp_tunnel_anchor",pid:process.pid,port:opts.port,
    startedAt:opts.createdAt,publicUrl:baseUrl+"/mcp",tunnelPid,
    tunnelMode:namedHost?"named-external":"quick",
    externalConnectorVerified:false,
    currentOwnerPid:current?.pid??null,currentOwnerPort:current?.port??null,
    inFlightRequests:inFlight,switching,ready:current!==null,
    noImplicitReplay:true,quickTunnelUrlNotRecoverable:!namedHost,
    shutdownRequested,
  });
  const reply=(res:ServerResponse,status:number,obj:unknown)=>{
    res.writeHead(status,{"Content-Type":"application/json","Cache-Control":"no-store"});
    res.end(JSON.stringify(obj));
  };
  const handler=http.createServer((req,res)=>{
    const raw=req.url||"/";
    let route:string;
    try{route=new URL(raw,"http://127.0.0.1").pathname;}
    catch{res.writeHead(400);res.end();return;}
    if(route.startsWith("/_internal/anchor/")){
      const address=req.socket.remoteAddress||"";
      const host=String(req.headers.host||"").toLowerCase();
      if(!["127.0.0.1","::1","::ffff:127.0.0.1"].includes(address)||
         !["127.0.0.1:"+opts.port,"localhost:"+opts.port].includes(host)){
        res.writeHead(404);res.end();return;
      }
      const bearer=String(req.headers.authorization||"").replace(/^Bearer /,"");
      if(!shaEqual(bearer,opts.nonce)){
        res.writeHead(401,{"Cache-Control":"no-store"});res.end();return;
      }
      if(route==="/_internal/anchor/status"&&req.method==="GET"){
        reply(res,200,redactStatus());return;
      }
      if(route==="/_internal/anchor/shutdown"&&req.method==="POST"){
        void(async()=>{
          if(!namedHost||!opts.onStopRequested)
            throw Error("MCP_NAMED_ANCHOR_SHUTDOWN_UNAVAILABLE");
          const body=await readJsonBounded(req);
          if(body.reviewed!==true||body.expectedAnchorPid!==process.pid||
             body.expectedPort!==opts.port||body.expectedPublicUrl!==baseUrl+"/mcp"||
             body.expectedCurrentOwnerPid!==null)
            throw Error("MCP_NAMED_ANCHOR_SHUTDOWN_NOT_REVIEWED");
          if(shutdownRequested||closing||switching||plan!==null||
             current!==null||inFlight!==0)
            throw Error("MCP_NAMED_ANCHOR_NOT_IDLE_OR_DETACHED");
          shutdownRequested=true;
          res.once("finish",()=>{
            setImmediate(()=>void opts.onStopRequested!().catch(()=>{shutdownRequested=false;}));
          });
          reply(res,200,{accepted:true,anchorPid:process.pid,
            publicUrl:baseUrl+"/mcp",noQuickTunnelMutation:true});
        })().catch(error=>reply(res,409,{
          error:error instanceof Error?error.message:"MCP_NAMED_ANCHOR_SHUTDOWN_DENIED",
        }));
        return;
      }
      if(route==="/_internal/anchor/detach"&&req.method==="POST"){
        void(async()=>{
          if(!namedHost)throw Error("MCP_NAMED_ANCHOR_DETACH_UNAVAILABLE");
          const body=await readJsonBounded(req);
          if(body.reviewed!==true||body.expectedAnchorPid!==process.pid||
             body.expectedPort!==opts.port||body.expectedPublicUrl!==baseUrl+"/mcp"||
             body.expectedOwnerPid!==(current?.pid??null)||
             body.expectedOwnerPort!==(current?.port??null))
            throw Error("MCP_NAMED_ANCHOR_DETACH_NOT_REVIEWED");
          if(shutdownRequested||closing||switching||plan!==null||
             inFlight!==0||!current)
            throw Error("MCP_NAMED_ANCHOR_DETACH_BUSY");
          switching=true;
          try{
            const selected=current;
            const owner=await readOwner(selected);
            if(owner.pid!==selected.pid||owner.port!==selected.port||
               owner.draining!==true||owner.activeSessions!==0||
               owner.inFlightRequests!==0||owner.inFlightToolCalls!==0||
               inFlight!==0||current!==selected)
              throw Error("MCP_NAMED_ANCHOR_DETACH_OWNER_NOT_DRAINED");
            current=null;
            plan=null;
            reply(res,200,{detached:true,ownerPid:selected.pid,
              anchorPid:process.pid,publicUrl:baseUrl+"/mcp",
              noQuickTunnelMutation:true,noRequestReplay:true});
          }finally{switching=false;}
        })().catch(error=>reply(res,409,{
          error:error instanceof Error?error.message:"MCP_NAMED_ANCHOR_DETACH_REFUSED",
        }));
        return;
      }
      if((route==="/_internal/anchor/plan"||route==="/_internal/anchor/activate")&&req.method==="POST"){
        void(async()=>{
          const body=await readJsonBounded(req);
          if(route==="/_internal/anchor/plan"){
            if(switching||closing||shutdownRequested)throw Error("MCP_ANCHOR_BUSY");
            const next=body.target;
            if(!validTarget(next,opts.port))throw Error("MCP_ANCHOR_INVALID_TARGET");
            if(body.expectedAnchorPid!==process.pid||
               body.expectedPublicUrl!==baseUrl+"/mcp"||
               body.expectedPreviousPid!==(current?.pid??null))
              throw Error("MCP_ANCHOR_PLAN_IDENTITY_CHANGED");
            if(current&&current.port===next.port)
              throw Error("MCP_ANCHOR_TARGET_ALREADY_ACTIVE");
            const newStatus=await readOwner(next);
            if(newStatus.draining)throw Error("MCP_ANCHOR_NEW_OWNER_DRAINING");
            const oldStatus=current?await readOwner(current):null;
            if(oldStatus&&(oldStatus.oauthEnabled!==newStatus.oauthEnabled||
                oldStatus.safeToolsOnly!==newStatus.safeToolsOnly))
              throw Error("MCP_ANCHOR_SECURITY_MODE_MISMATCH");
            const requiresDrain=Boolean(oldStatus && (!oldStatus.draining||
              oldStatus.activeSessions!==0||oldStatus.inFlightRequests!==0||inFlight!==0));
            plan={
              id:crypto.randomBytes(16).toString("hex"),expiresAt:Date.now()+120_000,
              expectedPreviousPid:current?.pid??null,target:next,requiresDrain,
            };
            reply(res,200,{planId:plan.id,expiresAt:plan.expiresAt,
              expectedAnchorPid:process.pid,expectedPreviousPid:plan.expectedPreviousPid,
              expectedPublicUrl:baseUrl+"/mcp",newOwnerPid:next.pid,
              newOwnerPort:next.port,requiresDrain,noTunnelRestart:true,noImplicitReplay:true});
            return;
          }
          if(switching||closing||shutdownRequested)throw Error("MCP_ANCHOR_BUSY");
          if(!plan||typeof body.planId!=="string"||
             !shaEqual(body.planId,plan.id)||
             body.reviewed!==true||plan.expiresAt<Date.now()||
             body.expectedAnchorPid!==process.pid||
             body.expectedPublicUrl!==baseUrl+"/mcp"||
             body.expectedPreviousPid!==(current?.pid??null)||
             body.expectedNextOwnerPid!==plan.target.pid||
             body.expectedNextOwnerPort!==plan.target.port||
             plan.expectedPreviousPid!==(current?.pid??null))
            throw Error("MCP_ANCHOR_ACTIVATION_NOT_REVIEWED_OR_STALE");
          switching=true;
          try{
            if(inFlight!==0)throw Error("MCP_ANCHOR_ACTIVE_REQUESTS");
            const oldStatus=current?await readOwner(current):null;
            if(oldStatus&&(!oldStatus.draining||oldStatus.activeSessions!==0||
                oldStatus.inFlightRequests!==0))
              throw Error("MCP_ANCHOR_OLD_OWNER_NOT_DRAINED");
            const selected=plan.target;
            const nextStatus=await readOwner(selected);
            if(nextStatus.draining)throw Error("MCP_ANCHOR_NEW_OWNER_DRAINING");
            if(oldStatus&&(oldStatus.oauthEnabled!==nextStatus.oauthEnabled||
               oldStatus.safeToolsOnly!==nextStatus.safeToolsOnly))
              throw Error("MCP_ANCHOR_SECURITY_MODE_MISMATCH");
            if(inFlight!==0||plan.expiresAt<Date.now())
              throw Error("MCP_ANCHOR_ACTIVATION_RACED");
            current=selected;
            plan=null;
            reply(res,200,{success:true,publicUrl:baseUrl+"/mcp",
              anchorPid:process.pid,ownerPid:selected.pid,previousOwnerPid:oldStatus?.pid??null,
              noTunnelRestart:true,noImplicitReplay:true});
          }finally{switching=false;}
        })().catch(error=>reply(res,409,{error:error instanceof Error?error.message:"MCP_ANCHOR_CONTROL_FAILED"}));
        return;
      }
      res.writeHead(404);res.end();return;
    }
    if(!isPermittedMcpIngressPath(req.method||"",raw)){
      res.writeHead(404,{"Cache-Control":"no-store"});res.end();return;
    }
    const serving=current;
    if(!serving||switching||closing||shutdownRequested||!verifyListener(serving.port,serving.pid)){
      reply(res,503,{error:"MCP_ANCHOR_TARGET_UNAVAILABLE"});return;
    }
    inFlight++;
    let finished=false;
    const finish=()=>{if(!finished){finished=true;inFlight=Math.max(0,inFlight-1);}};
    res.once("finish",finish);res.once("close",finish);
    const upstream=http.request({
      hostname:"127.0.0.1",port:serving.port,path:raw,
      method:req.method,headers:sanitizedMcpIngressHeaders(req.headers,serving.port),
    },(remote)=>{
      const headers={...remote.headers};
      delete headers.connection;
      delete headers["transfer-encoding"];
      if(!res.headersSent)res.writeHead(remote.statusCode||502,headers);
      remote.pipe(res);
    });
    upstream.on("error",()=>{
      if(!res.destroyed){
        if(!res.headersSent)res.writeHead(502,{"Cache-Control":"no-store"});
        res.end();
      }
      finish();
    });
    req.once("aborted",()=>upstream.destroy());
    res.once("close",()=>{if(!res.writableEnded)upstream.destroy();});
    req.pipe(upstream);
  });
  await new Promise<void>((resolve,reject)=>{
    handler.once("error",reject);
    handler.listen(opts.port,"127.0.0.1",resolve);
  });
  try{
    if(namedHost){
      // The named connector is independently administered. The Anchor only
      // binds its local ingress and never claims DNS/edge availability.
      baseUrl=publicOrigin("https://"+namedHost);
      tunnelPid=null;
    }else{
      const tunnel=await launch(opts.port);
      ownedTunnel=true;
      baseUrl=publicOrigin(tunnel.publicUrl);
      tunnelPid=tunnel.pid??null;
    }
  }catch(error){
    handler.closeAllConnections?.();
    await new Promise<void>(resolve=>handler.close(()=>resolve()));
    if(ownedTunnel)await stop(opts.port).catch(()=>undefined);
    throw error;
  }
  return {port:opts.port,publicUrl:baseUrl+"/mcp",close:async()=>{
    if(closing)return;
    closing=true;
    plan=null;
    handler.closeAllConnections?.();
    await new Promise<void>(resolve=>handler.close(()=>resolve()));
    if(ownedTunnel){ownedTunnel=false;await stop(opts.port);}
  }};
}
