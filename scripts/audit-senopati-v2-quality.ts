/**
 * bun scripts/audit-senopati-v2-quality.ts --registry FILE
 *   --training FILE --set NAME=FILE [--set NAME=FILE ...]
 *   --out build/superagent/quality/quality_audit_v1.json
 *
 * Read-only shadow diagnostics on development/pre-inspected data. Never a
 * production blind benchmark, calibration certificate or training pipeline.
 */
import fs from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
import { loadShadowRegistry } from "../src/core/senopatiV2CandidateRegistry.js";
import { auditSenopatiV2, type AuditCase } from "../src/core/senopatiV2QualityAudit.js";

const args=process.argv.slice(2);
function one(flag:string,required=true):string|undefined{
  const index=args.indexOf(flag);
  if(index<0){if(required)throw new Error("Missing "+flag);return undefined;}
  if(!args[index+1])throw new Error("Missing value "+flag);
  return args[index+1];
}
function boundedJsonl(filename:string):Array<Record<string,unknown>>{
  const st=fs.statSync(filename);
  if(!st.isFile()||st.size>5*1024*1024)throw new Error("Invalid or oversized audit input");
  const lines=fs.readFileSync(filename,"utf8").split(/\r?\n/).filter(Boolean);
  if(lines.length===0||lines.length>10_000)throw new Error("Unbounded audit input");
  return lines.map((line,i)=>{
    const row=JSON.parse(line);
    if(typeof row!=="object"||!row||Array.isArray(row))throw new Error("Malformed audit row "+i);
    return row as Record<string,unknown>;
  });
}
const registryFile=one("--registry")!,trainingFile=one("--training")!,outfile=one("--out")!;
const setArgs:string[]=[];
for(let i=0;i<args.length;i++)if(args[i]==="--set"&&args[i+1])setArgs.push(args[i+1]);
if(setArgs.length<1||setArgs.length>8)throw new Error("Pass between 1 and 8 --set NAME=PATH inputs");
const sets=setArgs.map(x=>{
  const sep=x.indexOf("=");
  if(sep<1)throw new Error("Set must have NAME=PATH format");
  const name=x.slice(0,sep),filename=x.slice(sep+1);
  if(!/^[a-z0-9_-]{1,48}$/i.test(name)||!filename)throw new Error("Invalid dataset label/path");
  return {name,filename};
});
if(new Set(sets.map(x=>x.name)).size!==sets.length)throw new Error("Duplicate quality dataset name");
const destination=path.resolve(outfile);
const root=path.resolve("build","superagent","quality")+path.sep;
if(!destination.startsWith(root)||!destination.endsWith(".json"))
  throw new Error("Quality reports can only be written to ignored build/superagent/quality/*.json");
const training=boundedJsonl(trainingFile).map(x=>({text:x.text,context:x.context,group:x.group})) as Array<{text:string,context?:string,group?:string}>;
const loaded=loadShadowRegistry(registryFile,"compact-cached");
const evaluated:Record<string,ReturnType<typeof auditSenopatiV2>>={};
const all:AuditCase[]=[];
const ids=new Set<string>();
for(const {name,filename} of sets){
  const cases=boundedJsonl(filename) as AuditCase[];
  // Fail on duplicate IDs across unrelated sets so triage IDs stay stable.
  for(const item of cases){
    if(ids.has(item.id))throw new Error("Duplicate audit case ID between datasets: "+item.id);
    ids.add(item.id);
  }
  const result=auditSenopatiV2(loaded.model,loaded.policy,cases,training);
  evaluated[name]=result;
  all.push(...cases);
}
const combined=auditSenopatiV2(loaded.model,loaded.policy,all,training);
const report={
  schema:1,status:"UNVERIFIED_DEVELOPMENT_QUALITY_AUDIT",
  cacheStatus:loaded.cacheStatus,
  modelHash:loaded.registry.model.sha256,
  policyHash:loaded.registry.policy.sha256,
  headScope:["intent","risk","approval"],
  sources:sets.map(x=>({datasetName:x.name,fileBasename:path.basename(x.filename),sha256:createHash("sha256").update(fs.readFileSync(x.filename)).digest("hex"),labelsIndependentlyVerified:false})),
  perSet:evaluated,combined,
  releaseAuthorized:false,toolAuthorizationGranted:false,independentBlindBenchmark:false,
  accuracyCertified:false,confidenceCalibrated:false,
  note:"Development/previously-inspected and/or AI-authored labels only. Precision/recall are descriptive and cannot certify a safe release."
};
fs.mkdirSync(path.dirname(destination),{recursive:true});
fs.writeFileSync(destination,JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({
  status:report.status,total:combined.totalCases,
  labeledHeadComparisons:combined.labeledComparisons,
  overlapWithTraining:combined.overlap.exactTrainingMatches,
  duplicatesAmongEvaluation:combined.overlap.duplicateAmongEvaluation,
  safetyEvents:combined.safetyEvents,
  worstTriageIds:combined.triage.slice(0,12).map(x=>({id:x.id,head:x.head,reason:x.reason,actual:x.actual,raw:x.raw,guarded:x.guarded})),
  reportPath:destination
},null,2));
