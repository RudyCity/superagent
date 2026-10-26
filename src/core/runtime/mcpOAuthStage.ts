/**
 * R2 independent, loopback-only OAuth staging issuer. No legacy state import,
 * no public tunnel, no Core/model process, no production ports.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {McpDurableOAuthStore} from "../mcp/mcpDurableOAuthStore.js";
import {startMcpHttpServer} from "../mcp/mcpHttpTransport.js";
import {assertManagedMcpPort} from "./mcpOwnerStagingLease.js";
export async function runIndependentOAuthStage(args:string[]):Promise<void>{
  const idx=args.indexOf("--port"),port=idx<0?NaN:Number(args[idx+1]);
  assertManagedMcpPort(port);
  if(args.length!==2||idx!==0)
    throw new Error("Usage: mcp oauth-stage --port TEST_PORT (no public/tunnel options)");
  if(process.env.SUPERAGENT_MCP_OAUTH_STAGING!=="1"||
     process.env.SUPERAGENT_CORE_STAGING!=="1"||
     process.env.SUPERAGENT_SENOPATI_AUTOSTART!=="0")
    throw new Error("Separate OAuth issuer requires explicit isolated staging");
  const root=fs.realpathSync(process.env.SUPERAGENT_CONFIG_DIR||"");
  const staging=fs.realpathSync(path.join(os.homedir(),".superagent-local-staging"));
  const relative=path.relative(staging,root);
  if(!relative||relative.startsWith("..")||path.isAbsolute(relative)||
     fs.lstatSync(root).isSymbolicLink())
    throw new Error("OAuth owner profile must be a private staging directory");
  const approval=process.env.SUPERAGENT_MCP_OAUTH_STAGE_BOOTSTRAP||"";
  if(!/^[a-f0-9]{64}$/.test(approval))
    throw new Error("Missing private stage-only OAuth consent secret");
  const issuer="http://127.0.0.1:"+port;
  const store=new McpDurableOAuthStore(root,issuer,
    {keyMode:process.platform==="win32"?"windows-dpapi":"raw-test"});
  const handle=await startMcpHttpServer({
    port,allowDangerous:false,lockSafeTools:true,toolExposure:"gateway",
    authMode:"oauth",oauthStore:store,
    oauth:{publicBaseUrl:issuer,
      bootstrapCodeHash:crypto.createHash("sha256").update(approval).digest("hex")},
    auditLogPath:path.join(root,"oauth-stage-audit.jsonl"),
    hostOriginPolicy:{allowNoOrigin:true,allowedOrigins:[]},
    maxSessions:8,sessionIdleTimeoutMs:60_000,sessionMaxLifetimeMs:5*60_000,
  });
  console.log(JSON.stringify({type:"independent_oauth_stage_ready",
    pid:process.pid,port:handle.port,issuerKind:"private_loopback",
    persistentCredentialHashState:true,publicTunnelStarted:false,
    importedLegacyTokens:false,canCutoverProduction:false}));
  let stopping=false;
  const close=async()=>{
    if(stopping)return;stopping=true;
    await handle.close();process.exit(0);
  };
  process.once("SIGINT",()=>{void close()});
  process.once("SIGTERM",()=>{void close()});
}
