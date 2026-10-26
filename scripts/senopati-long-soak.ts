/**
 * Read-only shared Senopati stability telemetry, bounded at up to six hours.
 *
 * bun scripts/senopati-long-soak.ts --seconds 3600 --interval-ms 1000
 * bun scripts/senopati-long-soak.ts --seconds 21600 --interval-ms 2000
 *
 * Uses synthetic classification text only. Never changes configuration,
 * owns a process, restarts a service, logs user prompts or sends alerts.
 * Keeps the live CLI, T-Line, MCP and tunnel completely untouched.
 */
import {getModernPolicy} from "../src/core/senopatiModernBert.js";
import {readSenopatiWatchdogStatus} from "../src/core/senopatiWatchdogStatus.js";
import {requestSharedSenopatiPrediction,sharedSenopatiStatus}
  from "../src/core/senopatiSharedClient.js";

function flag(name:string,fallback:number,minimum:number,maximum:number):number{
  const i=process.argv.indexOf(name);
  if(i<0)return fallback;
  const v=Number(process.argv[i+1]);
  if(!Number.isSafeInteger(v)||v<minimum||v>maximum)
    throw new Error(name+" requires an integer between "+minimum+" and "+maximum);
  return v;
}
const seconds=flag("--seconds",60,15,21600);
const intervalMs=flag("--interval-ms",1000,250,10000);
const inferenceEvery=flag("--inference-every",5,1,100);
const policy=getModernPolicy();
if(!policy.enabled || policy.backend!=="mmbert-v64-seed73" ||
  policy.inferenceMode!=="shared_only")
  throw new Error("Requires the guarded shared-only Senopati policy");
const start=performance.now(),deadline=start+seconds*1000;
let samples=0,healthy=0,unhealthy=0,predictions=0,predictionFailures=0;
let watchdogChanges=0,modelChanges=0,previousWatch:number|null=null;
let previousModel:number|null=null,lastReport=0,unhealthyStreak=0,maxUnhealthyStreak=0;
const memory:number[]=[],latencies:number[]=[];
let heartbeatFailures=0,precisionFailures=0,ownershipFailures=0;
let earlyStop=false;
process.once("SIGINT",()=>{earlyStop=true;});
process.once("SIGTERM",()=>{earlyStop=true;});
while(!earlyStop && performance.now()<deadline){
  const watch=readSenopatiWatchdogStatus();
  const model=await sharedSenopatiStatus();
  samples++;
  if(watch?.pid && previousWatch!==null && previousWatch!==watch.pid)watchdogChanges++;
  if(model?.pid && previousModel!==null && previousModel!==model.pid)modelChanges++;
  if(watch?.pid)previousWatch=watch.pid;
  if(model?.pid)previousModel=model.pid;
  const heartbeat=Boolean(watch?.alive && watch.heartbeatFresh && watch.healthy);
  const precision=Boolean(watch?.configuredPrecision===policy.precision &&
    model?.precision===policy.precision && model?.tokenizerEngine==="rust-native");
  const identity=Boolean(model && watch?.modelPid===model.pid);
  if(!heartbeat)heartbeatFailures++;
  if(!precision)precisionFailures++;
  if(!identity)ownershipFailures++;
  if(heartbeat && precision && identity){
    healthy++;
    unhealthyStreak=0;
    memory.push(model!.rssMiB);
    if(samples===1 || samples%inferenceEvery===0){
      const t=performance.now();
      const result=await requestSharedSenopatiPrediction(
        "Tolong cari dokumentasi proyek untuk uji status "+samples,
        policy.precision);
      latencies.push(performance.now()-t);
      predictions++;
      if(!result || result.intent!=="retrieve" ||
          result.modelName!=="mmbert-v64-seed73-hard")predictionFailures++;
    }
  }else{
    unhealthy++;
    unhealthyStreak++;
    maxUnhealthyStreak=Math.max(maxUnhealthyStreak,unhealthyStreak);
  }
  if(performance.now()-lastReport>=60_000 && seconds>=120){
    lastReport=performance.now();
    console.log("SENOPATI_LONG_SOAK_PROGRESS",JSON.stringify({
      elapsedSeconds:Math.round((performance.now()-start)/1000),
      samples,healthy,unhealthy,predictionFailures,
    }));
  }
  const remaining=deadline-performance.now();
  if(remaining>0 && !earlyStop)
    await Bun.sleep(Math.min(intervalMs,remaining));
}
latencies.sort((a,b)=>a-b);
const p=(q:number)=>latencies.length?
  Math.round(latencies[Math.max(0,Math.ceil(q*latencies.length)-1)]):null;
const elapsedMs=Math.round(performance.now()-start);
const pct=(n:number,d:number)=>d?Math.round(n/d*10000)/100:0;
const memoryDelta=memory.length>1?memory[memory.length-1]-memory[0]:null;
const result={
  elapsedSeconds:Math.round(elapsedMs/1000),requestedSeconds:seconds,
  samples,healthy,unhealthy,healthyPct:pct(healthy,samples),
  heartbeatFailures,precisionFailures,ownershipFailures,
  modelChanges,watchdogChanges,maxUnhealthyStreak,
  predictions,predictionFailures,inferenceSuccessPct:pct(predictions-predictionFailures,predictions),
  latencyP50Ms:p(.5),latencyP95Ms:p(.95),latencyP99Ms:p(.99),
  rssMinMiB:memory.length?Math.min(...memory):null,
  rssMaxMiB:memory.length?Math.max(...memory):null,
  rssDeltaMiB:memoryDelta,
  rssTrendMiBPerHour:elapsedMs>=600_000 && memoryDelta!==null?
    Math.round(memoryDelta/(elapsedMs/3600000)*10)/10:null,
  interruption:earlyStop,sharedPrecision:policy.precision,
  productionSloCertified:false,externalProcessesModified:false,
};
console.log("SENOPATI_LONG_SOAK_RESULT",JSON.stringify(result));
if(earlyStop || !samples || healthy/samples<.99 || predictionFailures)
  process.exitCode=1;
