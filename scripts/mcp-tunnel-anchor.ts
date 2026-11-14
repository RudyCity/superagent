/**
 * Standalone, explicitly operated Tunnel Anchor process and local control.
 *
 * start PORT             : create new independent Quick Tunnel (never adopt)
 * start-named PORT ABSOLUTE_SPEC_JSON --reviewed : bind named external ingress only; no cloudflared/DNS mutation
 * status PORT            : authenticate private anchor and verify OS listener
 * plan PORT OWNER_PORT   : inspect owner handoff without rerouting traffic
 * activate PORT OWNER_PORT PLAN_ID EXPECTED_PREVIOUS_PID --reviewed
 *
 * Do not use this to migrate an active Quick Tunnel: a new Quick Tunnel URL is
 * random and cannot be reassigned to an existing cloudflared child process.
 */
import crypto from "node:crypto";
import {startMcpTunnelAnchor} from "../src/core/runtime/mcpTunnelAnchor.js";
import {observeMcpTunnelAnchor} from "../src/core/runtime/mcpTunnelAnchorObserver.js";
import {readMcpNamedTunnelSpec,verifyStagedMcpNamedTunnel} from "../src/core/runtime/mcpNamedTunnelConfig.js";
import {verifyRemoteManagedNamedProfile} from "../src/core/runtime/mcpNamedRemoteProfile.js";
import {readManagedMcpTunnelLease,verifyManagedOwnerIdentity}
  from "../src/core/runtime/mcpManagedTunnelOwner.js";
import {readMcpTunnelAnchorLease,writeMcpTunnelAnchorLease,
  cleanMcpTunnelAnchorLease,probeMcpTunnelAnchor,
  type McpTunnelAnchorLease} from "../src/core/runtime/mcpTunnelAnchorLease.js";

const [command,portRaw,ownerPortRaw,planId,prevRaw,review]=process.argv.slice(2);
const port=Number(portRaw);
if(!["start","start-named","start-profile","status","plan","activate"].includes(command??"")||
   !Number.isSafeInteger(port)||port<1024||port>65535||port===7888)
  throw Error("MCP_ANCHOR_USAGE: start PORT | start-named PORT ABSOLUTE_SPEC_JSON --reviewed | status PORT | plan PORT OWNER_PORT | activate PORT OWNER_PORT PLAN_ID EXPECTED_PREVIOUS_PID --reviewed");
if(command==="start"||command==="start-named"||command==="start-profile"){
  if(command==="start"&&process.argv.length!==4||
     command==="start-named"&&(process.argv.length!==6||planId!=="--reviewed")||
     command==="start-profile"&&(process.argv.length!==5||ownerPortRaw!=="--reviewed")||
     readMcpTunnelAnchorLease(port))
    throw Error("MCP_ANCHOR_REFUSE_DUPLICATE_OR_EXISTING_LEASE");
  const namedSpec=command==="start-named"?readMcpNamedTunnelSpec(ownerPortRaw):null;
  if(namedSpec)verifyStagedMcpNamedTunnel(namedSpec,port);
  // A remote-managed Cloudflare tunnel does not use local credentials JSON.
  // Only the Tray-owned token file is verified; this command never runs it.
  const remoteProfile=command==="start-profile"?verifyRemoteManagedNamedProfile():null;
  if(remoteProfile&&remoteProfile.anchorPort!==port)
    throw Error("MCP_NAMED_REMOTE_ANCHOR_PORT_MISMATCH");
  const externalHost=namedSpec?.hostname??remoteProfile?.hostname;
  const createdAt=Date.now(),nonce=crypto.randomBytes(32).toString("hex");
  // The externally managed Named Anchor can accept a reviewed private
  // shutdown request only after its lease is installed and shutdown is ready.
  let shutdownHandler:(()=>Promise<void>)|null=null;
  const handle=await startMcpTunnelAnchor({port,nonce,createdAt,
    ...(externalHost?{externalNamedHostname:externalHost,
      onStopRequested:async()=>{
        const handler=shutdownHandler;
        if(!handler)throw Error("MCP_NAMED_ANCHOR_SHUTDOWN_NOT_READY");
        await handler();
      }}:{})});
  let lease:McpTunnelAnchorLease|undefined;
  try{
    const response=await fetch("http://127.0.0.1:"+port+"/_internal/anchor/status",{
      headers:{Authorization:"Bearer "+nonce},
      signal:AbortSignal.timeout(3000),
    });
    if(response.status!==200)throw Error("MCP_ANCHOR_NOT_READY");
    const s=await response.json();
    lease={version:1,kind:"mcp_tunnel_anchor",pid:process.pid,port,nonce,
      createdAt,publicUrl:handle.publicUrl,tunnelPid:s.tunnelPid,
      ...(externalHost?{tunnelMode:"named-external" as const}:{})};
    writeMcpTunnelAnchorLease(lease);
  }catch(error){
    await handle.close();
    throw error;
  }
  console.log(JSON.stringify({state:"active",anchorPid:process.pid,port,
    publicUrl:handle.publicUrl,autoOwnerRestart:false,
    tunnelMode:externalHost?"named-external":"quick",
    externalConnectorVerified:false,dnsChanged:false},null,2));
  let closing=false;
  const shutdown=async()=>{
    if(closing)return;closing=true;
    try{await handle.close();}finally{if(lease)cleanMcpTunnelAnchorLease(lease);}
    process.exit(0);
  };
  shutdownHandler=shutdown;
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
    // Owner attached is not the same as a healthy Cloudflare process.
    // Report the read-only attestation alongside the private control state.
    const observation=await observeMcpTunnelAnchor(port);
    console.log(JSON.stringify({...status,observation},null,2));
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
