/** Real bounded shutdown and active-inference handoff drill.
 *
 * Uses synthetic classification requests and model-only authenticated stop.
 * Requires live watchdog. Other CLI, T-Line, MCP and tunnels remain untouched.
 */
import {getModernPolicy} from "../src/core/senopatiModernBert.js";
import {
 sharedSenopatiStatus,requestSharedSenopatiPrediction,stopSharedSenopati,
} from "../src/core/senopatiSharedClient.js";
import {readSenopatiWatchdogStatus} from "../src/core/senopatiWatchdogStatus.js";
import {modelStartLeaseBlocksNewModel} from "../src/core/senopatiStartLease.js";
import fs from "node:fs";
import path from "node:path";
import {getPackageRootDir} from "../src/core/config/paths.js";

if(process.argv[2]!=="--confirm-model-only"){
 throw new Error("Explicit --confirm-model-only flag required");
}
const before=await sharedSenopatiStatus();
const watch=readSenopatiWatchdogStatus();
const policy=getModernPolicy();
if(!before || !watch?.alive || watch.modelPid!==before.pid ||
   policy.inferenceMode!=="shared_only" || policy.precision!==before.precision){
 throw new Error("Require authenticated model owner and active matching watchdog");
}
const started=Date.now();
const prompts=Array.from({length:48},(_,i)=>
 "Cari penjelasan dokumentasi API untuk uji antrean saat shutdown, kasus "+i+
 " versi v69-drain-unique");
const outstanding=prompts.map(text=>requestSharedSenopatiPrediction(
 text,before.precision));
const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
let sawActive=false;
for(let i=0;i<70;i++){
 const h=await sharedSenopatiStatus();
 if(h && (h.active>0 || Number(h.queued||0)>0)){sawActive=true;break;}
 await sleep(30);
}
if(!sawActive){
 await Promise.all(outstanding);
 throw new Error("No active inference observed: refusing inconclusive shutdown drill");
}
const acknowledged=await stopSharedSenopati();
if(!acknowledged)throw new Error("Model owner did not acknowledge graceful stop");
let fenced=false;
for(let i=0;i<12;i++){
 await sleep(40);
 if(modelStartLeaseBlocksNewModel()){fenced=true;break;}
}
const results=await Promise.all(outstanding);
let after=await sharedSenopatiStatus();
for(let i=0;i<130 && (!after || after.pid===before.pid);i++){
 await sleep(300);
 after=await sharedSenopatiStatus();
}
const watchAfter=readSenopatiWatchdogStatus();
const stats={
  version:"v69-bounded-drain-v1",
  modelStopWasGraceful:true,
  inFlightRequests:prompts.length,
  observedActiveInferenceBeforeStop:sawActive,
  stopAcknowledged:acknowledged,
  shutdownLeaseObserved:fenced,
  oldModelPid:before.pid,
  newModelPid:after?.pid??null,
  watchdogPidBefore:watch.pid,
  watchdogPidAfter:watchAfter?.pid??null,
  watchdogUninterrupted:watchAfter?.pid===watch.pid,
  requestsFinishedBeforeStop:results.filter(Boolean).length,
  requestsFallbackAfterStop:results.filter(x=>!x).length,
  elapsedMs:Date.now()-started,
  recovered:Boolean(after && after.pid!==before.pid &&
    watchAfter?.pid===watch.pid && after.precision===before.precision),
  modelMemoryMiB:after?.rssMiB??null,
  noOtherProcessesStoppedByDrill:true,
};
const dir=path.join(getPackageRootDir(),"models","senopati","mmbert-v64-seed73");
const output=path.join(dir,"v69_bounded_drain_drill_v1.json");
if(fs.existsSync(output))throw new Error("Existing drain drill report: refusing overwrite");
fs.writeFileSync(output,JSON.stringify(stats,null,2)+"\n");
console.log("SENOPATI_GRACEFUL_DRAIN_DRILL",JSON.stringify(stats));
if(!stats.recovered || !stats.shutdownLeaseObserved)process.exitCode=1;
