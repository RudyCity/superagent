/**
 * Real, isolated Bun server + T-Line backend compatibility smoke.
 * Never uses 7888, 7891 or the running model's config profile. The only child
 * process belongs to this test and is terminated in finally.
 * Usage: bun scripts/senopati-tline-staging-smoke.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import {pathToFileURL} from "node:url";

if (!process.versions.bun) throw new Error("Requires Bun");
const root=path.resolve(import.meta.dir,"..");
const probePath=path.resolve(root,"..","t-line","backend","src","superAgentPortProbe.ts");
await fs.access(probePath);
const {probeSuperAgentPort}=await import(pathToFileURL(probePath).href);
const staging=await fs.mkdtemp(path.join(os.tmpdir(),"sa-senopati-v70-staging-"));
const config=path.join(staging,"profile");
const port=await new Promise<number>((resolve,reject)=>{
  const owner=net.createServer();
  owner.once("error",reject);
  owner.listen(0,"127.0.0.1",()=>{
    const p=(owner.address() as net.AddressInfo).port;
    owner.close(()=>resolve(p));
  });
});
const useBuilt=process.argv.includes("--dist");
const entry=useBuilt?path.join(root,"dist","cli.js"):path.join(root,"src","cli.tsx");
await fs.access(entry);
const child=Bun.spawn([process.execPath,entry,
  "--server",String(port),"--client-mode","tline"],{
  cwd:root,
  env:{...process.env,SUPERAGENT_CONFIG_DIR:config,HOME:staging,USERPROFILE:staging,
    SUPERAGENT_SENOPATI_AUTOSTART:"0",SUPERAGENT_SERVER_PORT:String(port)},
  stdout:"pipe",stderr:"pipe",
});
let diagnostic="";
const consume=async(stream:ReadableStream<Uint8Array>|number|null|undefined)=>{
  if(!stream || typeof stream==="number")return;
  try{
    for await (const data of stream as ReadableStream<Uint8Array>){
      diagnostic=(diagnostic+new TextDecoder().decode(data)).slice(-1500);
    }
  }catch{/* process exited */}
};
void consume(child.stdout);void consume(child.stderr);
try{
  let token:string|undefined;
  for(let attempt=0;attempt<80;attempt++){
    if(child.exitCode!==null)break;
    try{
      const info=JSON.parse(await fs.readFile(
        path.join(config,"server-info-"+port+".json"),"utf8"));
      if(info.port===port && typeof info.authToken==="string" &&
        /^[a-f0-9]{48}$/i.test(info.authToken)){token=info.authToken;break;}
    }catch{/* startup not yet complete */}
    await Bun.sleep(150);
  }
  if(!token)throw new Error("Staging server failed to start: "+diagnostic);
  const endpoint="http://127.0.0.1:"+port+"/api/status";
  const noAuth=await fetch(endpoint,{signal:AbortSignal.timeout(2000)});
  const wrongAuth=await fetch(endpoint,{headers:{Authorization:"Bearer bad"},
    signal:AbortSignal.timeout(2000)});
  if(noAuth.status!==401 || wrongAuth.status!==401)
    throw new Error("Status route authentication boundary failed");
  const ok=await fetch(endpoint,{
    headers:{Authorization:"Bearer "+token,"x-client-mode":"tline"},
    signal:AbortSignal.timeout(3000),
  });
  if(ok.status!==200)throw new Error("Authenticated status denied: "+ok.status);
  const json=await ok.json() as Record<string,any>;
  const model=json.senopatiInference;
  if(json.status!=="online" || json.clientMode!=="tline" ||
      !model || !["degraded","disabled"].includes(model.phase) ||
      model.fallback!=="legacy-active" ||
      model.automaticChatReplayAllowed!==false ||
      model.toolAuthorizationFromModel!==false)
    throw new Error("Unexpected isolated T-Line model fallback contract");
  const accepted=await probeSuperAgentPort(port,{Authorization:"Bearer "+token});
  const denied=await probeSuperAgentPort(port,{Authorization:"Bearer invalid"});
  const absent=await probeSuperAgentPort(port,{});
  if(accepted!=="compatible" || denied!=="occupied" || absent!=="occupied")
    throw new Error("T-Line backend compatibility probe regression");
  // No model registry can be created in this profile by a status-only query.
  const ipc=path.join(config,"ipc");
  const ipcFiles=await fs.readdir(ipc).catch(()=>[] as string[]);
  if(ipcFiles.some(x=>x.startsWith("senopati-")))
    throw new Error("Staging unexpectedly allocated a shared model instance");
  if(diagnostic.includes(token))throw new Error("Bearer leaked in startup log");
  console.log("SENOPATI_TLINE_STAGING_PASS",JSON.stringify({
    isolatedPort:true,statusAuth:[noAuth.status,wrongAuth.status,ok.status],
    buildEntry:useBuilt?"compiled":"source",tlineCompatibility:"compatible",
    modelPhase:model.phase,fallback:model.fallback,
    chatReplayAllowed:false,modelAllocated:false,externalProcessesTouched:false,
  }));
}finally{
  try{child.kill();}catch{}
  await Promise.race([child.exited,Bun.sleep(2000)]);
  await fs.rm(staging,{recursive:true,force:true,maxRetries:3,retryDelay:150});
}
