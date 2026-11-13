/**
 * Read-only supervision of an independently owned MCP Tunnel Anchor.
 *
 * Never starts/stops/adopts cloudflared, repairs leases, sends control actions,
 * or replays MCP calls. A Quick Tunnel hostname cannot be recovered after the
 * original cloudflared dies; all ambiguous ownership fails closed.
 *
 * "verified_local" verifies process/loopback identities only. It does not
 * certify Cloudflare edge reachability or production OAuth continuity.
 */
import {
  readTunnelState,isOwnQuickTunnelProcess,type TunnelMetadata,
} from "../remoteAgent/cloudflareTunnel.js";
import {
  readMcpTunnelAnchorLease,probeMcpTunnelAnchor,
  type McpTunnelAnchorLease,
} from "./mcpTunnelAnchorLease.js";
import {
  readManagedMcpTunnelLease,probeManagedMcpTunnelOwner,
  type ManagedMcpTunnelLease,
  type ManagedMcpTunnelOwnerStatus,
} from "./mcpManagedTunnelOwner.js";
import {readListenerOwners} from "./coreMcpOwnershipAudit.js";
import {verifyWindowsProcessBirth} from "./mcpProcessBirth.js";

export type AnchorObservationLevel =
  "verified_local" | "unattached" | "degraded" | "unavailable";
export type AnchorObservationCode =
  "ANCHOR_VERIFIED_LOCAL" | "ANCHOR_UNATTACHED" |
  "ANCHOR_LEASE_UNAVAILABLE" | "ANCHOR_IDENTITY_UNVERIFIED" |
  "TUNNEL_STATE_MISMATCH" | "TUNNEL_PROCESS_UNVERIFIED" |
  "OWNER_LEASE_UNVERIFIED" | "OWNER_PROCESS_UNVERIFIED" |
  "OWNER_STATUS_UNVERIFIED" | "OWNER_NOT_SERVING";
export interface McpTunnelAnchorObservation {
  version:1;
  observedAt:number;
  port:number;
  level:AnchorObservationLevel;
  code:AnchorObservationCode;
  publicUrl:string|null;
  anchorPid:number|null;
  tunnelPid:number|null;
  ownerPid:number|null;
  ownerPort:number|null;
  noAutomaticTunnelRestart:true;
  remoteEdgeCertified:false;
  operatorReviewRequired:boolean;
}
type AnchorProof=Awaited<ReturnType<typeof probeMcpTunnelAnchor>>;
type OwnerStatus=ManagedMcpTunnelOwnerStatus & {
  publicUrl?:string;ingressMode?:string;
  oauthStatePersistent?:boolean;
};
export interface AnchorObserverDependencies {
  readAnchorLease:(port:number)=>McpTunnelAnchorLease|null;
  probeAnchor:(lease:McpTunnelAnchorLease)=>Promise<AnchorProof>;
  readTunnel:(port:number)=>TunnelMetadata|null;
  verifyTunnel:(pid:number,target:string)=>Promise<boolean>;
  readOwnerLease:(port:number)=>ManagedMcpTunnelLease|null;
  readListeners:()=>Map<number,number>|null;
  verifyOwnerBirth:(pid:number,startedAt:number)=>boolean;
  probeOwner:(lease:ManagedMcpTunnelLease)=>Promise<OwnerStatus|null>;
}

const defaults:AnchorObserverDependencies={
  readAnchorLease:readMcpTunnelAnchorLease,
  probeAnchor:probeMcpTunnelAnchor,
  readTunnel:readTunnelState,
  verifyTunnel:isOwnQuickTunnelProcess,
  readOwnerLease:readManagedMcpTunnelLease,
  readListeners:readListenerOwners,
  verifyOwnerBirth:(pid,startedAt)=>process.platform!=="win32" ||
    verifyWindowsProcessBirth(pid,startedAt)==="matched",
  probeOwner:probeManagedMcpTunnelOwner,
};

export async function observeMcpTunnelAnchor(
  port:number,overrides:Partial<AnchorObserverDependencies>={},
):Promise<McpTunnelAnchorObservation>{
  if(!Number.isSafeInteger(port)||port<1024||port>65535||port===7888)
    throw Error("MCP_ANCHOR_OBSERVER_INVALID_PORT");
  const d={...defaults,...overrides};
  const base:McpTunnelAnchorObservation={
    version:1,observedAt:Date.now(),port,level:"unavailable",
    code:"ANCHOR_LEASE_UNAVAILABLE",publicUrl:null,anchorPid:null,
    tunnelPid:null,ownerPid:null,ownerPort:null,
    noAutomaticTunnelRestart:true,remoteEdgeCertified:false,
    operatorReviewRequired:true,
  };
  const mark=(level:AnchorObservationLevel,code:AnchorObservationCode):McpTunnelAnchorObservation=>({
    ...base,level,code,operatorReviewRequired:level==="degraded"||level==="unavailable",
  });
  let lease:McpTunnelAnchorLease|null;
  try{lease=d.readAnchorLease(port);}
  catch{return mark("unavailable","ANCHOR_LEASE_UNAVAILABLE");}
  if(!lease)return mark("unavailable","ANCHOR_LEASE_UNAVAILABLE");
  if(lease.port!==port)return mark("unavailable","ANCHOR_IDENTITY_UNVERIFIED");
  let proof:AnchorProof;
  try{proof=await d.probeAnchor(lease);}
  catch{return mark("unavailable","ANCHOR_IDENTITY_UNVERIFIED");}
  if(proof.pid!==lease.pid||proof.port!==lease.port||
     proof.startedAt!==lease.createdAt||proof.publicUrl!==lease.publicUrl)
    return mark("unavailable","ANCHOR_IDENTITY_UNVERIFIED");
  base.publicUrl=lease.publicUrl;
  base.anchorPid=lease.pid;
  base.tunnelPid=lease.tunnelPid;

  let tunnel:TunnelMetadata|null;
  try{tunnel=d.readTunnel(port);}
  catch{return mark("degraded","TUNNEL_STATE_MISMATCH");}
  const target="http://127.0.0.1:"+port;
  if(!tunnel||!Number.isSafeInteger(lease.tunnelPid)||lease.tunnelPid!<=0||
     tunnel.pid!==lease.tunnelPid||tunnel.port!==port||
     tunnel.serviceKind!=="mcp-http"||tunnel.localUrl!==target||
     tunnel.publicUrl+"/mcp"!==lease.publicUrl)
    return mark("degraded","TUNNEL_STATE_MISMATCH");
  try{
    if(!await d.verifyTunnel(tunnel.pid,target))
      return mark("degraded","TUNNEL_PROCESS_UNVERIFIED");
  }catch{return mark("degraded","TUNNEL_PROCESS_UNVERIFIED");}

  base.ownerPid=proof.currentOwnerPid;
  base.ownerPort=proof.currentOwnerPort;
  if(proof.currentOwnerPort===null&&proof.currentOwnerPid===null&&!proof.ready)
    return mark("unattached","ANCHOR_UNATTACHED");
  if(proof.currentOwnerPort===null||proof.currentOwnerPid===null||
     proof.currentOwnerPort===port)
    return mark("degraded","OWNER_LEASE_UNVERIFIED");

  let owner:ManagedMcpTunnelLease|null;
  try{owner=d.readOwnerLease(proof.currentOwnerPort);}
  catch{return mark("degraded","OWNER_LEASE_UNVERIFIED");}
  if(!owner||owner.port!==proof.currentOwnerPort||
     owner.pid!==proof.currentOwnerPid)
    return mark("degraded","OWNER_LEASE_UNVERIFIED");
  try{
    if(d.readListeners()?.get(owner.port)!==owner.pid||
       !d.verifyOwnerBirth(owner.pid,owner.createdAt))
      return mark("degraded","OWNER_PROCESS_UNVERIFIED");
  }catch{return mark("degraded","OWNER_PROCESS_UNVERIFIED");}
  let status:OwnerStatus|null;
  try{status=await d.probeOwner(owner);}
  catch{return mark("degraded","OWNER_STATUS_UNVERIFIED");}
  if(!status||status.kind!=="private_mcp_owner"||
     status.pid!==owner.pid||status.port!==owner.port||
     status.startedAt!==owner.createdAt||status.publicUrl!==lease.publicUrl||
     status.ingressMode!=="external-anchor")
    return mark("degraded","OWNER_STATUS_UNVERIFIED");
  if(!proof.ready||status.draining||status.backendHealthy!==true||
     status.reloadable!==true||
     (status.oauthEnabled&&status.oauthStatePersistent!==true))
    return mark("degraded","OWNER_NOT_SERVING");
  return mark("verified_local","ANCHOR_VERIFIED_LOCAL");
}
