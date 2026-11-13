/**
 * Standalone, explicitly operated Tunnel Anchor process and local control.
 *
 * start PORT             : create new independent Quick Tunnel (never adopt)
 * status PORT            : authenticate private anchor and verify OS listener
 * plan PORT OWNER_PORT   : inspect owner handoff without rerouting traffic
 * activate PORT OWNER_PORT PLAN_ID EXPECTED_PREVIOUS_PID --reviewed
 *
 * Do not use this to migrate an active Quick Tunnel: a new Quick Tunnel URL is
 * random and cannot be reassigned to an existing cloudflared child process.
 */
import crypto from "node:crypto";
import {startMcpTunnelAnchor} from "../src/core/runtime/mcpTunnelAnchor.js";
import {readManagedMcpTunnelLease,verifyManagedOwnerIdentity}
  from "../src/core/runtime/mcpManagedTunnelOwner.js";
import {readMcpTunnelAnchorLease,writeMcpTunnelAnchorLease,
  cleanMcpTunnelAnchorLease,probeMcpTunnelAnchor,
  type McpTunnelAnchorLease} from "../src/core/runtime/mcpTunnelAnchorLease.js";

const [command,portRaw,ownerPortRaw,planId,prevRaw,review]=process.argv.slice(2);
const port=Number(portRaw);
if(!["start","status","plan","activate"].includes(command??"")||
   !Number.isSafeInteger(port)||port<1024||port>65535||port===7888)
  throw Error("MCP_ANCHOR_USAGE: start PORT | status PORT | plan PORT OWNER_PORT | activate PORT OWNER_PORT PLAN_ID EXPECTED_PREVIOUS_PID --reviewed");
if(command==="start"){
  if(process.argv.length!==4||readMcpTunnelAnchorLease(port))
    throw Error("MCP_ANCHOR_REFUSE_DUPLICATE_OR_EXISTING_LEASE");
  const createdAt=Date.now(),nonce=crypto.randomBytes(32).toString("hex");
  const handle=await startMcpTunnelAnchor({port,nonce,createdAt});
  let lease:McpTunnelAnchorLease|undefined;
  try{
    const response=await fetch("http://127.0.0.1:"+port+"/_internal/anchor/status",{
      headers:{Authorization:"Bearer "+nonce},
      signal:AbortSignal.timeout(3000),
    });
    if(response.status!==200)throw Error("MCP_ANCHOR_NOT_READY");
    const s=await response.json();
    lease={version:1,kind:"mcp_tunnel_anchor",pid:process.pid,port,nonce,
      createdAt,publicUrl:handle.publicUrl,tunnelPid:s.tunnelPid};
    writeMcpTunnelAnchorLease(lease);
  }catch(error){
    await handle.close();
    throw error;
  }
  console.log(JSON.stringify({state:"active",anchorPid:process.pid,port,
    publicUrl:handle.publicUrl,autoOwnerRestart:false},null,2));
  let closing=false;
  const shutdown=async()=>{
    if(closing)return;closing=true;
    try{await handle.close();}finally{if(lease)cleanMcpTunnelAnchorLease(lease);}
    process.exit(0);
  };
  process.once("SIGINT",()=>void shutdown());
  process.once("SIGTERM",()=>void shutdown());
}else{
  if(command==="status"&&process.argv.length!==4 ||
     command==="plan"&&process.argv.length!==5 ||
     command==="activate"&&(process.argv.length!==8||review!=="--reviewed"))
    throw Error("MCP_ANCHOR_CONTROL_USAGE_INVALID");
  const lease=readMcpTunnelAnchorLease(port);
  if(!lease)throw Error("MCP_ANCHOR_LEASE_MISSING");
  const status=await probeMcpTunnelAnchor(lease);
  if(command==="status"){
    console.log(JSON.stringify(status,null,2));
  }else{
    const ownerPort=Number(ownerPortRaw);
    if(!Number.isSafeInteger(ownerPort)||ownerPort===port)
      throw Error("MCP_ANCHOR_OWNER_PORT_INVALID");
    const owner=readManagedMcpTunnelLease(ownerPort);
    if(!owner)throw Error("MCP_ANCHOR_OWNER_LEASE_MISSING");
    await verifyManagedOwnerIdentity(owner);
    const body=command==="plan"?{
      target:{port:owner.port,pid:owner.pid,startedAt:owner.createdAt,nonce:owner.nonce},
      expectedAnchorPid:lease.pid,expectedPublicUrl:lease.publicUrl,
      expectedPreviousPid:status.currentOwnerPid,
    }:{
      planId,reviewed:true,expectedAnchorPid:lease.pid,
      expectedPublicUrl:lease.publicUrl,
      expectedPreviousPid:prevRaw==="none"?null:Number(prevRaw),
      expectedNextOwnerPid:owner.pid,expectedNextOwnerPort:owner.port,
    };
    if(command==="activate"&&(body.expectedPreviousPid!==status.currentOwnerPid||
        typeof planId!=="string"||!/^[a-f0-9]{32}$/.test(planId)))
      throw Error("MCP_ANCHOR_ACTIVATE_STALE_PLAN_OR_OWNER");
    const endpoint=command==="plan"?"plan":"activate";
    const resp=await fetch("http://127.0.0.1:"+port+"/_internal/anchor/"+endpoint,{
      method:"POST",headers:{Authorization:"Bearer "+lease.nonce,
        "Content-Type":"application/json",Host:"127.0.0.1:"+port},
      body:JSON.stringify(body),signal:AbortSignal.timeout(8000),
    });
    const result=await resp.json();
    if(!resp.ok)throw Error("MCP_ANCHOR_"+endpoint.toUpperCase()+"_BLOCKED: "+String(result.error));
    const after=await probeMcpTunnelAnchor(lease);
    if(after.publicUrl!==status.publicUrl||after.pid!==status.pid)
      throw Error("MCP_ANCHOR_IDENTITY_CHANGED");
    console.log(JSON.stringify({action:endpoint,...result,
      ...(command==="activate"?{verifiedOwnerPid:after.currentOwnerPid}:{}),
      publicUrl:status.publicUrl},null,2));
  }
}
