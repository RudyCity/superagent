/**
 * Private, OS-bound identity for an independently running MCP Tunnel Anchor.
 * The lease is not proof by itself: status requires authenticated loopback
 * control and the kernel listener PID must match before use.
 */
import fs from "node:fs";
import path from "node:path";
import {getRootConfigDir} from "../config/paths.js";
import {readListenerOwners} from "./coreMcpOwnershipAudit.js";
import {verifyWindowsProcessBirth} from "./mcpProcessBirth.js";

export interface McpTunnelAnchorLease {
  version:1;kind:"mcp_tunnel_anchor";pid:number;port:number;createdAt:number;
  publicUrl:string;nonce:string;tunnelPid:number|null;
  tunnelMode?:"quick"|"named-external";
}
function assertPort(port:number):number{
  if(!Number.isSafeInteger(port)||port<1024||port>65535||port===7888)
    throw Error("MCP_ANCHOR_INVALID_PORT");
  return port;
}
export function mcpTunnelAnchorLeasePath(port:number):string{
  return path.join(getRootConfigDir(),"mcp-tunnel-anchor-"+assertPort(port)+".json");
}
function validLease(value:unknown):value is McpTunnelAnchorLease{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const v=value as Partial<McpTunnelAnchorLease>;
  return v.version===1&&v.kind==="mcp_tunnel_anchor"&&
    Number.isSafeInteger(v.pid)&&v.pid!>0&&
    Number.isSafeInteger(v.port)&&v.port!>=1024&&v.port!<=65535&&v.port!==7888&&
    Number.isSafeInteger(v.createdAt)&&v.createdAt!>0&&
    (v.tunnelMode===undefined||v.tunnelMode==="quick"||v.tunnelMode==="named-external")&&
    (v.tunnelMode!=="named-external"||v.tunnelPid===null)&&
    (v.tunnelPid===null||(Number.isSafeInteger(v.tunnelPid)&&v.tunnelPid!>0))&&
    typeof v.nonce==="string"&&/^[a-f0-9]{64}$/.test(v.nonce)&&
    typeof v.publicUrl==="string"&&/^https:\/\/[^/\s?#]+\/mcp$/.test(v.publicUrl);
}
export function readMcpTunnelAnchorLease(port:number):McpTunnelAnchorLease|null{
  const file=mcpTunnelAnchorLeasePath(port);
  try{
    const st=fs.lstatSync(file);
    if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>4096)
      throw Error("MCP_ANCHOR_LEASE_UNSAFE");
    const value=JSON.parse(fs.readFileSync(file,"utf8")) as unknown;
    if(!validLease(value)||(value as McpTunnelAnchorLease).port!==port)
      throw Error("MCP_ANCHOR_LEASE_INVALID");
    return value as McpTunnelAnchorLease;
  }catch(error){
    if((error as NodeJS.ErrnoException).code==="ENOENT")return null;
    throw error;
  }
}
export function writeMcpTunnelAnchorLease(lease:McpTunnelAnchorLease):void{
  if(!validLease(lease))throw Error("MCP_ANCHOR_LEASE_INVALID");
  const filename=mcpTunnelAnchorLeasePath(lease.port);
  const dir=path.dirname(filename);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if(fs.lstatSync(dir).isSymbolicLink())
    throw Error("MCP_ANCHOR_LEASE_DIRECTORY_UNSAFE");
  fs.writeFileSync(filename,JSON.stringify(lease)+"\n",{flag:"wx",mode:0o600});
}
export function cleanMcpTunnelAnchorLease(lease:McpTunnelAnchorLease):void{
  try{
    const latest=readMcpTunnelAnchorLease(lease.port);
    if(latest?.pid===lease.pid&&latest.createdAt===lease.createdAt&&
       latest.nonce===lease.nonce&&latest.publicUrl===lease.publicUrl)
      fs.rmSync(mcpTunnelAnchorLeasePath(lease.port),{force:true});
  }catch{
    // Unrecognized or corrupted state is reserved for operator review.
  }
}
export async function probeMcpTunnelAnchor(
  lease:McpTunnelAnchorLease,
):Promise<{pid:number;port:number;startedAt:number;publicUrl:string;
           currentOwnerPid:number|null;currentOwnerPort:number|null;
           inFlightRequests:number;ready:boolean}>{
  if(!validLease(lease)||readListenerOwners()?.get(lease.port)!==lease.pid)
    throw Error("MCP_ANCHOR_OS_LISTENER_UNVERIFIED");
  if(process.platform==="win32"&&
     verifyWindowsProcessBirth(lease.pid,lease.createdAt)!=="matched")
    throw Error("MCP_ANCHOR_PROCESS_BIRTH_UNVERIFIED");
  const r=await fetch("http://127.0.0.1:"+lease.port+"/_internal/anchor/status",{
    headers:{Host:"127.0.0.1:"+lease.port,Authorization:"Bearer "+lease.nonce},
    signal:AbortSignal.timeout(3500),
  });
  if(r.status!==200)throw Error("MCP_ANCHOR_PRIVATE_STATUS_UNAVAILABLE");
  const raw=await r.text();
  if(raw.length>4096)throw Error("MCP_ANCHOR_STATUS_OVERSIZED");
  const status=JSON.parse(raw);
  if(status.version!==1||status.kind!=="mcp_tunnel_anchor"||
     status.pid!==lease.pid||status.port!==lease.port||
     status.startedAt!==lease.createdAt||
     status.publicUrl!==lease.publicUrl||
     status.tunnelPid!==lease.tunnelPid||
     (status.tunnelMode??"quick")!==(lease.tunnelMode??"quick")||
     typeof status.ready!=="boolean"||
     !Number.isSafeInteger(status.inFlightRequests)||
     status.inFlightRequests<0||
     !(status.currentOwnerPid===null||
       Number.isSafeInteger(status.currentOwnerPid)&&status.currentOwnerPid>0)||
     !(status.currentOwnerPort===null||
       Number.isSafeInteger(status.currentOwnerPort)&&status.currentOwnerPort>0))
    throw Error("MCP_ANCHOR_PRIVATE_STATUS_MISMATCH");
  return status;
}
