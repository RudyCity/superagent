/**
 * Phase 5m acceptance: an independent authenticated MCP HTTP owner and Core
 * supervisor, each in fresh TEST-only profiles with distinct loopback ports.
 * No public tunnel, OAuth migration, external tools or production restart.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readListenerOwners } from "../src/core/runtime/coreMcpOwnershipAudit.js";
const repo=path.resolve(import.meta.dir,"..");
const entry=path.join(repo,"dist","cli.js");
if(!fs.existsSync(entry))throw new Error("Build SuperAgent before MCP split stage");
const base=path.join(os.homedir(),".superagent-local-staging");
fs.mkdirSync(base,{recursive:true,mode:0o700});
const root=fs.mkdtempSync(path.join(base,"core-mcp-owner-"));
const coreProfile=path.join(root,"core");
const mcpProfile=path.join(root,"mcp");
const workspace=path.join(root,"workspace");
for(const d of [coreProfile,mcpProfile,workspace])fs.mkdirSync(d,{recursive:true,mode:0o700});
async function port():Promise<number>{
  const srv=net.createServer();
  return await new Promise((resolve,reject)=>{
    srv.once("error",reject);
    srv.listen(0,"127.0.0.1",()=>{
      const addr=srv.address();
      const p=addr&&typeof addr!=="string"?addr.port:0;
      srv.close(()=>p>=1024&&p!==7888&&p!==7892?resolve(p):reject(Error("Bad test port")));
    });
  });
}
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually<T>(fn:()=>Promise<T|null>,limit=30000):Promise<T>{
  const start=Date.now();
  while(Date.now()-start<limit) {
    const result=await fn().catch(()=>null);
    if(result!==null)return result;
    await wait(180);
  }
  throw new Error("MCP/Core split staging readiness timed out");
}
function isolated(profile:string):NodeJS.ProcessEnv{
  const env={...process.env};
  for(const key of Object.keys(env)){
    if(/(_KEY|_TOKEN|_PASSWORD|_SECRET|_CREDENTIAL|_AUTH|MUSE|TELEGRAM|CLOUDFLARE|OPENROUTER|OPENAI_MCP)/i.test(key))
      delete env[key];
  }
  env.SUPERAGENT_CONFIG_DIR=profile;
  env.SUPERAGENT_CORE_STAGING="1";
  env.SUPERAGENT_SENOPATI_AUTOSTART="0";
  env.SUPERAGENT_MCP_OWNER_STAGING="1";
  return env;
}
function childAlive(c:ChildProcess):boolean{
  return c.exitCode===null&&c.signalCode===null&&!!c.pid;
}
function stopOwned(c:ChildProcess|undefined,servicePort:number){
  if(!c?.pid||!childAlive(c))return;
  const owner=readListenerOwners()?.get(servicePort);
  // Strict Windows owner comparison. A failed check is NOT permission to kill
  // unknown PIDs. Keep the staging process for manual review if uncertain.
  if(process.platform==="win32" && owner!==c.pid)return;
  if(process.platform==="win32"){
    spawnSync("taskkill",["/T","/F","/PID",String(c.pid)],{
      timeout:6000,windowsHide:true,stdio:"ignore",
    });
  } else c.kill("SIGTERM");
}
const checks:string[]=[];
const check=(name:string,value:unknown)=>{
  if(!value)throw new Error("Core/MCP split acceptance failed: "+name);
  checks.push(name);
};
let core:ChildProcess|undefined,mcp:ChildProcess|undefined;
let corePort=0,mcpPort=0;
let coreLog="",mcpLog="";
const baseline=readListenerOwners();
const oldMcpPid=baseline?.get(6789);
try{
  corePort=await port();mcpPort=await port();
  while(mcpPort===corePort)mcpPort=await port();
  const bearer=crypto.randomBytes(32).toString("hex");
  const refused=spawnSync(process.execPath,[entry,"mcp","owner-sandbox",
    "--port",String(mcpPort)],{
    cwd:workspace,
    env:{...isolated(mcpProfile),SUPERAGENT_MCP_OWNER_STAGING:"0",
      SUPERAGENT_MCP_OWNER_STAGING_BEARER:bearer},
    windowsHide:true,stdio:"pipe",timeout:7000,encoding:"utf8",
  });
  check("missing_staging_consent_cannot_bind_mcp",refused.status!==0);
  const dangerous=spawnSync(process.execPath,[entry,"mcp","owner-sandbox",
    "--port",String(mcpPort),"--allow-dangerous"],{
    cwd:workspace,
    env:{...isolated(mcpProfile),SUPERAGENT_MCP_OWNER_STAGING_BEARER:bearer},
    windowsHide:true,stdio:"pipe",timeout:7000,encoding:"utf8",
  });
  check("dangerous_mcp_tools_rejected_before_bind",dangerous.status!==0);
  core=spawn(process.execPath,[entry,"core","start","--port",String(corePort)],{
    cwd:workspace,env:isolated(coreProfile),windowsHide:true,stdio:["ignore","ignore","pipe"],
  });
  if(!core.pid)throw new Error("Core stage spawn failed");
  core.stderr?.on("data",c=>{coreLog=(coreLog+String(c)).slice(-1200)});
  const coreOwner=await eventually(async()=>{
    if(!childAlive(core!))throw new Error("Stage Core exited: "+coreLog);
    try{
      const state=JSON.parse(fs.readFileSync(path.join(coreProfile,
        "core-supervisor-"+corePort+".json"),"utf8"));
      if(state.supervisorPid!==core?.pid)throw new Error("Core registered foreign owner");
      const res=await fetch("http://127.0.0.1:"+state.controlPort+"/status",{
        headers:{Authorization:"Bearer "+state.controlToken},
        signal:AbortSignal.timeout(1500),
      });
      if(res.status!==200)return null;
      const body=await res.json() as {supervisorPid:number;publicPort:number;active:{pid:number}};
      return body.supervisorPid===core?.pid&&body.publicPort===corePort&&
        body.active?.pid>0?body:null;
    }catch{return null;}
  });
  check("authenticated_test_core_and_worker",coreOwner.supervisorPid===core.pid);
  mcp=spawn(process.execPath,[entry,"mcp","owner-sandbox","--port",String(mcpPort)],{
    cwd:workspace,
    env:{...isolated(mcpProfile),SUPERAGENT_MCP_OWNER_STAGING_BEARER:bearer},
    windowsHide:true,stdio:["ignore","pipe","pipe"],
  });
  if(!mcp.pid)throw new Error("MCP stage spawn failed");
  mcp.stderr?.on("data",c=>{mcpLog=(mcpLog+String(c)).slice(-1200)});
  const mcpStage=await eventually(async()=>{
    if(!childAlive(mcp!))throw new Error("MCP stage exited: "+mcpLog);
    try{
      const res=await fetch("http://127.0.0.1:"+mcpPort+"/mcp",{
        method:"GET",signal:AbortSignal.timeout(1300),
      });
      return res.status===401?true:null;
    }catch{return null;}
  });
  check("separate_mcp_owner_requires_bearer",mcpStage);
  const authProbe=await fetch("http://127.0.0.1:"+mcpPort+"/mcp",{
    method:"GET",headers:{Authorization:"Bearer "+bearer},
    signal:AbortSignal.timeout(1600),
  });
  check("mcp_bearer_verified_no_tool_calls",authProbe.status===400);
  const owners=readListenerOwners();
  if(process.platform==="win32"){
    check("os_listener_core_owned_by_supervisor",owners?.get(corePort)===core.pid);
    check("os_listener_mcp_owned_by_independent_pid",owners?.get(mcpPort)===mcp.pid);
  }
  check("core_mcp_independent_processes",core.pid!==mcp.pid);
  check("stage_mcp_has_no_public_tunnel_or_oauth_state",
    !fs.existsSync(path.join(mcpProfile,"mcp-"+mcpPort+".json")));
  check("production_mcp_owner_untouched_before_cleanup",
    oldMcpPid===undefined||owners?.get(6789)===oldMcpPid);
  const report={phase:"core-mcp-independent-ownership",
    ok:true,verifiedChecks:checks.length,checks,corePort,mcpPort,
    corePid:core.pid,mcpPid:mcp.pid,workerPid:coreOwner.active.pid,
    publicTunnelCreated:false,oauthMigrated:false,toolsCalled:0,
    productionCutoverAuthorized:false,createdAt:Date.now()};
  fs.writeFileSync(path.join(root,"report.json"),JSON.stringify(report,null,2),{
    mode:0o600,flag:"wx",
  });
  console.log(JSON.stringify({ok:true,verifiedChecks:checks.length,
    checks,reportPath:path.join(root,"report.json")},null,2));
}catch(e){
  console.error("CORE_MCP_SPLIT_STAGE_FAILED "+String(e)+
    " core="+coreLog.slice(-400)+" mcp="+mcpLog.slice(-400));
  process.exitCode=1;
}finally{
  stopOwned(mcp,mcpPort);
  stopOwned(core,corePort);
}
