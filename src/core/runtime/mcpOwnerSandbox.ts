/**
 * Dedicated MCP HTTP process for isolated local ownership acceptance.
 * No public tunnel, OAuth migration, agent execution or service lifecycle.
 * Requires explicit staging profile, working directory and ephemeral bearer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMcpHttpServer } from "../mcp/mcpHttpTransport.js";
export async function runIsolatedMcpOwner(args:string[]):Promise<true>{
  const idx=args.indexOf("--port");
  const port=idx<0?NaN:Number(args[idx+1]);
  if(!Number.isInteger(port)||port<1024||port>65535||port===7888||port===7892)
    throw new Error("Isolated MCP owner requires a distinct non-production local port");
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
  const handle=await startMcpHttpServer({
    port,bearerToken:token,authMode:"static-bearer",
    allowDangerous:false,toolExposure:"gateway",
    maxSessions:2,sessionIdleTimeoutMs:30_000,sessionMaxLifetimeMs:120_000,
    auditLogPath:path.join(root,"mcp-sandbox-audit.jsonl"),
    publicBaseUrl:"http://127.0.0.1:"+port,
    hostOriginPolicy:{allowNoOrigin:true,allowedOrigins:[]},
  });
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
    try{await handle.close();}finally{process.exit(0);}
  };
  process.once("SIGTERM",()=>{void shutdown();});
  process.once("SIGINT",()=>{void shutdown();});
  return true;
}
