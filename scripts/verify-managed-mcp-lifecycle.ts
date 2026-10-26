/**
 * Phase 5n — real Windows MCP staging owner lifecycle and no-cutover drill.
 * Spawns no public OAuth or external tunnel, never kills a PID.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readListenerOwners } from "../src/core/runtime/coreMcpOwnershipAudit.js";
const cli=path.resolve(import.meta.dir,"..","dist","cli.js");
const root=path.join(os.homedir(),".superagent-local-staging");
const checks:string[]=[];
function assert(name:string,value:unknown){
  if(!value)throw new Error("Managed MCP staging assertion failed: "+name);
  checks.push(name);
}
async function unused():Promise<number>{
  return new Promise((resolve,reject)=>{
    const server=net.createServer();
    server.once("error",reject);
    server.listen(0,"127.0.0.1",()=>{
      const a=server.address();
      if(!a||typeof a==="string")throw new Error("No local port");
      server.close(()=>resolve(a.port));
    });
  });
}
function exec(args:string[],timeout=18000){
  return spawnSync(process.execPath,[cli,"mcp","lifecycle",...args],{
    cwd:path.dirname(cli),timeout,windowsHide:true,
    encoding:"utf8",maxBuffer:256*1024,stdio:"pipe",
  });
}
const baseline=readListenerOwners();
const savedProd=[6789,7888,9877].map(p=>[p,baseline?.get(p)] as const);
let port=await unused();
while([6789,7888,7892,9877].includes(port)||
      fs.existsSync(path.join(root,"managed-mcp-owner-"+port))) port=await unused();
let started=false,profile=path.join(root,"managed-mcp-owner-"+port);
try{
  let result=exec(["status","--port",String(port)]);
  assert("new_staging_owner_absent",result.status===0&&JSON.parse(result.stdout).state==="absent");
  result=exec(["start","--port",String(port),"--approve","NO"]);
  assert("cannot_start_without_explicit_approval",result.status!==0);
  result=exec(["start","--port",String(port),"--approve","START_STAGING_MCP_OWNER"],30000);
  if(result.status!==0)throw new Error("MCP lifecycle staging start failed: "+result.stderr.slice(-900));
  const owner=JSON.parse(result.stdout);
  started=true;
  assert("persistent_owner_authenticated_and_verified",owner.state==="ready"&&owner.ownerPid>0&&owner.ownerPid===owner.listenerPid);
  assert("private_generation_handshake_required",owner.ownerControlAuthenticated===true&&
    owner.processBirthVerified===true&&owner.activeSessions===0&&
    owner.inFlightRequests===0&&owner.draining===false);
  const firstPid=owner.ownerPid;
  result=exec(["status","--port",String(port)]);
  const status=JSON.parse(result.stdout);
  assert("owner_outlives_starting_cli",result.status===0&&status.ownerPid===firstPid&&status.state==="ready");
  result=exec(["start","--port",String(port),"--approve","START_STAGING_MCP_OWNER"]);
  assert("duplicate_start_refused",result.status!==0);
  result=exec(["stop","--port",String(port),"--approve","NO"]);
  assert("stop_without_explicit_approval_refused",result.status!==0);
  result=exec(["status","--port",String(port)]);
  assert("owner_remains_healthy_after_denied_stop",JSON.parse(result.stdout).state==="ready");
  result=exec(["stop","--port",String(port),"--approve","STOP_STAGING_MCP_OWNER"]);
  assert("stop_requires_separate_verified_drain",result.status!==0);
  result=exec(["drain","--port",String(port),"--approve","NO"]);
  assert("unauthorized_drain_refused",result.status!==0);
  result=exec(["drain","--port",String(port),"--approve","DRAIN_STAGING_MCP_OWNER"]);
  if(result.status!==0)throw new Error("MCP drain failed: "+result.stderr.slice(-900));
  const drained=JSON.parse(result.stdout);
  assert("drain_authenticated_and_quiescent",drained.state==="ready"&&
    drained.draining===true&&drained.activeSessions===0&&
    drained.inFlightRequests===0&&drained.canStopWithoutProcessSignal===true);
  assert("lease_is_private_and_does_not_contain_token",
    fs.readFileSync(path.join(profile,"managed-owner.json"),"utf8").includes("managed_mcp_staging")&&
    !fs.readFileSync(path.join(profile,"managed-owner.json"),"utf8").includes("bearerToken"));
  const files=fs.readdirSync(profile);
  assert("no_oauth_or_external_tunnel_files",files.every(f=> !/oauth|tunnel|mcp-.*\\.json$/i.test(f)));
  result=exec(["stop","--port",String(port),"--approve","STOP_STAGING_MCP_OWNER"],18000);
  if(result.status!==0)throw new Error("MCP lifecycle staging stop failed: "+result.stderr.slice(-900));
  started=false;
  assert("authenticated_stop_acknowledged_without_process_signal",JSON.parse(result.stdout).state==="absent");
  result=exec(["status","--port",String(port)]);
  assert("owner_lease_removed_and_status_absent",JSON.parse(result.stdout).state==="absent");
  const owners=readListenerOwners();
  assert("staging_port_released",!owners?.has(port));
  assert("production_core_and_mcp_listeners_unchanged",savedProd.every(([p,pid])=>pid===undefined||owners?.get(p)===pid));
  console.log(JSON.stringify({phase:"managed-mcp-staging-owner",ok:true,checks,
    verifiedChecks:checks.length,stagingPort:port,publicTunnelCreated:false,
    oauthTransferred:false,processSignalsSent:0,
    productionCoreRestarted:false},null,2));
}catch(e){
  console.error("MANAGED_MCP_STAGING_FAILED "+String(e));
  process.exitCode=1;
}finally{
  // Only explicitly stop a lease that currently authenticates to the exact
  // staging port; never call taskkill or touch any legacy production process.
  if(started){
    const s=exec(["status","--port",String(port)]);
    if(s.status===0){
      try{
        if(JSON.parse(s.stdout).state==="ready") {
          exec(["drain","--port",String(port),"--approve","DRAIN_STAGING_MCP_OWNER"]);
          exec(["stop","--port",String(port),"--approve","STOP_STAGING_MCP_OWNER"]);
        }
      }catch{}
    }
  }
}
