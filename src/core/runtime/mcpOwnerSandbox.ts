/**
 * Dedicated MCP HTTP process for isolated local ownership acceptance.
 * No public tunnel, OAuth migration, agent execution or service lifecycle.
 * Requires explicit staging profile, working directory and ephemeral bearer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { startMcpHttpServer } from "../mcp/mcpHttpTransport.js";
import { probePrivateMcpOwner } from "./mcpOwnerControl.js";
import {
  assertManagedMcpPort, cleanOwnMcpLease, matchesOwnedMcpStop,
  writeOwnedMcpLease, type ManagedMcpLease,
} from "./mcpOwnerStagingLease.js";
export async function runIsolatedMcpOwner(args:string[]):Promise<true>{
  const idx=args.indexOf("--port");
  const port=idx<0?NaN:Number(args[idx+1]);
  assertManagedMcpPort(port);
  if(args.some(x=>/^(--allow-dangerous|--oauth|--tunnel|--provider|--public|--yolo)$/i.test(x)))
    throw new Error("Isolated MCP owner forbids dangerous tools and external tunnels");
  if(process.env.SUPERAGENT_MCP_OWNER_STAGING!=="1"||
     process.env.SUPERAGENT_SENOPATI_AUTOSTART!=="0"||
     process.env.SUPERAGENT_CORE_STAGING!=="1")
    throw new Error("MCP owner sandbox requires explicit no-model staging mode");
  const root=path.resolve(process.env.SUPERAGENT_CONFIG_DIR||"");
  const base=path.resolve(os.homedir(),".superagent-local-staging");
  const relative=path.relative(base,root);
  if(!relative||relative.startsWith("..")||path.isAbsolute(relative))
    throw new Error("MCP owner staging profile must be beneath local staging directory");
  const stat=fs.lstatSync(root);
  if(!stat.isDirectory()||stat.isSymbolicLink()) throw new Error("Unsafe staging profile");
  const token=process.env.SUPERAGENT_MCP_OWNER_STAGING_BEARER||"";
  if(!/^[a-f0-9]{64}$/.test(token))throw new Error("MCP staging requires a private 256-bit bearer");
  const managed=process.env.SUPERAGENT_MCP_OWNER_STAGING_MANAGED==="1";
  const lease:ManagedMcpLease|undefined=managed?{
    version:1,kind:"managed_mcp_staging",pid:process.pid,port,
    nonce:crypto.randomBytes(32).toString("hex"),createdAt:Date.now(),
    auth:"private_bearer",modelAutostart:false,publicTunnel:false,
  }:undefined;
  const handle=await startMcpHttpServer({
    port,bearerToken:token,authMode:"static-bearer",
    allowDangerous:false,lockSafeTools:true,toolExposure:"gateway",
    maxSessions:2,sessionIdleTimeoutMs:30_000,sessionMaxLifetimeMs:120_000,
    auditLogPath:path.join(root,"mcp-sandbox-audit.jsonl"),
    publicBaseUrl:"http://127.0.0.1:"+port,
    hostOriginPolicy:{allowNoOrigin:true,allowedOrigins:[]},
    ...(lease?{ownerControlToken:lease.nonce,ownerStartedAt:lease.createdAt}:{}),
  });
  let interval:NodeJS.Timeout|undefined;
  try {
    if(lease)writeOwnedMcpLease(root,lease);
  }catch(error){
    await handle.close();
    throw error;
  }
  // Do not persist token, active-mcp state or public tunnel metadata.
  console.log(JSON.stringify({
    type:"isolated_mcp_owner_ready",pid:process.pid,port:handle.port,
    oauthEnabled:false,publicTunnelStarted:false,
    dangerousToolsEnabled:false,coreOwner:false,
  }));
  let stopping=false;
  const shutdown=async()=>{
    if(stopping)return;
    stopping=true;
    if(interval)clearInterval(interval);
    try{await handle.close();}
    finally{
      if(lease) {
        try{cleanOwnMcpLease(root,lease);}catch{
          // Preserve malformed markers for operator review, never delete them.
        }
      }
      process.exit(0);
    }
  };
  process.once("SIGTERM",()=>{void shutdown();});
  process.once("SIGINT",()=>{void shutdown();});
  if(lease){
    interval=setInterval(()=>{
      try {
        if(matchesOwnedMcpStop(root,lease!)) {
          // An already-accepted MCP request or session may still be active.
          // A previously approved stop is not permission to drop its work.
          void probePrivateMcpOwner(lease!).then(s=>{
            if(s?.draining && s.activeSessions===0 &&
               s.inFlightRequests===0)void shutdown();
          });
        }
      } catch{
        // An untrusted/corrupt marker must not authorize shutdown.
      }
    },300);
  }
  return true;
}
