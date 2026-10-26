/**
 * Operator-controlled persistent STAGING MCP service lifecycle.
 * Parent CLI exits while owner continues in a distinct process/profile.
 * No production port, public tunnel, OAuth issuer, token migration or OS task.
 * No PID kill: stops are private lease+nonce requests acknowledged by owner.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import {
  APPROVE_MANAGED_MCP, assertManagedMcpPort, assertManagedMcpDirectory,
  readManagedMcpLease, requestOwnedMcpStop,
} from "./mcpOwnerStagingLease.js";
import { readListenerOwners, auditCoreMcpOwnership } from "./coreMcpOwnershipAudit.js";
import { assessMcpOAuthMigration } from "./mcpOAuthMigrationPolicy.js";
import { probePrivateMcpOwner } from "./mcpOwnerControl.js";
import { verifyWindowsProcessBirth } from "./mcpProcessBirth.js";

const STAGING=path.join(os.homedir(),".superagent-local-staging");
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function options(argv:string[]) {
  const i=argv.indexOf("--port");
  const port=i<0?NaN:Number(argv[i+1]);
  assertManagedMcpPort(port);
  return {port,profile:path.join(STAGING,"managed-mcp-owner-"+port)};
}
function assertProfile(profile:string):void {
  assertManagedMcpDirectory(profile,STAGING);
}
async function available(port:number):Promise<boolean>{
  return new Promise(resolve=>{
    const s=net.createServer();
    s.once("error",()=>resolve(false));
    s.listen(port,"127.0.0.1",()=>s.close(()=>resolve(true)));
  });
}
function ownsListener(port:number,pid:number):boolean{
  return readListenerOwners()?.get(port)===pid;
}
async function probeMcpUnauthorized(port:number):Promise<boolean>{
  const ctrl=new AbortController();
  const timeout=setTimeout(()=>ctrl.abort(),1500);
  try {
    const r=await fetch("http://127.0.0.1:"+port+"/mcp",{
      method:"GET",redirect:"error",signal:ctrl.signal,
    });
    return r.status===401;
  }catch{return false;}
  finally{clearTimeout(timeout);}
}
function sanitizedEnv(profile:string,bearer:string):NodeJS.ProcessEnv{
  const env={...process.env};
  for(const key of Object.keys(env)){
    if(/KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|AUTH|MUSE|TELEGRAM|CLOUDFLARE|OPENROUTER|OPENAI|TUNNEL/i.test(key))
      delete env[key];
  }
  env.SUPERAGENT_CONFIG_DIR=profile;
  env.SUPERAGENT_CORE_STAGING="1";
  env.SUPERAGENT_SENOPATI_AUTOSTART="0";
  env.SUPERAGENT_MCP_OWNER_STAGING="1";
  env.SUPERAGENT_MCP_OWNER_STAGING_MANAGED="1";
  env.SUPERAGENT_MCP_OWNER_STAGING_BEARER=bearer;
  env.SUPERAGENT_SESSION_ID="";
  return env;
}
export interface McpOwnerHost {
  /** Each operation checks the exact same private owner lease, listener PID,
   * and authenticated generation; no alternative daemon is created here. */
  readonly mode:"staging_safe_only";
  capabilities(): {
    version:1; privateAuth:true; authenticatedHealth:true; gracefulDrain:true;
    safeToolsOnly:true; externalIngressAttachment:false; oauthIssuer:false;
    processBirthAttestation:"windows_kernel";
  };
  /** Explicitly unsupported until the separately authorized R3 ingress owner. */
  attachExternalIngress(provider:string):Promise<never>;
  status(port:number):Promise<ManagedMcpStatus>;
  start(port:number,approval:string,cli:string):Promise<ManagedMcpStatus>;
  drain(port:number,approval:string):Promise<ManagedMcpStatus>;
  stop(port:number,approval:string):Promise<ManagedMcpStatus>;
}
export type ManagedMcpStatus={
  version:1;port:number;profileConfigured:boolean;
  state:"absent"|"ready"|"unverified"|"blocked";
  ownerPid:number|null;listenerPid:number|null;
  authentication:"static-bearer-local-only";
  canStopWithoutProcessSignal:boolean;
  ownerControlAuthenticated:boolean;
  processBirthVerified:boolean;
  activeSessions:number|null;
  inFlightRequests:number|null;
  draining:boolean|null;
  unresolvedExternalEffects:"unknown";
  publicTunnelStarted:false;oauthMigrated:false;
};
export async function inspectManagedMcp(port:number):Promise<ManagedMcpStatus>{
  assertManagedMcpPort(port);
  const profile=path.join(STAGING,"managed-mcp-owner-"+port);
  const base={version:1 as const,port,profileConfigured:false,
    ownerPid:null as number|null,listenerPid:null as number|null,
    authentication:"static-bearer-local-only" as const,
    canStopWithoutProcessSignal:false,ownerControlAuthenticated:false,
    processBirthVerified:false,
    activeSessions:null as number|null,inFlightRequests:null as number|null,
    draining:null as boolean|null,
    unresolvedExternalEffects:"unknown" as const,
    publicTunnelStarted:false as const,oauthMigrated:false as const};
  if(!fs.existsSync(profile))return {...base,state:"absent"};
  try{assertProfile(profile);}
  catch{return {...base,state:"blocked"};}
  const files=fs.readdirSync(profile);
  const stop=files.includes("managed-stop.json");
  let lease;
  try{lease=readManagedMcpLease(profile);}
  catch{return {...base,profileConfigured:true,state:"blocked"};}
  if(!lease)return {...base,profileConfigured:true,state:stop?"blocked":"absent"};
  if(lease.port!==port)return {...base,profileConfigured:true,state:"blocked"};
  const osPid=readListenerOwners()?.get(port);
  const authenticated=osPid===lease.pid ? await probePrivateMcpOwner(lease):null;
  const processBirthVerified=authenticated!==null && osPid===lease.pid &&
    verifyWindowsProcessBirth(lease.pid,lease.createdAt)==="matched";
  const verified=!stop && processBirthVerified &&
    await probeMcpUnauthorized(port);
  return {...base,profileConfigured:true,ownerPid:lease.pid,
    listenerPid:osPid&&osPid>0?osPid:null,
    state:verified?"ready":stop?"blocked":"unverified",
    ownerControlAuthenticated:authenticated!==null,
    processBirthVerified,
    activeSessions:authenticated?.activeSessions??null,
    inFlightRequests:authenticated?.inFlightRequests??null,
    draining:authenticated?.draining??null,
    canStopWithoutProcessSignal:verified&&authenticated?.draining===true&&
      authenticated.activeSessions===0&&authenticated.inFlightRequests===0};
}
async function startManaged(port:number,approve:string,cli:string):Promise<ManagedMcpStatus>{
  if(approve!==APPROVE_MANAGED_MCP)
    throw new Error("Exact START_STAGING_MCP_OWNER approval required");
  fs.mkdirSync(STAGING,{recursive:true,mode:0o700});
  if(fs.existsSync(path.join(STAGING,"managed-mcp-owner-"+port))) {
    const current=await inspectManagedMcp(port);
    if(current.state!=="absent" || fs.readdirSync(path.join(STAGING,"managed-mcp-owner-"+port)).some(
      x=>x==="managed-owner.json"||x==="managed-stop.json"))
      throw new Error("Existing MCP owner or unverified lease: no implicit adoption");
  }
  if(!await available(port))throw new Error("MCP staging target port occupied");
  const profile=path.join(STAGING,"managed-mcp-owner-"+port);
  fs.mkdirSync(profile,{recursive:true,mode:0o700});
  assertProfile(profile);
  const entry=path.resolve(cli);
  const stat=fs.lstatSync(entry);
  if(!stat.isFile()||stat.isSymbolicLink()||path.basename(entry)!=="cli.js")
    throw new Error("Run with the compiled SuperAgent CLI");
  const child=spawn(process.execPath,[entry,"mcp","owner-sandbox","--port",String(port)],{
    cwd:profile,env:sanitizedEnv(profile,crypto.randomBytes(32).toString("hex")),
    detached:true,windowsHide:true,stdio:"ignore",
  });
  if(!child.pid)throw new Error("Managed MCP spawn returned no PID");
  child.unref();
  for(let i=0;i<60;i++){
    const current=await inspectManagedMcp(port);
    if(current.state==="ready"&&current.ownerPid===child.pid)return current;
    if(current.ownerPid!==null&&current.ownerPid!==child.pid)
      throw new Error("Unexpected MCP owner identity; refusing adoption");
    if(current.state==="blocked")throw new Error("MCP owner lease corrupt or stop pending");
    await pause(200);
  }
  throw new Error("Managed MCP did not establish authenticated ownership; inspect staging profile");
}
async function drainManaged(port:number,approve:string):Promise<ManagedMcpStatus>{
  if(approve!=="DRAIN_STAGING_MCP_OWNER")
    throw new Error("Exact DRAIN_STAGING_MCP_OWNER approval required");
  const prior=await inspectManagedMcp(port);
  if(prior.state!=="ready"||!prior.ownerControlAuthenticated)
    throw new Error("Cannot drain an unverified MCP owner");
  const profile=path.join(STAGING,"managed-mcp-owner-"+port);
  const lease=readManagedMcpLease(profile);
  if(!lease||lease.pid!==prior.ownerPid||!ownsListener(port,lease.pid)||
     verifyWindowsProcessBirth(lease.pid,lease.createdAt)!=="matched")
    throw new Error("MCP owner changed or process birth was not verified before drain");
  const status=await probePrivateMcpOwner(lease,"drain");
  if(!status||!status.draining)
    throw new Error("MCP owner did not acknowledge drain");
  return await inspectManagedMcp(port);
}
async function stopManaged(port:number,approve:string):Promise<ManagedMcpStatus>{
  if(approve!=="STOP_STAGING_MCP_OWNER")
    throw new Error("Exact STOP_STAGING_MCP_OWNER approval required");
  const prior=await inspectManagedMcp(port);
  if(prior.state!=="ready"||!prior.canStopWithoutProcessSignal)
    throw new Error("MCP drain not verified or sessions remain; no process signal or stop request");
  const profile=path.join(STAGING,"managed-mcp-owner-"+port);
  const lease=readManagedMcpLease(profile);
  if(!lease||lease.pid!==prior.ownerPid||!ownsListener(port,lease.pid)||
     verifyWindowsProcessBirth(lease.pid,lease.createdAt)!=="matched")
    throw new Error("MCP owner changed or process birth was not verified during stop");
  requestOwnedMcpStop(profile,lease);
  for(let i=0;i<40;i++){
    await pause(250);
    const now=await inspectManagedMcp(port);
    if(now.state==="absent" && !readListenerOwners()?.has(port))return now;
  }
  throw new Error("Managed MCP did not acknowledge stop; left owner untouched");
}
export const stagingMcpOwnerHost: McpOwnerHost = {
  mode:"staging_safe_only",
  capabilities:()=>({
    version:1,privateAuth:true,authenticatedHealth:true,
    gracefulDrain:true,safeToolsOnly:true,
    externalIngressAttachment:false,oauthIssuer:false,
    processBirthAttestation:"windows_kernel",
  }),
  attachExternalIngress:async()=>{throw new Error("External MCP ingress requires a separately verified R3 owner");},
  status:inspectManagedMcp,
  start:startManaged,
  drain:drainManaged,
  stop:stopManaged,
};
export async function handleMcpOwnerLifecycle(argv:string[],cli:string):Promise<unknown>{
  const action=argv[0]||"plan";
  const {port}=options(argv);
  if(action==="plan"){
    const ownership=await auditCoreMcpOwnership();
    const migration=assessMcpOAuthMigration({
      sharedLegacyCoreOwner:ownership.decision==="shared_owner_do_not_cutover",
      independentOwnerVerified:false,newIssuerConfigured:false,
      publicMcpEndpointMatched:false,clientsReauthorized:false,
      activeLegacySessions:null,pendingToolEffects:null,
      rollbackPathVerified:false,operatorApproved:false,
    });
    return {version:1,phase:"managed_mcp_owner_staging",port,
      profileKind:"private_local_staging",activation:"opt_in_only",
      oauthMigration:migration,
      authorizationTokensTransferable:false,
      productionCoreRestartAuthorized:false,liveMcpRestartAuthorized:false,
      productionSharedOwner:ownership.decision==="shared_owner_do_not_cutover",
      startCommand:"superagent mcp lifecycle start --port "+port+" --approve "+APPROVE_MANAGED_MCP,
      drainCommand:"superagent mcp lifecycle drain --port "+port+" --approve DRAIN_STAGING_MCP_OWNER",
      stopCommand:"superagent mcp lifecycle stop --port "+port+" --approve STOP_STAGING_MCP_OWNER"};
  }
  if(action==="status")return await stagingMcpOwnerHost.status(port);
  const i=argv.indexOf("--approve");
  const approve=i<0?"":argv[i+1];
  if(action==="start")return await stagingMcpOwnerHost.start(port,approve,cli);
  if(action==="drain")return await stagingMcpOwnerHost.drain(port,approve);
  if(action==="stop")return await stagingMcpOwnerHost.stop(port,approve);
  throw new Error("Usage: superagent mcp lifecycle plan|start|status|drain|stop --port PORT");
}
