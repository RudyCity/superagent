/**
 * Offline Senopati V2 intent threshold split diagnostic only.
 * Use previously inspected labeled development sets; this does NOT certify
 * predictive confidence or unlock any automatic tool routing.
 */
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {loadShadowRegistry} from "../src/core/senopatiV2CandidateRegistry.js";
import {evaluateIntentDevelopmentThreshold,type IntentAuditSample} from "../src/core/senopatiV2IntentSplitExperiment.js";
const args=process.argv.slice(2);
function opt(flag:string,optional=false):string {
  const i=args.indexOf(flag);
  if(i<0||!args[i+1]){
    if(optional)return "";
    throw new Error("Missing "+flag);
  }
  return args[i+1];
}
function load(filename:string){
  const stat=fs.statSync(filename);
  if(!stat.isFile()||stat.size<2||stat.size>5*1024*1024)throw new Error("Intent dataset file exceeds bounds");
  const lines=fs.readFileSync(filename,"utf8").split(/\r?\n/).filter(Boolean);
  if(lines.length<1||lines.length>10000)throw new Error("Intent dataset row count out of bounds");
  return lines.map(line=>JSON.parse(line));
}
const datasets:string[]=[];
for(let i=0;i<args.length;i++)if(args[i]==="--set"&&args[i+1])datasets.push(args[i+1]);
if(!datasets.length||datasets.length>8)throw new Error("Specify 1–8 --set FILE development datasets");
const registryFile=opt("--registry"),training=opt("--training"),outfile=opt("--out");
const out=path.resolve(outfile);
const root=path.resolve("build","superagent","quality")+path.sep;
if(!out.startsWith(root)||!out.endsWith(".json"))throw new Error("Output must be an ignored quality JSON report");
const rows:IntentAuditSample[]=[];
const sourceHashes=[];
for(const f of datasets){
  const bytes=fs.readFileSync(f);
  sourceHashes.push({basename:path.basename(f),sha256:createHash("sha256").update(bytes).digest("hex")});
  rows.push(...load(f));
}
const trainingReferences=load(training).map((row:{text:string;context?:string})=>({
  text:row.text,context:row.context
}));
const {model,registry,cacheStatus}=loadShadowRegistry(registryFile,"compact-cached");
const metrics=evaluateIntentDevelopmentThreshold(model,rows,trainingReferences);
const report={
  ...metrics,registryModelSha256:registry.model.sha256,
  registryPolicySha256:registry.policy.sha256,cacheStatus,
  inputSources:sourceHashes,
  note:"Pre-inspected development data only. Never use these empirical thresholds for production routing."
};
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out,JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({
  status:report.status,
  threshold:report.chosenThreshold,
  reason:report.reason,excludedTrainingOverlap:report.excludedTrainingOverlap,
  excludedEvaluationDuplicates:report.excludedEvaluationDuplicates,
  calibration:report.calibration,evaluation:report.evaluation,
  releaseAuthorized:false,reportPath:out
},null,2));
