/**
 * Owner-scoped local-only MCP host. Independent of the Core HTTP PID.
 * Launch: bun scripts/mcp-dedicated-local.ts start
 * Inspect: bun scripts/mcp-dedicated-local.ts status
 * Stop: bun scripts/mcp-dedicated-local.ts stop
 *
 * It does not start a Cloudflare tunnel, adopt existing OAuth sessions, alter
 * public endpoints, terminate Core or send external notifications. Separate
 * OAuth/Cloudflare onboarding is required before a production MCP cutover.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {spawn} from "node:child_process";


const PORT=6790;
const ROOT=path.join(os.homedir(),".superagent-r","mcp-dedicated-local-6790");
const OWNER=path.join(ROOT,"owner.json");
const STOP=path.join(ROOT,"stop.json");
const TOKEN=path.join(ROOT,"bearer.json");
const ownScript=path.resolve(import.meta.filename);
type Owner={version:1;pid:number;nonce:string;port:number;heartbeatAt:number;mode:"local-static-bearer-safe"};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function atomic(file:string,data:unknown):void{
 const tmp=file+"."+process.pid+"."+crypto.randomUUID()+".tmp";
 try{
  fs.writeFileSync(tmp,JSON.stringify(data)+"\n",{mode:0o600,flag:"wx"});
  fs.renameSync(tmp,file);
 }finally{try{fs.rmSync(tmp,{force:true});}catch{}}
}
function readOwner():Owner|null{
 try{
  const stat=fs.lstatSync(OWNER);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>4096)return null;
  const v=JSON.parse(fs.readFileSync(OWNER,"utf8"));
  if(v.version!==1||v.port!==PORT||!Number.isSafeInteger(v.pid)||v.pid<1||
      !/^[a-f0-9]{32}$/.test(v.nonce)||v.mode!=="local-static-bearer-safe"||
      !Number.isFinite(v.heartbeatAt))return null;
  return v;
 }catch{return null;}
}
function pidAlive(pid:number):boolean{
 try{process.kill(pid,0);return true;}catch(e:any){return e?.code==="EPERM";}
}
async function serve():Promise<void>{
 fs.mkdirSync(ROOT,{recursive:true,mode:0o700});
 if(fs.existsSync(OWNER))throw Error("Existing or damaged owner record; refuse implicit adoption");
 if(fs.existsSync(STOP))throw Error("Existing stop request; operator review required");
 const owner:Owner={version:1,pid:process.pid,nonce:crypto.randomBytes(16).toString("hex"),
  port:PORT,heartbeatAt:Date.now(),mode:"local-static-bearer-safe"};
 const {startMcpHttpServer,generateMcpBearerToken}=await import("../src/core/mcp/mcpHttpTransport.js");
 const bearer=generateMcpBearerToken();
 const handle=await startMcpHttpServer({
  port:PORT,bearerToken:bearer,allowDangerous:false,
  toolExposure:"gateway",authMode:"static-bearer",
  auditLogPath:path.join(ROOT,"audit.log"),
  hostOriginPolicy:{allowNoOrigin:true,allowedHosts:["127.0.0.1","localhost"]},
 });
 try{
  // Keep bearer separate from public status; strict per-user local file only.
  // This process does not configure external clients or echo the capability.
  // Native OAuth session handover cannot be inferred from this static token.
  atomic(TOKEN,{port:PORT,bearerToken:bearer,mode:"local-only"});
  fs.writeFileSync(OWNER,JSON.stringify(owner)+"\n",{mode:0o600,flag:"wx"});
  let ending=false;
  process.once("SIGINT",()=>{ending=true;});
  process.once("SIGTERM",()=>{ending=true;});
  while(!ending){
   await sleep(1000);
   try{
    const entry=JSON.parse(fs.readFileSync(STOP,"utf8"));
    if(entry.pid===owner.pid && entry.nonce===owner.nonce){
      ending=true;
      break;
    }
   }catch{}
   const current=readOwner();
   if(!current||current.nonce!==owner.nonce||current.pid!==process.pid){
     throw Error("MCP owner registry changed; fail closed");
   }
   owner.heartbeatAt=Date.now();
   atomic(OWNER,owner);
  }
 }finally{
  await handle.close();
  if(readOwner()?.nonce===owner.nonce){
   fs.rmSync(OWNER,{force:true});
   fs.rmSync(TOKEN,{force:true});
  }
  try{
   const stop=JSON.parse(fs.readFileSync(STOP,"utf8"));
   if(stop.nonce===owner.nonce)fs.rmSync(STOP,{force:true});
  }catch{}
 }
}
async function main(){
 const action=process.argv[2]??"status";
 if(action==="serve"){await serve();return;}
 if(action==="status"){
  const owner=readOwner();
  const alive=Boolean(owner && pidAlive(owner.pid));
  console.log(JSON.stringify({port:PORT,ownerPid:owner?.pid??null,
    heartbeatFresh:alive&&Date.now()-owner!.heartbeatAt<5000,
    ownerOnline:alive&&Date.now()-owner!.heartbeatAt<5000,
    localOnly:true,credentialMode:"private-static-bearer",
    cloudflareTunnelStarted:false,oauthSessionMigration:false},null,2));return;
 }
 if(action==="start"){
  if(fs.existsSync(OWNER)||fs.existsSync(STOP))
   throw Error("MCP dedicated owner data exists; refuse duplicate or unsafe overwrite");
  fs.mkdirSync(ROOT,{recursive:true,mode:0o700});
  const child=spawn(process.execPath,[ownScript,"serve"],{
   cwd:process.cwd(),detached:true,windowsHide:true,stdio:"ignore",
   env:{...process.env,SUPERAGENT_SENOPATI_AUTOSTART:"0"},
  });
  child.unref();
  for(let i=0;i<30;i++){
   await sleep(250);
   const o=readOwner();
   if(o?.pid===child.pid && pidAlive(o.pid)){
     console.log(JSON.stringify({status:"local_mcp_started",pid:o.pid,port:PORT,
       coreUnaffected:true,externalTunnelUnaffected:true}));return;
   }
  }
  throw Error("Dedicated local MCP host did not become healthy; inspect only");
 }
 if(action==="stop"){
  const o=readOwner();
  if(!o||!pidAlive(o.pid))throw Error("No verified live owner; do not signal unknown PID");
  atomic(STOP,{pid:o.pid,nonce:o.nonce});
  for(let i=0;i<24;i++){
   await sleep(250);
   if(!fs.existsSync(OWNER)){
    console.log(JSON.stringify({status:"owner_gracefully_stopped",port:PORT}));return;
   }
  }
  throw Error("Owner did not acknowledge stop; operator review, no process kill");
 }
 throw Error("Usage: start | status | stop");
}
await main();
