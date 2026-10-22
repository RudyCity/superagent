/**
 * Explicit read-only Senopati candidate performance profile.
 * bun scripts/bench-senopati-v2-shadow.ts --registry FILE --dataset JSONL [--out FILE]
 * Writes aggregate statistics only (no raw customer input in report).
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadShadowRegistry } from "../src/core/senopatiV2CandidateRegistry.js";
import { assessSelectiveShadow } from "../src/core/senopatiV2SelectiveDecision.js";
const args=process.argv.slice(2);
function opt(name:string, required=true):string | undefined {
  const n=args.indexOf(name);
  if (n<0){if(required)throw new Error("Missing "+name);return undefined;}
  if (!args[n+1])throw new Error("Missing value "+name);
  return args[n+1];
}
const registryFile=opt("--registry")!, inputFile=opt("--dataset")!, outfile=opt("--out",false);
const engine=opt("--engine",false) ?? "reference";
if (engine!=="reference" && engine!=="indexed" && engine!=="compact") throw new Error("Unknown --engine");
const start=performance.now();
const {model,policy,registry}=loadShadowRegistry(registryFile,engine);
const compared=engine!=="reference" ? loadShadowRegistry(registryFile,"reference").model : null;
const coldStartMs=performance.now()-start;
const data=fs.readFileSync(inputFile,"utf8").split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));
if (data.length<50 || data.length>10_000)
  throw new Error("Require 50–10,000 representative benchmark cases");
for (const row of data) if (typeof row.text!=="string" || typeof row.context!=="string")
  throw new Error("Benchmark request missing text/context");
for (const row of data) {
  if (compared) {
    const expected=compared.predictGuarded(row.text,row.context);
    const actual=model.predictGuarded(row.text,row.context);
    if(JSON.stringify(actual.labels)!==JSON.stringify(expected.labels)){
      throw new Error("Non-reference inference changed reference head labels; aborting benchmark");
    }
    for(const head of Object.keys(expected.relativeScores) as Array<keyof typeof expected.relativeScores>) {
      if(Math.abs(actual.relativeScores[head]-expected.relativeScores[head])>1e-9) {
        throw new Error("Non-reference relative score parity exceeded tolerance: "+head);
      }
    }
  }
}
for (const row of data.slice(0,Math.min(10,data.length))) {
  const result=assessSelectiveShadow(model.predictGuarded(row.text,row.context),policy);
  if (result.authorizesExecution!==false || result.eligibleForAutomaticToolRouting!==false)
    throw new Error("Unsafe benchmark decision");
}
const samples: number[]=[];
const headAccepted:Record<string,number>={domain:0,intent:0,action:0,risk:0,approval:0};
const memStart=process.memoryUsage().heapUsed;
let total=0,abstain=0;
for (const row of data) {
  const t=performance.now();
  const prediction=model.predictGuarded(row.text,row.context);
  const observed=assessSelectiveShadow(prediction,policy);
  samples.push(performance.now()-t);
  total++;
  if (observed.abstain) abstain++;
  for (const [h,v] of Object.entries(observed.heads)) if (v.advisoryAccept)headAccepted[h]++;
}
samples.sort((a,b)=>a-b);
function percentile(p:number):number {
  return samples[Math.max(0,Math.min(samples.length-1,Math.ceil(samples.length*p)-1))];
}
const duration=samples.reduce((a,b)=>a+b,0);
const report={
  schema:1,status:"SHADOW_BENCHMARK_ONLY",engine,
  referenceParityVerified: compared!==null,
  releaseAuthorized:false,
  toolExecutionAuthorized:false,automaticRoutingEnabled:false,
  registrySha256:{model:registry.model.sha256,policy:registry.policy.sha256},
  cases:total,coldStartMs,
  inference:{meanMs:duration/total,p50Ms:percentile(0.5),
    p95Ms:percentile(0.95),p99Ms:percentile(0.99),
    maxMs:samples[samples.length-1],throughputPerSec:total/(duration/1000)},
  memory:{heapStartBytes:memStart,heapEndBytes:process.memoryUsage().heapUsed},
  abstain:abstain,headAdvisoryAccept:headAccepted,
  confidenceCalibrated:false,independentBlindEvidence:false,
  note:"Local machine benchmark only, no accuracy or safety certification. Inputs not retained. Non-reference engines load a reference copy for pre-benchmark parity, so heap and cold start are not isolated engine-only measurements; use worker benchmark for heap comparison."
};
console.log(JSON.stringify(report,null,2));
if(outfile) {
 const target=path.resolve(outfile),allowed=path.resolve("build","superagent","benchmarks")+path.sep;
 if(!target.startsWith(allowed)||!target.endsWith(".json"))
   throw new Error("Benchmark reports allowed only in ignored build/superagent/benchmarks/*.json");
 fs.mkdirSync(path.dirname(target),{recursive:true});
 fs.writeFileSync(target,JSON.stringify(report,null,2)+"\n");
}
