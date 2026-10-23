/**
 * Offline intent V3 candidate experiment, no model promotion.
 * Select NB hyperparameters ONLY using group-disjoint validation, and measure
 * group-disjoint test ONCE after selection. Known previous development corpus.
 */
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {SenopatiV2Shadow,extractSenopatiV2SparseFeatures,SENOPATI_V2_HEADS} from "../src/core/senopatiV2Shadow.js";
import {IntentV3NaiveBayesResearch,splitIntentResearchRows,intentMetrics,assessIntentV3Candidate,type IntentTrainingRow} from "../src/core/senopatiV2IntentCandidateResearch.js";

const argv=process.argv.slice(2);
function arg(name:string):string{
  const i=argv.indexOf(name);
  if(i<0||!argv[i+1])throw new Error("Expected "+name);
  return argv[i+1];
}
const input=arg("--dataset"),out=path.resolve(arg("--out"));
const root=path.resolve("build","superagent","quality")+path.sep;
if(!out.startsWith(root)||!out.endsWith(".json"))throw new Error("Output only permitted in ignored quality folder");
const buffer=fs.readFileSync(input);
if(buffer.length>5*1024*1024||buffer.length<100)throw new Error("Invalid research input size");
const rows=buffer.toString("utf8").split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x)) as IntentTrainingRow[];
const split=splitIntentResearchRows(rows);
function metricsByModel(model:{predict(text:string,context?:string):{label?:string;labels?:{intent:string}}},items:IntentTrainingRow[]){
  return intentMetrics(items,r=>{
    const output=model.predict(r.text,r.context);
    const label=output.label??output.labels?.intent;
    if(!label)throw new Error("No predicted intent");
    return label as IntentTrainingRow["intent"];
  });
}
const baseline=new SenopatiV2Shadow({
  format:"senopati-v2-sparse-baseline",deployment:"candidate-only",
  heads:Object.fromEntries(Object.entries(SENOPATI_V2_HEADS).map(([head,labels])=>[head,[...labels]])) as any,
  records:split.train.map(r=>({
    features:extractSenopatiV2SparseFeatures(r.context?`context ${r.context} message ${r.text}`:`message ${r.text}`),
    domain:r.domain, intent:r.intent,action:r.action,risk:r.risk,approval:r.approval
  }))
});
const baselineValidation=metricsByModel(baseline,split.validation);

const candidates=[];
const alphas=[0.05,0.25,1,3];
const priors=[0,0.3,0.7,1];
const dfs=[1,2];
for(const alpha of alphas)for(const priorWeight of priors)for(const minDf of dfs){
  const params={alpha,priorWeight,minDf};
  const model=new IntentV3NaiveBayesResearch(params).fit(split.train);
  const score=metricsByModel(model,split.validation);
  candidates.push({params,validation:score});
}
candidates.sort((a,b)=>
  b.validation.macroF1-a.validation.macroF1||
  b.validation.minorityMacroF1-a.validation.minorityMacroF1||
  b.validation.accuracy-a.validation.accuracy||
  JSON.stringify(a.params).localeCompare(JSON.stringify(b.params))
);
const selected=candidates[0];
const winner=new IntentV3NaiveBayesResearch(selected.params).fit(split.train);
// Evaluate ONCE, after parameter choice is fixed from validation.
const baselineTest=metricsByModel(baseline,split.test);
const test=metricsByModel(winner,split.test);
const researchGate=assessIntentV3Candidate(baselineTest,test);
const report={
  schema:1,status:"EXPERIMENTAL_INTENT_V3_DEVELOPMENT_ONLY",
  sourceDatasetBasename:path.basename(input),
  sourceDatasetSha256:createHash("sha256").update(buffer).digest("hex"),
  fingerprint:split.datasetFingerprint,
  trainingExamples:split.train.length,validationExamples:split.validation.length,testExamples:split.test.length,
  splitGroups:split.groupCounts, groupOverlapAllowed:false,
  architecture:"intent-only-multinomial-naive-bayes-research",
  searchSpace:{alphas,priors,dfs,candidateCount:candidates.length},
  validationSelection:"macroF1_then_minorityF1_then_accuracy",
  winner:selected.params,
  baseline:{validation:baselineValidation,test:baselineTest},
  experimental:{validation:selected.validation,test},
  topValidationCandidates:candidates.slice(0,8),
  researchGate,
  improvementOnUntunedGroupTest:{
    macroF1:test.macroF1-baselineTest.macroF1,
    accuracy:test.accuracy-baselineTest.accuracy,
    minorityMacroF1:test.minorityMacroF1-baselineTest.minorityMacroF1
  },
  modelWasExported:false,
  fullDatasetPreviouslyInspected:true,
  humanReviewVerified:false,
  independentBlindBenchmark:false,
  trueProbabilityCalibration:false,
  releaseAuthorized:false,
  authorizesExecution:false,
  eligibleForAutomaticToolRouting:false,
  note:"This is a tuned development-corpus experiment. Test groups are disjoint from train/validation, but examples are not independently collected/verified and do not establish generalization."
};
fs.mkdirSync(path.dirname(out),{recursive:true});
fs.writeFileSync(out,JSON.stringify(report,null,2)+"\n",{flag:"w"});
console.log(JSON.stringify({
  status:report.status,counts:split.groupCounts,
  examples:[split.train.length,split.validation.length,split.test.length],
  baselineValidation:{macroF1:baselineValidation.macroF1,accuracy:baselineValidation.accuracy},
  baselineTest:{macroF1:baselineTest.macroF1,accuracy:baselineTest.accuracy},
  winner:report.winner,
  experimentalValidation:{macroF1:selected.validation.macroF1,accuracy:selected.validation.accuracy},
  experimentalTest:{macroF1:test.macroF1,accuracy:test.accuracy},
  improvement:report.improvementOnUntunedGroupTest,
  researchGate:report.researchGate.status,
  productionUnchanged:true,
  reportPath:out
},null,2));
