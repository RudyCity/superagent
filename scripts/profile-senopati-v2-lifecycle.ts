/**
 * Cold-start and memory lifecycle profiling for opt-in Senopati V2 shadow engines.
 * Each trial runs in an isolated Bun child process, so memory and load times
 * don't include a reference model held in the same JS heap.
 * NEVER routes tools; all output is aggregate metrics, no prompt text.
 *
 * bun scripts/profile-senopati-v2-lifecycle.ts --registry FILE --dataset JSONL
 *   [--runs 3] [--iterations 8] [--gc] [--out build/superagent/benchmarks/file.json]
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { loadShadowRegistry } from "../src/core/senopatiV2CandidateRegistry.js";
import { assessSelectiveShadow } from "../src/core/senopatiV2SelectiveDecision.js";

type Engine = "reference" | "indexed" | "compact";
const ENGINES: Engine[] = ["reference","indexed","compact"];
function getArg(name:string, fallback?:string):string {
  const i=process.argv.indexOf(name);
  if(i<0){
    if(fallback!==undefined)return fallback;
    throw new Error("Missing required "+name);
  }
  if(!process.argv[i+1])throw new Error("Missing argument "+name);
  return process.argv[i+1];
}
function boundedInt(value:string,min:number,max:number,name:string){
  const n=Number(value);
  if(!Number.isInteger(n)||n<min||n>max)throw new Error("Invalid "+name);
  return n;
}
function snapshot(){
  const memory=process.memoryUsage();
  return {
    rssBytes:memory.rss,heapUsedBytes:memory.heapUsed,
    externalBytes:memory.external,arrayBuffersBytes:memory.arrayBuffers,
  };
}
function markPhase(name:string){
  return {name,...snapshot()};
}
async function child(){
  const engine=getArg("--engine") as Engine;
  if(!ENGINES.includes(engine))throw new Error("Unknown shadow engine");
  const registry=getArg("--registry"), dataset=getArg("--dataset");
  const iterations=boundedInt(getArg("--iterations"),1,100,"iterations");
  const doGc=process.argv.includes("--gc");
  const heterogeneous=process.argv.includes("--heterogeneous");
  const before=markPhase("before_load");
  const started=performance.now();
  const {model,policy}=loadShadowRegistry(registry,engine);
  const loadMs=performance.now()-started;
  const afterLoad=markPhase("after_load");
  const dataStat=fs.statSync(dataset);
  if(!dataStat.isFile()||dataStat.size>5*1024*1024)throw new Error("Unbounded benchmark dataset");
  const rows=fs.readFileSync(dataset,"utf8").split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));
  if(rows.length<50||rows.length>10_000)throw new Error("Unsupported dataset size");
  for(const row of rows)if(typeof row.text!=="string"||typeof row.context!=="string"){
    throw new Error("Malformed benchmark text/context");
  }
  // Deterministic perturbations strictly for the performance profiler.
  // This never produces training labels or a benchmark accuracy estimate.
  const inputs=heterogeneous ? rows.map((r,i)=>{
    const text=i%5===0?r.text.toUpperCase():
      i%5===1?"  "+r.text+" ? ":
      i%5===2?"🌍 "+r.text+" — cek ulang":
      i%5===3?r.text+" ".repeat(6)+" please":
      r.text;
    return {text,context:i%7===0?"PLANNING_PENDING":r.context};
  }) : rows;
  const run=(row:{text:string,context:string})=>{
    const d=assessSelectiveShadow(model.predictGuarded(row.text,row.context),policy);
    if(d.authorizesExecution!==false||d.eligibleForAutomaticToolRouting!==false||
       d.heads.risk.advisoryAccept||d.heads.approval.advisoryAccept||!d.abstain){
      throw new Error("Unsafe non-abstaining shadow decision");
    }
  };
  for(const row of inputs.slice(0,Math.min(30,inputs.length)))run(row);
  const afterWarmup=markPhase("after_warmup");
  let processed=0;
  let maxSampledRss=0;
  const startedCompute=performance.now();
  for(let iter=0;iter<iterations;iter++){
    for(const row of inputs){
      run(row);
      processed++;
      if(processed%64===0){
        const rss=process.memoryUsage().rss;
        if(rss>maxSampledRss)maxSampledRss=rss;
      }
    }
  }
  const elapsedMs=performance.now()-startedCompute;
  const afterCompute=markPhase("after_compute");
  let gcMs:null|number=null;
  let afterExplicitGc:null|ReturnType<typeof markPhase>=null;
  if(doGc){
    const gcStart=performance.now();
    Bun.gc(true);
    gcMs=performance.now()-gcStart;
    afterExplicitGc=markPhase("after_explicit_gc");
  }
  const allPhases=[before,afterLoad,afterWarmup,afterCompute];
  if(afterExplicitGc)allPhases.push(afterExplicitGc);
  for(const p of allPhases)maxSampledRss=Math.max(maxSampledRss,p.rssBytes);
  const peakResource=process.resourceUsage().maxRSS;
  const result={
    engine,processed,heterogeneous,allAbstained:true,automaticRoutingEnabled:false,
    loadingMs:loadMs,computeMs:elapsedMs,throughputPerSec:processed/(elapsedMs/1000),
    resourceMaxRssRaw:peakResource,
    // Node/Bun process.resourceUsage reports maxRSS in KiB on this Win64 environment.
    // Preserve raw value for platform-specific interpretation.
    maxSampledRssBytes:maxSampledRss,
    phases:allPhases,
    explicitGcRequested:doGc,explicitGcMs:gcMs,
    releaseAuthorized:false,independentBlindEvidence:false,
  };
  console.log("PROFILE_JSON:"+JSON.stringify(result));
}
async function main(){
  const registry=getArg("--registry"),dataset=getArg("--dataset");
  const runs=boundedInt(getArg("--runs","3"),1,10,"runs");
  const iterations=boundedInt(getArg("--iterations","8"),1,100,"iterations");
  const doGc=process.argv.includes("--gc");
  const heterogeneous=process.argv.includes("--heterogeneous");
  const output=getArg("--out","");
  const reports:ReturnType<typeof JSON.parse>[]=[];
  // Round-robin engine ordering to reduce bias from background process load.
  for(let rep=0;rep<runs;rep++){
    const engines=[...ENGINES.slice(rep%3),...ENGINES.slice(0,rep%3)];
    for(const engine of engines){
      const args=[path.resolve(import.meta.path),
        "--child","--engine",engine,
        "--registry",registry,"--dataset",dataset,
        "--iterations",String(iterations)];
      if(doGc)args.push("--gc");
      if(heterogeneous)args.push("--heterogeneous");
      const result=spawnSync(process.execPath,args,{
        cwd:process.cwd(),encoding:"utf8",timeout:60000,maxBuffer:1024*1024,
        windowsHide:true,
      });
      if(result.error||result.status!==0){
        throw new Error("Isolated "+engine+" profile failed: "+String(result.error??result.stderr).slice(0,1000));
      }
      const line=result.stdout.split(/\r?\n/).find(x=>x.startsWith("PROFILE_JSON:"));
      if(!line)throw new Error("Missing isolated "+engine+" benchmark report");
      const item=JSON.parse(line.slice("PROFILE_JSON:".length));
      if(item.allAbstained!==true||item.releaseAuthorized!==false||item.engine!==engine)
        throw new Error("Unsafe/invalid isolated benchmark result");
      reports.push({...item,rep:rep+1});
    }
  }
  const summary=ENGINES.map(engine=>{
    const rows=reports.filter(r=>r.engine===engine);
    const sorted=rows.map(r=>r.loadingMs).sort((a,b)=>a-b);
    const byCompute=rows.map(r=>r.throughputPerSec).sort((a,b)=>a-b);
    const maxRss=rows.map(r=>r.maxSampledRssBytes).sort((a,b)=>a-b);
    const gcSamples=rows.filter(r=>typeof r.explicitGcMs==="number").map(r=>r.explicitGcMs).sort((a,b)=>a-b);
    const loadedHeap=rows.map(r=>r.phases.find((p:{name:string})=>p.name==="after_load").heapUsedBytes).sort((a,b)=>a-b);
    const afterGcHeap=rows.filter(r=>r.explicitGcRequested).map(r=>r.phases.find((p:{name:string})=>p.name==="after_explicit_gc").heapUsedBytes).sort((a,b)=>a-b);
    return {
      engine,runs:rows.length,
      medianLoadedHeapMiB:loadedHeap[Math.floor(loadedHeap.length/2)]/1048576,
      medianAfterGcHeapMiB:afterGcHeap.length?afterGcHeap[Math.floor(afterGcHeap.length/2)]/1048576:null,
      medianExplicitGcMs:gcSamples.length?gcSamples[Math.floor(gcSamples.length/2)]:null,
      medianLoadMs:sorted[Math.floor(sorted.length/2)],
      medianThroughputPerSec:byCompute[Math.floor(byCompute.length/2)],
      medianSampledRssMiB:maxRss[Math.floor(maxRss.length/2)]/1048576,
      maxSampledRssMiB:Math.max(...maxRss)/1048576,
      allAbstained:true
    };
  });
  const report={
    schema:1,status:"SHADOW_ISOLATED_LIFECYCLE_PROFILE",
    platform:process.platform,bunVersion:Bun.version,
    runs,iterations,explicitGc:doGc,heterogeneous,
    summary,trials:reports,
    modelProductionChanged:false,releaseAuthorized:false,
    independentAccuracyEvidence:false,
    note:"Isolated child process load + RSS snapshots; sampled RSS may miss transient peaks. Resource maxRSS is platform-specific raw data. No production claims."
  };
  console.log(JSON.stringify({status:report.status,summary:report.summary},null,2));
  if(output){
    const dest=path.resolve(output),root=path.resolve("build","superagent","benchmarks")+path.sep;
    if(!dest.startsWith(root)||!dest.endsWith(".json"))
      throw new Error("Output must be an ignored JSON benchmark in build/superagent/benchmarks/");
    fs.mkdirSync(path.dirname(dest),{recursive:true});
    fs.writeFileSync(dest,JSON.stringify(report,null,2)+"\n");
  }
}
if(process.argv.includes("--child"))await child();
else await main();
