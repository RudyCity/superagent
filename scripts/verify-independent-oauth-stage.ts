/** R2 live independent OAuth staging acceptance, no production port or ingress. */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {spawn, type ChildProcess} from "node:child_process";
import {readListenerOwners} from "../src/core/runtime/coreMcpOwnershipAudit.js";
const cli=path.resolve(import.meta.dir,"..","dist","cli.js");
const root=path.join(os.homedir(),".superagent-local-staging");
fs.mkdirSync(root,{recursive:true,mode:0o700});
const dir=fs.mkdtempSync(path.join(root,"r2-oauth-stage-"));
const secret=crypto.randomBytes(32).toString("hex");
async function unused(){
 const s=net.createServer();
 return await new Promise<number>((res,rej)=>{
   s.once("error",rej);
   s.listen(0,"127.0.0.1",()=>{
     const a=s.address();s.close(()=>a&&typeof a!=="string"?res(a.port):rej(Error("No port")));
   });
 });
}
let port=await unused();
while([6789,7888,7892,9877].includes(port))port=await unused();
const issuer="http://127.0.0.1:"+port;
const env={...process.env,SUPERAGENT_CONFIG_DIR:dir,
  SUPERAGENT_CORE_STAGING:"1",SUPERAGENT_SENOPATI_AUTOSTART:"0",
  SUPERAGENT_MCP_OAUTH_STAGING:"1",
  SUPERAGENT_MCP_OAUTH_STAGE_BOOTSTRAP:secret};
for(const k of Object.keys(env))if(/TUNNEL|TELEGRAM|MUSE|CLOUDFLARE|OPENROUTER|OPENAI_API_KEY/i.test(k))delete env[k];
let current:ChildProcess|undefined;
let ingress:ChildProcess|undefined;
let ingressPort=0;
let log="";
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function check(n:string,ok:unknown){
 if(!ok)throw new Error("R2 stage check failed "+n);
 checks.push(n);
}
const checks:string[]=[];
async function launch(){
 log="";
 current=spawn(process.execPath,[cli,"mcp","oauth-stage","--port",String(port)],{
  cwd:dir,env,windowsHide:true,stdio:["ignore","pipe","pipe"],
 });
 current.stdout?.on("data",x=>{log=(log+String(x)).slice(-500)});
 current.stderr?.on("data",x=>{log=(log+String(x)).slice(-500)});
 if(!current.pid)throw Error("Missing test PID");
 for(let i=0;i<130;i++){
  if(current.exitCode!==null)throw Error("Staging owner exited "+log);
  try {
    const r=await fetch(issuer+"/.well-known/oauth-authorization-server",{
      signal:AbortSignal.timeout(850),
    });
    if(r.status===200){
      const data=await r.json() as {issuer:string;code_challenge_methods_supported:string[]};
      if(data.issuer===issuer && data.code_challenge_methods_supported.includes("S256"))return;
    }
  }catch{}
  await sleep(100);
 }
 throw Error("Stage owner timeout "+log);
}
async function launchIngress(){
  ingressPort=await unused();
  while(ingressPort===port||[6789,7888,7892,9877].includes(ingressPort))
    ingressPort=await unused();
  ingress=spawn(process.execPath,[cli,"mcp","ingress-stage",
    "--listen-port",String(ingressPort),
    "--target-port",String(port),
    "--target-pid",String(current!.pid)],{
    cwd:dir,env:{...env,SUPERAGENT_MCP_INGRESS_STAGING:"1"},
    windowsHide:true,stdio:["ignore","ignore","pipe"],
  });
  ingress.stderr?.on("data",x=>{log=(log+String(x)).slice(-500)});
  if(!ingress.pid)throw Error("Missing ingress staging PID");
  const url="http://127.0.0.1:"+ingressPort;
  for(let i=0;i<120;i++){
    if(ingress.exitCode!==null)throw Error("Ingress owner exited "+log);
    try{
      const r=await fetch(url+"/.well-known/oauth-authorization-server",{
        signal:AbortSignal.timeout(900),
      });
      if(r.status===200 && (await r.json()).issuer===issuer)return;
    }catch{}
    await sleep(100);
  }
  throw Error("Ingress stage did not become healthy: "+log);
}
async function stopIngress(){
  if(!ingress?.pid || ingress.exitCode!==null || ingress.signalCode!==null)return;
  if(process.platform==="win32" && readListenerOwners()?.get(ingressPort)!==ingress.pid)
    throw Error("Ingress OS listener owner mismatch; refused stop");
  const owned=ingress;
  owned.kill();
  for(let i=0;i<100&&owned.exitCode===null;i++)await sleep(80);
  if(owned.exitCode===null&&owned.signalCode===null)
    throw Error("Ingress did not close");
}
async function stop(){
 if(!current?.pid||current.exitCode!==null)return;
 // Only terminate this process when OS confirms it owns the unique test port.
 if(process.platform==="win32"&&readListenerOwners()?.get(port)!==current.pid)
  throw Error("Cannot prove test ownership; refusing process stop");
 const c=current; c.kill();
 for(let i=0;i<120&&c.exitCode===null;i++)await sleep(90);
 if(c.exitCode===null && c.signalCode===null)
   throw Error("Test process did not exit; no unrelated process killed");
}
const old=readListenerOwners();
const owners=[6789,7888,9877].map(p=>[p,old?.get(p)] as const);
try {
  await launch();
  check("isolated_new_oauth_pid",current?.pid && readListenerOwners()?.get(port)===current.pid);
  const m=await (await fetch(issuer+"/.well-known/oauth-protected-resource")).json() as {resource:string};
  check("independent_resource_metadata",m.resource===issuer+"/mcp");
  const reg=await fetch(issuer+"/oauth/register",{
   method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({client_name:"r2-canary",client_id:"r2-canary",
     redirect_uris:["http://127.0.0.1:57641/callback"]}),
  });
  check("new_client_registered",reg.status===201);
  // Real HTTP PKCE/consent flow using the NEW issuer only.
  const redirectUri="http://127.0.0.1:57641/callback";
  const verifier=crypto.randomBytes(32).toString("base64url");
  const challenge=crypto.createHash("sha256").update(verifier).digest("base64url");
  const consent=await fetch(issuer+"/oauth/authorize?"+new URLSearchParams({
    client_id:"r2-canary",redirect_uri:redirectUri,response_type:"code",
    code_challenge:challenge,code_challenge_method:"S256",
    scope:"mcp:tools",resource:issuer+"/mcp",state:"new-issuer-canary",
  }),{redirect:"manual"});
  const requestId=/name="request_id" value="([^"]+)"/.exec(await consent.text())?.[1];
  check("oauth_pkce_consent_page",consent.status===200&&!!requestId);
  const approval=await fetch(issuer+"/oauth/authorize",{
    method:"POST",redirect:"manual",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({request_id:requestId||"",bootstrap_code:secret,
      decision:"approve"}),
  });
  const code=new URL(approval.headers.get("location")||redirectUri).searchParams.get("code");
  check("oauth_owner_consent_redirect",approval.status===302&&!!code);
  const tokenParams=(ver:string)=>new URLSearchParams({
    grant_type:"authorization_code",code:code||"",client_id:"r2-canary",
    redirect_uri:redirectUri,code_verifier:ver,resource:issuer+"/mcp",
  });
  const wrong=await fetch(issuer+"/oauth/token",{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:tokenParams("intentionally_wrong_verifier"),
  });
  check("pkce_wrong_verifier_denied",wrong.status===400);
  const accepted=await fetch(issuer+"/oauth/token",{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:tokenParams(verifier),
  });
  const initial=await accepted.json() as {access_token:string;refresh_token:string};
  check("pkce_token_issued",accepted.status===200&&!!initial.refresh_token);
  await launchIngress();
  check("independent_ingress_pid",ingress?.pid&&current?.pid&&ingress.pid!==current.pid&&
    readListenerOwners()?.get(ingressPort)===ingress.pid);
  const viaIngress=await fetch("http://127.0.0.1:"+ingressPort+"/mcp");
  check("oauth_authentication_preserved_through_ingress",viaIngress.status===401);
  const blocked=await fetch("http://127.0.0.1:"+ingressPort+"/_internal/owner/status");
  check("internal_owner_control_not_proxied",blocked.status===404);
  await stopIngress();
  check("ingress_stop_does_not_stop_oauth",
    (await fetch(issuer+"/.well-known/oauth-authorization-server")).status===200);
  await stop();
  check("owner_stopped_without_core_stop",current?.exitCode!==null||current?.signalCode!==null);
  await launch();
  check("restart_preserves_issuer_identity",current?.pid&&readListenerOwners()?.get(port)===current.pid);
  const refresh=async(token:string)=>await fetch(issuer+"/oauth/token",{
    method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({grant_type:"refresh_token",
      refresh_token:token,resource:issuer+"/mcp"}),
  });
  const rotation=await refresh(initial.refresh_token);
  const rotated=await rotation.json() as {access_token:string;refresh_token:string};
  check("issued_refresh_survives_owner_restart",rotation.status===200&&!!rotated.refresh_token);
  check("rotated_refresh_replay_denied",(await refresh(initial.refresh_token)).status===400);
  const authenticatedMcp=await fetch(issuer+"/mcp",{
    method:"POST",headers:{Authorization:"Bearer "+rotated.access_token,
      "Content-Type":"application/json",Accept:"application/json, text/event-stream"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",
      params:{protocolVersion:"2024-11-05",capabilities:{},
        clientInfo:{name:"r2-canary",version:"1"}}}),
  });
  check("restarted_oauth_token_authenticates_mcp",
    authenticatedMcp.status===200&&!!authenticatedMcp.headers.get("mcp-session-id"));
  await authenticatedMcp.text();
  const bad=await fetch(issuer+"/oauth/authorize?client_id=r2-canary&redirect_uri="+
     encodeURIComponent("http://127.0.0.1:9999/callback")+
     "&response_type=code&code_challenge=x&code_challenge_method=S256");
  check("registration_survives_restart_but_redirect_immutable",bad.status===400);
  check("no_legacy_oauth_files_imported",!fs.readdirSync(dir).some(x=>x==="mcp-6789.json"||x==="mcp-9877.json"));
  const after=readListenerOwners();
  check("all_production_listener_pids_unchanged",owners.every(([p,pid])=>pid===undefined||after?.get(p)===pid));
  console.log(JSON.stringify({ok:true,phase:"R2_independent_oauth_staging",
    checks,verifiedChecks:checks.length,port,oauthTokenImported:false,
    productionCutover:false,publicIngress:false},null,2));
}catch(e){console.error("R2_OAUTH_STAGE_ERROR "+String(e)+" "+log);process.exitCode=1}
finally{
  await stopIngress().catch(e=>{console.error(String(e));process.exitCode=1});
  await stop().catch(e=>{console.error(String(e));process.exitCode=1});
}
