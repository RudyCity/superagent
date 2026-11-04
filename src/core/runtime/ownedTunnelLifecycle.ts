/**
 * Explicit destructive stop for exactly one recognized Cloudflare Quick Tunnel.
 * Never restart/rotate a public URL, never use all-port or blind PID signals.
 */
import crypto from "node:crypto";
import {
  listActiveTunnels,isOwnQuickTunnelProcess,stopQuickTunnel,
} from "../remoteAgent/cloudflareTunnel.js";
import {ManagedSidecarLedger,sidecarOperationFingerprint} from "./managedSidecarLedger.js";
import {validateCoreOperationId} from "./coreLifecycleLedger.js";

export type ManagedTunnelTarget="rest_tunnel"|"muse_tunnel";
const expectedKind=(service:ManagedTunnelTarget)=>
  service==="rest_tunnel"?"superagent-http" as const:"muse-websocket" as const;

async function exactOwnedTunnel(service:ManagedTunnelTarget,port:number){
  if(!Number.isSafeInteger(port)||port<1024||port>65535)
    throw new Error("TUNNEL_INVALID_PORT");
  const found=listActiveTunnels().filter(x=>x.port===port);
  if(found.length!==1||found[0].serviceKind!==expectedKind(service))
    throw new Error("TUNNEL_NO_MATCHING_OWNED_SERVICE");
  const tunnel=found[0];
  if(!await isOwnQuickTunnelProcess(tunnel.pid,tunnel.localUrl))
    throw new Error("TUNNEL_PROCESS_OWNER_UNVERIFIED");
  return tunnel;
}

export async function planOwnedTunnelStop(service:ManagedTunnelTarget,port:number){
  const tunnel=await exactOwnedTunnel(service,port);
  return {
    service,action:"stop" as const,port,operationId:crypto.randomUUID(),
    expectedOwnerPid:tunnel.pid,expectedPublicUrl:tunnel.publicUrl,
    expectedLocalUrl:tunnel.localUrl,
    allowPublicDisruption:true,
    note:"DESTRUCTIVE public tunnel stop. Clients disconnect and URL can change. Explicit operator approval required; no automatic restart.",
  };
}
export async function stopOwnedTunnel(args:{
  service:ManagedTunnelTarget;port:number;confirm:boolean;operationId:string;
  expectedOwnerPid:number;expectedPublicUrl:string;expectedLocalUrl:string;
  allowPublicDisruption:boolean;
}) {
  if(args.confirm!==true||args.allowPublicDisruption!==true)
    throw new Error("TUNNEL_EXPLICIT_PUBLIC_DISRUPTION_APPROVAL_REQUIRED");
  validateCoreOperationId(args.operationId);
  if(!Number.isSafeInteger(args.expectedOwnerPid)||args.expectedOwnerPid<=0||
     !/^https:\/\/[^\s]+$/.test(args.expectedPublicUrl)||
     !/^http:\/\/127\.0\.0\.1:\d{4,5}(?:\/|$)/.test(args.expectedLocalUrl))
    throw new Error("TUNNEL_INVALID_EXPECTED_IDENTITY");
  const ledger=new ManagedSidecarLedger(args.service,args.port);
  const fingerprint=sidecarOperationFingerprint({
    service:args.service,action:"stop",port:args.port,
    expectedOwnerPid:args.expectedOwnerPid,expectedPublicUrl:args.expectedPublicUrl,
    expectedLocalUrl:args.expectedLocalUrl,allowPublicDisruption:true,
  });
  const old=ledger.lookup(args.operationId,fingerprint);
  if(old?.replayed){
    if(listActiveTunnels().some(x=>x.port===args.port&&x.pid===args.expectedOwnerPid))
      throw new Error("TUNNEL_REPLAY_OWNER_STILL_PRESENT");
    return {service:args.service,action:"stop",port:args.port,
      replayed:true,changed:false,previousPublicUrl:args.expectedPublicUrl};
  }
  const tunnel=await exactOwnedTunnel(args.service,args.port);
  if(tunnel.pid!==args.expectedOwnerPid||
     tunnel.publicUrl!==args.expectedPublicUrl||
     tunnel.localUrl!==args.expectedLocalUrl)
    throw new Error("TUNNEL_OWNER_OR_URL_CHANGED_SINCE_PLAN");
  ledger.begin(args.operationId,fingerprint);
  const stopped=await stopQuickTunnel(args.port,expectedKind(args.service));
  if(!stopped||listActiveTunnels().some(x=>x.port===args.port&&x.pid===tunnel.pid))
    throw new Error("TUNNEL_STOP_OUTCOME_UNKNOWN: review before retry");
  ledger.complete(args.operationId,0);
  return {service:args.service,action:"stop",port:args.port,
    replayed:false,changed:true,previousPublicUrl:tunnel.publicUrl,
    note:"Owner-verified Quick Tunnel stopped with explicit public disruption approval. URL not preserved."};
}
