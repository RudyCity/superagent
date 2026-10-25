/** Operate one shared local Senopati ONNX instance without restarting agents.
 *
 * Commands:
 *   bun scripts/senopati-shared.ts start | status | enable | disable | stop
 *   bun scripts/senopati-shared.ts serve   (foreground, internal)
 *
 * No public listener. No arbitrary tool/command RPC. Requests contain only
 * text for classification; the IPC service never records request text.
 */
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  getModernPolicy,setModernPolicy,validateModernPolicy,
  inferModernPrediction,inferModernPredictionLocal,modernRuntimeStatus,
} from "../src/core/senopatiModernBert.js";
import {
  sharedSenopatiStatus,requestSharedSenopatiPrediction,
  stopSharedSenopati,
} from "../src/core/senopatiSharedClient.js";
import {serveSenopatiShared} from "../src/core/senopatiSharedServer.js";

const action=process.argv[2] || "status";
const allowed=new Set(["start","serve","status","stop","enable","disable"]);
if(!allowed.has(action)){
  throw new Error("Expected start | status | enable | disable | stop");
}
if(action==="serve"){
  const policy=getModernPolicy();
  if(!policy.enabled)throw new Error("Activate guarded Senopati before starting service");
  const probe=await inferModernPredictionLocal("Tolong cari dokumentasi proyek");
  if(!probe)throw new Error("Cannot initialize local model for shared server");
  const service=await serveSenopatiShared(
    async(text,precision)=>{
      const policyNow=getModernPolicy();
      if(!policyNow.enabled || policyNow.precision!==precision)return null;
      return inferModernPredictionLocal(text);
    },
    ()=>({
      precision:getModernPolicy().precision,
      tokenizerEngine:modernRuntimeStatus().tokenizerEngine || "unknown",
    }),
  );
  console.log("SHARED_SENOPATI_READY",JSON.stringify({
    pid:service.pid,
    transport:"local-ipc",
    precision:policy.precision,
    tokenizerEngine:modernRuntimeStatus().tokenizerEngine,
  }));
  const close=()=>{
    void service.stop().then(()=>process.exit(0));
  };
  process.once("SIGINT",close);
  process.once("SIGTERM",close);
}else if(action==="status"){
  const state=await sharedSenopatiStatus();
  console.log(JSON.stringify({
    sharedService:state || "offline",
    localPolicy:getModernPolicy(),
    note:"model inference only; tool authorization remains independent",
  },null,2));
}else if(action==="start"){
  const already=await sharedSenopatiStatus();
  if(already){
    console.log("SHARED_SENOPATI_ALREADY_RUNNING",JSON.stringify(already));
  }else{
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),"serve"],{
      cwd:process.cwd(),detached:true,stdio:"ignore",windowsHide:true,
      env:process.env,
    });
    child.unref();
    let active=null;
    for(let attempt=0;attempt<70;attempt++){
      await new Promise(resolve=>setTimeout(resolve,250));
      active=await sharedSenopatiStatus();
      if(active)break;
    }
    if(!active)throw new Error("Shared model process did not become healthy; no policy was changed");
    console.log("SHARED_SENOPATI_STARTED",JSON.stringify(active));
  }
}else if(action==="stop"){
  const answer=await stopSharedSenopati();
  console.log(JSON.stringify({
    stopped:answer,
    note:"other active SuperAgent agents/tunnels were not stopped",
  }));
  if(!answer)process.exitCode=1;
}else if(action==="disable"){
  const old=getModernPolicy();
  const next=validateModernPolicy({...old,inferenceMode:"local"});
  setModernPolicy(next);
  console.log("SHARED_SENOPATI_DISABLED",JSON.stringify(next));
}else if(action==="enable"){
  const previous=getModernPolicy();
  const service=await sharedSenopatiStatus();
  if(!service || service.precision!==previous.precision){
    throw new Error("Shared model must be healthy with matching precision first");
  }
  const target=validateModernPolicy({...previous,inferenceMode:"shared_only"});
  setModernPolicy(target);
  try {
    const result=await inferModernPrediction("Tolong cari dokumentasi proyek");
    if(!result || result.intent!=="retrieve" ||
       result.modelName!=="mmbert-v64-seed73-hard") {
      throw new Error("Shared inference smoke did not match the guarded model");
    }
    console.log("SHARED_SENOPATI_ENABLED",JSON.stringify({
      policy:target,serverPid:service.pid,
      intent:result.intent,
      note:"no local mmBERT loaded by requesting CLI processes",
    }));
  } catch(error) {
    setModernPolicy(previous);
    throw error;
  }
}
