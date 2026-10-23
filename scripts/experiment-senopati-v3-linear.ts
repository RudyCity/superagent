/**
 * Two explicit phases: (1) prepare a hash-bound group manifest before training;
 * (2) fit discriminative intent models, choose only on validation, evaluate
 * group test once, then generate a development-only report.
 *
 * bun scripts/experiment-senopati-v3-linear.ts prepare --dataset FILE --plan ignored.json
 * bun scripts/experiment-senopati-v3-linear.ts run --dataset FILE --plan ignored.json --out ignored.json
 */
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {
  planLinearIntentDevelopmentSplit,applyLinearIntentDevelopmentPlan,
  IntentV3LinearResearch,type LinearParams,type FrozenLinearResearchPlan,
} from "../src/core/senopatiV3IntentLinearResearch.js";
import {
  intentMetrics,assessIntentV3Candidate,type IntentTrainingRow
} from "../src/core/senopatiV2IntentCandidateResearch.js";
import {SenopatiV2Shadow,SENOPATI_V2_HEADS,extractSenopatiV2SparseFeatures} from "../src/core/senopatiV2Shadow.js";

const args=process.argv.slice(2);
const mode=args[0];
if(mode!=="prepare"&&mode!=="run")throw new Error("Specify prepare or run");
function arg(key:string){
  const i=args.indexOf(key);
  if(i<0||!args[i+1])throw new Error("Missing argument "+key);
  return args[i+1];
}
function ignored(target:string){
  const full=path.resolve(target);
  const root=path.resolve("build","superagent","quality")+path.sep;
  if(!full.startsWith(root)||!full.endsWith(".json"))
    throw new Error("Plan and research output must stay in ignored quality directory");
  return full;
}
const dataPath=arg("--dataset"),planPath=ignored(arg("--plan"));
const bytes=fs.readFileSync(dataPath);
if(bytes.length<100||bytes.length>5*1024*1024)throw new Error("Invalid research source size");
const sourceSha256=createHash("sha256").update(bytes).digest("hex");
const rows=bytes.toString("utf8").split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s)) as IntentTrainingRow[];
const expectedPlan=planLinearIntentDevelopmentSplit(rows,sourceSha256);
if(mode==="prepare"){
  fs.mkdirSync(path.dirname(planPath),{recursive:true});
  if(fs.existsSync(planPath)){
    if(fs.readFileSync(planPath,"utf8")!==JSON.stringify(expectedPlan,null,2)+"\n")
      throw new Error("Pre-registered development split already exists but differs; refusing overwrite");
  }else fs.writeFileSync(planPath,JSON.stringify(expectedPlan,null,2)+"\n",{flag:"wx"});
  console.log(JSON.stringify({
    status:expectedPlan.status,planDigest:expectedPlan.planDigest,
    splitCounts:expectedPlan.splitCounts,groupCounts:expectedPlan.groupCounts,
    trainingStarted:false,independentBenchmark:false,releaseAuthorized:false,planFile:planPath
  },null,2));
}else{
  const output=ignored(arg("--out"));
  if(path.resolve(output)===path.resolve(planPath))throw new Error("Plan cannot be overwritten by report");
  if(!fs.existsSync(planPath))throw new Error("Prepare the split manifest BEFORE training");
  const plan=JSON.parse(fs.readFileSync(planPath,"utf8")) as FrozenLinearResearchPlan;
  const split=applyLinearIntentDevelopmentPlan(rows,sourceSha256,plan);
  const model=new SenopatiV2Shadow({
    format:"senopati-v2-sparse-baseline",deployment:"candidate-only",
    heads:Object.fromEntries(Object.entries(SENOPATI_V2_HEADS).map(([h,v])=>[h,[...v]])) as any,
    records:split.train.map(r=>({
      features:extractSenopatiV2SparseFeatures(r.context?
        `context ${r.context} message ${r.text}`:`message ${r.text}`),
      domain:r.domain,intent:r.intent,action:r.action,risk:r.risk,approval:r.approval
    }))
  });
  const metric=(predict:(row:IntentTrainingRow)=>IntentTrainingRow["intent"],input:IntentTrainingRow[])=>
    intentMetrics(input,predict);
  const sparsePredict=(row:IntentTrainingRow)=>model.predict(row.text,row.context).labels.intent;
  const baselineValidation=metric(sparsePredict,split.validation);

  // Fixed grid and deterministic tie breaks. NEVER use test during this loop.
  const grid:LinearParams[]=[];
  for(const learningRate of [0.04,0.12,0.25])
    for(const epochs of [12,24])
      for(const l2 of [0,0.002])
        for(const balanceClasses of [false,true])
          grid.push({learningRate,epochs,l2,balanceClasses});
  const trials:Array<{params:LinearParams;validation:ReturnType<typeof intentMetrics>;vocab:number}>=[];
  for(const params of grid){
    const candidate=new IntentV3LinearResearch(params).fit(split.train);
    const validation=metric(row=>candidate.predict(row.text,row.context).label,split.validation);
    trials.push({params,validation,vocab:candidate.stats().vocabulary});
  }
  trials.sort((a,b)=>b.validation.macroF1-a.validation.macroF1||
      b.validation.minorityMacroF1-a.validation.minorityMacroF1||
      b.validation.accuracy-a.validation.accuracy||
      JSON.stringify(a.params).localeCompare(JSON.stringify(b.params)));
  const selected=trials[0];
  const candidate=new IntentV3LinearResearch(selected.params).fit(split.train);
  // This is the FIRST test access by the experiment procedure, after tuning.
  const baselineTest=metric(sparsePredict,split.test);
  const candidateTest=metric(row=>candidate.predict(row.text,row.context).label,split.test);
  const researchGate=assessIntentV3Candidate(baselineTest,candidateTest);
  const report={
    schema:1,status:"INTENT_V3_DISCRIMINATIVE_RESEARCH_ONLY",
    sourceSha256,sourceDatasetBasename:path.basename(dataPath),
    planDigest:plan.planDigest,planStatus:plan.status,
    trainCount:split.train.length,validationCount:split.validation.length,testCount:split.test.length,
    groups:plan.groupCounts,numberOfHyperparameterTrials:grid.length,
    model:"intent-only-multiclass-linear-softmax",
    selectedParams:selected.params,selection:"validation_macro_f1_then_minority_macro_f1_then_accuracy",
    trainingMethod:"deterministic_online_sgd_with_train_only_vocab",
    baseline:{validation:baselineValidation,test:baselineTest},
    discriminative:{validation:selected.validation,test:candidateTest},
    researchGate,topValidationCandidates:trials.slice(0,8),
    trainedOnExistingDevelopmentLabels:true,
    testNotIndependentOfEarlierDevelopment:true,
    blindHumanVerifiedLabels:0,confidenceCalibrated:false,
    modelWeightsExported:false,releaseAuthorized:false,authorizesExecution:false,
    eligibleForAutomaticToolRouting:false,
    note:"One use of new pre-registered group split. This development corpus has been previously used for other algorithm evaluation. A pass only warrants external review, not runtime deployment."
  };
  const contents=JSON.stringify(report,null,2)+"\n";
  fs.mkdirSync(path.dirname(output),{recursive:true});
  if(fs.existsSync(output)){
    if(fs.readFileSync(output,"utf8")!==contents)
      throw new Error("Research report already exists and differs; do not retune on observed test");
  }else fs.writeFileSync(output,contents,{flag:"wx"});
  console.log(JSON.stringify({
    status:report.status,splitCounts:plan.splitCounts,groupCounts:plan.groupCounts,
    planDigest:plan.planDigest,candidates:trials.length,selected:selected.params,
    baselineTest:{accuracy:baselineTest.accuracy,macroF1:baselineTest.macroF1,
      minorityMacroF1:baselineTest.minorityMacroF1},
    candidateTest:{accuracy:candidateTest.accuracy,macroF1:candidateTest.macroF1,
      minorityMacroF1:candidateTest.minorityMacroF1},
    researchGate:researchGate.status,releaseAuthorized:false,output
  },null,2));
}
