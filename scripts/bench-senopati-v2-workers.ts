/**
 * Concurrent worker-thread load test, explicitly run by CLI only.
 * Measures load/worker overhead and wall-clock throughput, not production SLA.
 * Raw prompts stay in memory and no input text is written to reports.
 */
import fs from "node:fs";
import path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { loadShadowRegistry } from "../src/core/senopatiV2CandidateRegistry.js";
import { assessSelectiveShadow } from "../src/core/senopatiV2SelectiveDecision.js";

interface Setup {
  registry:string; dataset:string; engine:"reference"|"indexed"|"compact"; iterations:number; workerId:number;
}
interface Result {
  workerId:number;processed:number;totalMs:number;loadMs:number;
  abstained:number;badDecisions:number;heapUsedBytes:number;
  externalBytes:number;arrayBuffersBytes:number;
}
async function workerMain(input:Setup) {
  const loadStart=performance.now();
  const {model,policy}=loadShadowRegistry(input.registry,input.engine);
  const loadMs=performance.now()-loadStart;
  const dataset=fs.readFileSync(input.dataset,"utf8").split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s));
  if(dataset.length<50||dataset.length>10000)throw new Error("Dataset size outside 50–10k");
  for(const r of dataset)if(typeof r.text!=="string"||typeof r.context!=="string")
    throw new Error("Invalid benchmark prompt");
  let processed=0,abstained=0,badDecisions=0;
  const begin=performance.now();
  for(let iter=0;iter<input.iterations;iter++){
    for(const row of dataset){
      const decision=assessSelectiveShadow(model.predictGuarded(row.text,row.context),policy);
      processed++;
      if(decision.abstain)abstained++;
      if(decision.authorizesExecution!==false||decision.eligibleForAutomaticToolRouting!==false
         ||decision.heads.risk.advisoryAccept||decision.heads.approval.advisoryAccept)badDecisions++;
    }
  }
  const result:Result={
    workerId:input.workerId,processed,totalMs:performance.now()-begin,loadMs,
    abstained,badDecisions,heapUsedBytes:process.memoryUsage().heapUsed,
    externalBytes:process.memoryUsage().external,
    arrayBuffersBytes:process.memoryUsage().arrayBuffers
  };
  parentPort?.postMessage(result);
}
if (!isMainThread){
  workerMain(workerData as Setup).catch(e=>{
    parentPort?.postMessage({error:String(e)});
    process.exitCode=1;
  });
}else{
  const args=process.argv.slice(2);
  const arg=(name:string,def?:string)=>{
    const i=args.indexOf(name);
    if(i<0){if(def!==undefined)return def;throw new Error("Missing "+name);}
    if(!args[i+1])throw new Error("Missing value "+name);
    return args[i+1];
  };
  const registry=arg("--registry"), dataset=arg("--dataset"),
    engine=arg("--engine","indexed") as "reference"|"indexed"|"compact",
    workers=Number(arg("--workers","2")),iterations=Number(arg("--iterations","4")),
    output=arg("--out","");
  if(!["reference","indexed","compact"].includes(engine)||!Number.isInteger(workers)||workers<1||workers>8||
     !Number.isInteger(iterations)||iterations<1||iterations>100)
    throw new Error("Invalid bounded engine/workers/iterations");
  // Verify candidate hashes and safety profile before spawning workers.
  loadShadowRegistry(registry,engine);
  const start=performance.now();
  const tasks=Array.from({length:workers},(_,workerId)=>new Promise<Result>((resolve,reject)=>{
    const thread=new Worker(new URL(import.meta.url),{workerData:{registry,dataset,engine,iterations,workerId} satisfies Setup});
    let settled=false;
    thread.on("message",(msg:Result|{error:string})=>{
      if("error" in msg){settled=true;reject(new Error(msg.error));thread.terminate();}
      else {settled=true;resolve(msg);}
    });
    thread.on("error",e=>{settled=true;reject(e);});
    thread.on("exit",code=>{
      if(!settled)reject(new Error("Worker exited before providing benchmark result (exit "+code+")"));
    });
  }));
  const details=await Promise.all(tasks);
  const wallClockMs=performance.now()-start;
  let processed=0,abstained=0,badDecisions=0;
  for(const info of details){
    processed+=info.processed;abstained+=info.abstained;badDecisions+=info.badDecisions;
  }
  if(badDecisions!==0||abstained!==processed)
    throw new Error("Non-abstaining/unsafe decision in concurrent shadow benchmark");
  const result={
    schema:1,status:"SHADOW_WORKER_BENCHMARK_ONLY",engine,workers,iterations,
    processed,abstained,unsafe:badDecisions,
    wallClockMs,throughputPerSec:1000*processed/wallClockMs,
    workersInfo:details.map(x=>({
      workerId:x.workerId,processed:x.processed,computeMs:x.totalMs,
      loadMs:x.loadMs,heapUsedBytes:x.heapUsedBytes,
      externalBytes:x.externalBytes,arrayBuffersBytes:x.arrayBuffersBytes
    })),
    releaseAuthorized:false,eligibleForAutomaticToolRouting:false,
    accuracyCertified:false,independentBlindEvidence:false,
    note:"Experimental worker-thread throughput includes startup and IPC. Not a production SLA."
  };
  console.log(JSON.stringify(result,null,2));
  if(output){
    const dest=path.resolve(output),root=path.resolve("build","superagent","benchmarks")+path.sep;
    if(!dest.startsWith(root)||!dest.endsWith(".json"))
      throw new Error("Benchmark output restricted to ignored build/superagent/benchmarks/*.json");
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.writeFileSync(dest,JSON.stringify(result,null,2)+"\n");
  }
}
