/**
 * Reviewed and isolated MCP OAuth owner bootstrap for a remote-managed
 * Cloudflare Named Tunnel. Runs as a short-lived, private Bun child of the
 * operator's native Tray, NOT as a Cloudflare connector or Quick Tunnel.
 *
 * Never logs a token, bootstrap code, OAuth secret or owner control nonce.
 * The original Gemini owner on 9227 and its issuer are never accessed.
 */
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {verifyRemoteManagedNamedProfile} from "../src/core/runtime/mcpNamedRemoteProfile.js";
import {
  readMcpTunnelAnchorLease,probeMcpTunnelAnchor,
} from "../src/core/runtime/mcpTunnelAnchorLease.js";
import {
  startManagedMcpTunnelOwner,readManagedMcpTunnelLease,
  verifyManagedOwnerIdentity,probeManagedMcpTunnelOwner,
  stopManagedMcpTunnelOwner,
} from "../src/core/runtime/mcpManagedTunnelOwner.js";

const command=process.argv.slice(2);
if(command.length!==2||command[0]!=="start-profile"||command[1]!=="--reviewed")
  throw Error("MCP_NAMED_OWNER_START_REQUIRES_EXPLICIT_REVIEW");

const launcherDir=path.dirname(fileURLToPath(import.meta.url));
const parent=path.resolve(launcherDir,"..");
// Source: repo/scripts/*.ts -> repo. Packaged: standalone/dist/scripts/*.js
// -> standalone root. Never resolve another project through PATH/CWD.
const home=fs.existsSync(path.join(parent,"package.json"))
  ? parent:path.resolve(parent,"..");
function requireBundleFile(file:string):void {
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1024)
    throw Error("MCP_NAMED_OWNER_MISSING_VERIFIED_CLI");
}
async function authenticatedAnchor(
  port:number,nonce:string,operation:"plan"|"activate",body:Record<string,unknown>,
):Promise<Record<string,unknown>> {
  if(!/^[a-f0-9]{64}$/.test(nonce))
    throw Error("MCP_NAMED_OWNER_ANCHOR_NONCE_INVALID");
  const reply=await fetch("http://127.0.0.1:"+port+"/_internal/anchor/"+operation,{
    method:"POST",headers:{Authorization:"Bearer "+nonce,
      "Content-Type":"application/json",Host:"127.0.0.1:"+port},
    body:JSON.stringify(body),signal:AbortSignal.timeout(8000),
  });
  const text=await reply.text();
  if(text.length>8192)throw Error("MCP_NAMED_OWNER_ANCHOR_RESPONSE_TOO_LARGE");
  const record=JSON.parse(text) as unknown;
  if(!record||typeof record!=="object"||Array.isArray(record))
    throw Error("MCP_NAMED_OWNER_ANCHOR_RESPONSE_INVALID");
  if(!reply.ok)throw Error("MCP_NAMED_OWNER_ANCHOR_"+operation.toUpperCase()+"_BLOCKED");
  return record as Record<string,unknown>;
}
async function start():Promise<void>{
  const p=verifyRemoteManagedNamedProfile();
  if(p.ownerPort===9227||p.anchorPort===9227||p.ownerPort===p.anchorPort)
    throw Error("MCP_NAMED_OWNER_PROTECTED_MCP_PORT");
  if(readManagedMcpTunnelLease(p.ownerPort))
    throw Error("MCP_NAMED_OWNER_PREEXISTING_LEASE");
  const anchor=readMcpTunnelAnchorLease(p.anchorPort);
  if(!anchor)throw Error("MCP_NAMED_OWNER_ANCHOR_LEASE_MISSING");
  const before=await probeMcpTunnelAnchor(anchor);
  if(before.pid!==anchor.pid||before.publicUrl!==p.publicUrl||
    before.tunnelMode!=="named-external"||
    before.currentOwnerPid!==null||before.currentOwnerPort!==null||
    before.inFlightRequests!==0||before.switching!==false||
    before.ready!==false)
    throw Error("MCP_NAMED_OWNER_ANCHOR_NOT_ISOLATED");
  const cli=path.join(home,"dist","cli.js");
  requireBundleFile(cli);
  let spawnedPort:number|null=null;
  try {
    const spawned=await startManagedMcpTunnelOwner([
      "--port",String(p.ownerPort),
      "--anchor-port",String(p.anchorPort),
      "--provider","cloudflare","--mcp-auth","oauth",
    ],cli,home);
    spawnedPort=p.ownerPort;
    const owner=readManagedMcpTunnelLease(p.ownerPort);
    if(!owner||owner.pid!==spawned.pid||owner.port!==p.ownerPort)
      throw Error("MCP_NAMED_OWNER_LEASE_MISSING_OR_MISMATCHED");
    await verifyManagedOwnerIdentity(owner);
    const attested=await probeManagedMcpTunnelOwner(owner) as (
      Record<string,unknown>|null
    );
    if(!attested||attested.pid!==owner.pid||
      attested.publicUrl!==p.publicUrl||
      attested.ingressMode!=="external-anchor"||
      attested.reloadable!==true||
      attested.oauthEnabled!==true||
      attested.oauthStatePersistent!==true||
      attested.safeToolsOnly!==true||
      attested.backendHealthy!==true||
      attested.draining!==false||
      attested.activeSessions!==0||
      attested.inFlightRequests!==0)
      throw Error("MCP_NAMED_OWNER_AUTH_OR_PERSISTENCE_NOT_VERIFIED");
    const latest=await probeMcpTunnelAnchor(anchor);
    if(latest.pid!==before.pid||latest.publicUrl!==p.publicUrl||
      latest.currentOwnerPid!==null||latest.currentOwnerPort!==null||
      latest.inFlightRequests!==0)
      throw Error("MCP_NAMED_OWNER_ANCHOR_CHANGED_DURING_START");
    const target={port:owner.port,pid:owner.pid,
      nonce:owner.nonce,startedAt:owner.createdAt};
    const planned=await authenticatedAnchor(p.anchorPort,anchor.nonce,"plan",{
      target,expectedAnchorPid:anchor.pid,
      expectedPublicUrl:p.publicUrl,expectedPreviousPid:null,
    });
    if(typeof planned.planId!=="string"||!/^[a-f0-9]{32}$/.test(planned.planId)||
      planned.expectedPreviousPid!==null||
      planned.newOwnerPid!==owner.pid||planned.newOwnerPort!==owner.port||
      planned.requiresDrain!==false)
      throw Error("MCP_NAMED_OWNER_UNSAFE_ANCHOR_PLAN");
    const activated=await authenticatedAnchor(p.anchorPort,anchor.nonce,"activate",{
      planId:planned.planId,reviewed:true,
      expectedAnchorPid:anchor.pid,expectedPublicUrl:p.publicUrl,
      expectedPreviousPid:null,expectedNextOwnerPid:owner.pid,
      expectedNextOwnerPort:owner.port,
    });
    if(activated.success!==true||activated.anchorPid!==anchor.pid||
      activated.ownerPid!==owner.pid||activated.publicUrl!==p.publicUrl||
      activated.noTunnelRestart!==true||activated.noImplicitReplay!==true)
      throw Error("MCP_NAMED_OWNER_ANCHOR_ACTIVATION_UNVERIFIED");
    const attached=await probeMcpTunnelAnchor(anchor);
    if(attached.pid!==anchor.pid||attached.publicUrl!==p.publicUrl||
      attached.currentOwnerPid!==owner.pid||
      attached.currentOwnerPort!==owner.port||
      attached.ready!==true)
      throw Error("MCP_NAMED_OWNER_ANCHOR_ATTACH_UNVERIFIED");
    // No startup credentials, pairing codes, tokens, or nonce are printed.
    process.stdout.write(JSON.stringify({
      status:"verified_named_owner_attached",
      ownerPort:owner.port,ownerPid:owner.pid,
      anchorPort:p.anchorPort,publicUrl:p.publicUrl,
      oauthStatePersistent:true,safeToolsOnly:true,
      noQuickTunnelMutation:true,clientCutoverApproved:false,
    })+"\n");
    spawnedPort=null;
  }catch(error){
    if(spawnedPort!==null){
      // Attempt graceful cleanup of the newly created, exact private owner.
      // No force kill and no process adoption, even if cleanup fails.
      try{await stopManagedMcpTunnelOwner(spawnedPort);}catch{}
    }
    throw error;
  }
}
await start().catch(()=>{
  // Deliberately do not echo exception strings: runtime/proxy errors may
  // include private environment, auth context or file contents.
  process.stderr.write("MCP_NAMED_OWNER_START_BLOCKED_CHECK_PRIVATE_READINESS\n");
  process.exitCode=1;
});
