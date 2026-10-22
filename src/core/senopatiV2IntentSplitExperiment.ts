/**
 * Development-only, group-separated intent threshold experiment.
 *
 * No input is certified as independent: this partitions ALREADY INSPECTED
 * development examples only to avoid evaluating a threshold on exactly the
 * examples used to choose it. Relative sparse similarity is NOT probability.
 * Guarded intent labels must not reuse raw relativeScores as confidence when
 * the guard has changed the intent head.
 */
import {createHash} from "node:crypto";
import type {SenopatiV2ShadowPrediction} from "./senopatiV2Shadow.js";

export interface IntentAuditSample {
  readonly id:string;
  readonly text:string;
  readonly context?:string;
  readonly group?:string;
  readonly intent:string;
}
export interface IntentAuditPrediction {
  readonly rawLabel:string;
  readonly guardedLabel:string;
  readonly rawRelativeScore:number;
}
export type IntentAuditModel = {
  predict(text:string,context?:string):SenopatiV2ShadowPrediction;
  predictGuarded(text:string,context?:string):SenopatiV2ShadowPrediction;
};
const HEAD_LABELS=new Set(["chat","ask","research","draft","create","modify","execute","approve","reject"]);
const SEED="senopati-intent-quality-20261023";
const CANDIDATES=Array.from({length:21},(_,i)=>i/20);
const MIN_SUPPORT=12;
const WILSON_Z=1.96;
const REQUIRED_LOWER=0.90;
function sha(s:string){return createHash("sha256").update(s).digest("hex");}
function normalized(s:string){return s.normalize("NFKC").toLowerCase().replace(/\s+/gu," ").trim();}
export function wilsonLower(successes:number,total:number):number {
  if(total===0)return 0;
  const p=successes/total,z2=WILSON_Z*WILSON_Z,n=total;
  return Math.max(0,(p+z2/(2*n)-WILSON_Z*Math.sqrt(p*(1-p)/n+z2/(4*n*n)))/(1+z2/n));
}
export interface IntentExperimentRecord {
  id:string;group:string;truth:string;
  rawLabel:string;guardedLabel:string;
  rawScore:number;
  guardChangedIntent:boolean;
}
export function groupIntentDevelopmentSplit(
  samples:IntentAuditSample[],
  trainingReferences:Array<{text:string;context?:string}>=[],
):{
  calibration:IntentAuditSample[];
  evaluation:IntentAuditSample[];
  excludedTrainingOverlap:number;
  excludedDuplicates:number;
  groups:{calibration:number;evaluation:number};
}{
  if(samples.length<10||samples.length>10000)
    throw new Error("Development intent experiment needs 10–10,000 labeled cases");
  const trainHashes=new Set(trainingReferences.map(s=>sha((s.context??"")+"\u0000"+normalized(s.text))));
  const ids=new Set<string>(),seenInputs=new Set<string>();
  let excludedTrainingOverlap=0,excludedDuplicates=0;
  const byGroup=new Map<string,IntentAuditSample[]>();
  for(const sample of samples){
    if(typeof sample.id!=="string"||!sample.id||ids.has(sample.id)||
       typeof sample.text!=="string"||sample.text.length>8192||
       typeof sample.context!=="string"&&sample.context!==undefined||
       !HEAD_LABELS.has(sample.intent))
      throw new Error("Invalid/duplicate intent audit sample");
    ids.add(sample.id);
    const digest=sha((sample.context??"")+"\u0000"+normalized(sample.text));
    if(trainHashes.has(digest)){excludedTrainingOverlap++;continue;}
    if(seenInputs.has(digest)){excludedDuplicates++;continue;}
    seenInputs.add(digest);
    // Prefer an original semantic group; otherwise identical normalized text
    // would be grouped by hash. The exact text deduplicator is independent.
    const group=sample.group||"text-"+digest;
    const existing=byGroup.get(group);
    if(existing)existing.push(sample);
    else byGroup.set(group,[sample]);
  }
  const buckets=new Map<string,Array<{id:string;items:IntentAuditSample[]}>>();
  for(const [id,items] of byGroup){
    const stratum=items[0].intent;
    const existing=buckets.get(stratum);
    const group={id,items};
    if(existing)existing.push(group);
    else buckets.set(stratum,[group]);
  }
  const calibration:IntentAuditSample[]=[],evaluation:IntentAuditSample[]=[];
  const calGroups=new Set<string>(),evalGroups=new Set<string>();
  for(const [label,groups] of [...buckets.entries()].sort((a,b)=>a[0].localeCompare(b[0]))){
    groups.sort((a,b)=>sha(SEED+"\u0000"+label+"\u0000"+a.id).localeCompare(sha(SEED+"\u0000"+label+"\u0000"+b.id)));
    const n=groups.length;
    // Very sparse classes cannot support class-specific calibration. Put
    // the only group into evaluation rather than tuning on 1 example.
    const calCount=n>1?Math.max(1,Math.min(n-1,Math.floor(n*0.60))):0;
    groups.forEach((g,i)=>{
      if(i<calCount){calibration.push(...g.items);calGroups.add(g.id);}
      else{evaluation.push(...g.items);evalGroups.add(g.id);}
    });
  }
  if(calibration.length===0||evaluation.length===0)throw new Error("Cannot make disjoint development split");
  for(const id of calGroups)if(evalGroups.has(id))throw new Error("Group leakage between partitions");
  return {calibration,evaluation,excludedTrainingOverlap,excludedDuplicates,
    groups:{calibration:calGroups.size,evaluation:evalGroups.size}};
}
function collect(model:IntentAuditModel,rows:IntentAuditSample[]):IntentExperimentRecord[]{
  return rows.map(sample=>{
    const raw=model.predict(sample.text,sample.context??"");
    const guarded=model.predictGuarded(sample.text,sample.context??"");
    if(raw.authorizesExecution!==false||guarded.authorizesExecution!==false)
      throw new Error("Non-shadow model in intent experiment");
    const score=raw.relativeScores.intent;
    if(!Number.isFinite(score)||score<0||score>1)throw new Error("Invalid relative similarity");
    return {
      id:sample.id,group:sample.group??"",truth:sample.intent,
      rawLabel:raw.labels.intent,guardedLabel:guarded.labels.intent,
      rawScore:score,guardChangedIntent:raw.labels.intent!==guarded.labels.intent
    };
  });
}
function stats(rows:IntentExperimentRecord[],threshold:number|null){
  let accepted=0,correct=0;
  const changed=rows.filter(r=>r.guardChangedIntent).length;
  const guardedAccuracy=rows.filter(r=>r.guardedLabel===r.truth).length/Math.max(1,rows.length);
  const rawAccuracy=rows.filter(r=>r.rawLabel===r.truth).length/Math.max(1,rows.length);
  if(threshold!==null){
    for(const row of rows){
      // Only count unmodified raw intent labels. Guard-overridden labels have
      // no calibrated score and automatically abstain from advisory acceptance.
      if(!row.guardChangedIntent&&row.rawScore>=threshold){
        accepted++;
        if(row.rawLabel===row.truth)correct++;
      }
    }
  }
  return {
    cases:rows.length,
    labelOverriddenByGuard:changed,
    rawAccuracy,guardedAccuracy,
    accepted,correct,errorsAmongAccepted:accepted-correct,
    acceptedPrecision:accepted?correct/accepted:null,
    wilson95Lower:accepted?wilsonLower(correct,accepted):null,
    coverage:accepted/Math.max(1,rows.length),
  };
}
export function evaluateIntentDevelopmentThreshold(
  model:IntentAuditModel,
  samples:IntentAuditSample[],
  trainingReferences:Array<{text:string;context?:string}>=[]
){
  const split=groupIntentDevelopmentSplit(samples,trainingReferences);
  const fit=collect(model,split.calibration),test=collect(model,split.evaluation);
  const table=CANDIDATES.map(threshold=>{
    const x=stats(fit,threshold);
    return {threshold,accepted:x.accepted,precision:x.acceptedPrecision,
      wilson95Lower:x.wilson95Lower,coverage:x.coverage};
  });
  const chosen=table.find(x=>x.accepted>=MIN_SUPPORT&&
    x.wilson95Lower!==null&&x.wilson95Lower>=REQUIRED_LOWER);
  const threshold=chosen?.threshold??null;
  return {
    schema:1,status:"UNVERIFIED_DEVELOPMENT_SPLIT_ONLY" as const,
    datasetUsedForTuning:true,independentBlindBenchmark:false,
    humanReviewVerified:false,confidenceCalibrated:false,
    releaseAuthorized:false,authorizesExecution:false,automaticRoutingEnabled:false,
    reason:threshold===null?"NO_THRESHOLD_MEETS_DEVELOPMENT_BOUND":"RESEARCH_THRESHOLD_ONLY",
    chosenThreshold:threshold,
    similarityScoresAreProbabilities:false,
    overriddenIntentScoresAreNotValidConfidence:true,
    excludedTrainingOverlap:split.excludedTrainingOverlap,
    excludedEvaluationDuplicates:split.excludedDuplicates,
    splitGroups:split.groups,
    targetWilsonLower:REQUIRED_LOWER,minCalibrationAccepted:MIN_SUPPORT,
    calibration:stats(fit,threshold),evaluation:stats(test,threshold),
    candidateThresholds:table,
  };
}
