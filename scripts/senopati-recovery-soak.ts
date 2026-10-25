/** Bounded, read-only Senopati operational soak/acceptance.
 * Usage: bun scripts/senopati-recovery-soak.ts [samples=12] [intervalMs=1000]
 * No model lifecycle commands, subprocess spawning, file writes or network providers.
 * Uses the existing private IPC plus a synthetic retrieve request; never logs text.
 */
import {getModernPolicy} from "../src/core/senopatiModernBert.js";
import {sharedSenopatiStatus,requestSharedSenopatiPrediction}
  from "../src/core/senopatiSharedClient.js";
import {readSenopatiWatchdogStatus}
  from "../src/core/senopatiWatchdogStatus.js";

function boundedInt(arg:string|undefined,fallback:number,min:number,max:number):number{
  if(arg===undefined)return fallback;
  const num=Number(arg);
  if(!Number.isSafeInteger(num)||num<min||num>max)
    throw new Error(`Invalid parameter: expected integer ${min}..${max}`);
  return num;
}
const samples=boundedInt(process.argv[2],12,2,120);
const intervalMs=boundedInt(process.argv[3],1000,250,10000);
const policy=getModernPolicy();
if(!policy.enabled || policy.backend!=="mmbert-v64-seed73" ||
   policy.inferenceMode!=="shared_only"){
  throw new Error("Soak requires enabled guarded shared-only Senopati");
}
const start=Date.now();
let baselineModel:number|null=null;
let baselineWatch:number|null=null;
const rss:number[]=[];
let checked=0;
let inferences=0;
for(let i=0;i<samples;i++){
  const [health,watch]=await Promise.all([
    sharedSenopatiStatus(),Promise.resolve(readSenopatiWatchdogStatus()),
  ]);
  if(!health || !watch?.alive || !watch.heartbeatFresh || !watch.healthy ||
     watch.modelPid!==health.pid || health.precision!==policy.precision ||
     health.tokenizerEngine!=="rust-native"){
    throw new Error(`Senopati soak failed health/ownership at sample ${i+1}`);
  }
  if(baselineModel===null){baselineModel=health.pid;baselineWatch=watch.pid;}
  if(health.pid!==baselineModel || watch.pid!==baselineWatch){
    throw new Error(`Senopati soak detected unexpected process turnover at sample ${i+1}`);
  }
  rss.push(health.rssMiB);
  checked++;
  if(i===0 || i===samples-1 || i%4===0){
    const result=await requestSharedSenopatiPrediction(
      "Tolong cari dokumentasi proyek",policy.precision);
    if(result?.intent!=="retrieve" || result.modelName!=="mmbert-v64-seed73-hard"){
      throw new Error(`Senopati soak synthetic retrieve failed at sample ${i+1}`);
    }
    inferences++;
  }
  if(i<samples-1)await new Promise(resolve=>setTimeout(resolve,intervalMs));
}
const summary={
  samples:checked,intervalMs,elapsedMs:Date.now()-start,
  watchdogPid:baselineWatch,modelPid:baselineModel,
  precision:policy.precision,tokenizerEngine:"rust-native",
  syntheticInferencesPassed:inferences,
  rssMinMiB:Math.min(...rss),rssMaxMiB:Math.max(...rss),
  rssDeltaMiB:rss[rss.length-1]-rss[0],
  noProcessStoppedOrStartedByProbe:true,
};
console.log("SENOPATI_READONLY_SOAK_PASS",JSON.stringify(summary));
