/**
 * Development-only quality audit for Senopati V2 shadow classifier.
 * Explicitly NOT a blind benchmark or production release certification.
 * Aggregated counts and sample IDs only: no user prompt text in reports.
 */
import { createHash } from "node:crypto";
import { SENOPATI_V2_HEADS, type SenopatiV2ShadowPrediction } from "./senopatiV2Shadow.js";
import { inferSelectiveApproval } from "./senopatiV2ApprovalSelective.js";
import type { SelectivePolicyProfile } from "./senopatiV2SelectiveDecision.js";
import { assessSelectiveShadow } from "./senopatiV2SelectiveDecision.js";

export type AuditedHead = "intent" | "risk" | "approval";
export type AuditCase = {
  id: string; text: string; context?: string; source?: string;
  group?: string; language?: string;
  intent?: string; risk?: string; approval?: string;
};
type ShadowModel = {
  predict(text: string, context?: string): SenopatiV2ShadowPrediction;
  predictGuarded(text: string, context?: string): SenopatiV2ShadowPrediction;
};
const HEADS: AuditedHead[] = ["intent","risk","approval"];
const MAX_CASES=10000;
function normalize(text:string):string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu," ").trim();
}
function fingerprint(text:string,context=""):string{
  return createHash("sha256").update(context+"\u0000"+normalize(text)).digest("hex");
}
export function assertAuditCases(cases:unknown,seen=new Set<string>()):asserts cases is AuditCase[]{
  if(!Array.isArray(cases)||cases.length<1||cases.length>MAX_CASES)
    throw new Error("Quality audit requires a bounded nonempty case set");
  for(const item of cases){
    if(!item||typeof item!=="object")throw new Error("Invalid quality audit case");
    const c=item as Partial<AuditCase>;
    if(typeof c.id!=="string"||c.id.length<1||c.id.length>128||seen.has(c.id)||
       typeof c.text!=="string"||c.text.length>8192||
       (c.context!==undefined&&(typeof c.context!=="string"||c.context.length>512)))
      throw new Error("Missing/duplicate/oversized audit id or text");
    seen.add(c.id);
    for(const head of HEADS){
      const label=c[head];
      if(label!==undefined&&!(SENOPATI_V2_HEADS[head] as readonly string[]).includes(label))
        throw new Error("Invalid expected "+head+" label in "+c.id);
    }
    for(const meta of ["source","group","language"] as const) {
      if(c[meta]!==undefined&&(typeof c[meta]!=="string"||c[meta]!.length>256))
        throw new Error("Invalid audit metadata "+meta);
    }
    if(!HEADS.some(h=>c[h]!==undefined))
      throw new Error("Audit example must have at least one labeled head");
  }
}
type Matrix = Record<string,Record<string,number>>;
function confusion(labels:readonly string[]):Matrix{
  return Object.fromEntries(labels.map(actual=>[
    actual,Object.fromEntries(labels.map(predicted=>[predicted,0]))
  ]));
}
function countMetric(matrix:Matrix,labels:readonly string[]){
  const classes:Record<string,unknown>={};
  let n=0,correct=0,macro=0,supported=0;
  for(const label of labels){
    const row=matrix[label];
    const support=Object.values(row).reduce((a,b)=>a+b,0);
    const predCount=labels.reduce((a,k)=>a+matrix[k][label],0);
    const tp=row[label],fp=predCount-tp,fn=support-tp;
    const precision=predCount>0?tp/predCount:0;
    const recall=support>0?tp/support:0;
    const f1=precision+recall>0?2*precision*recall/(precision+recall):0;
    classes[label]={support,tp,fp,fn,precision,recall,f1};
    if(support>0){macro+=f1;supported++;}
    n+=support;correct+=tp;
  }
  return {
    n,accuracy:n?correct/n:0,
    macroF1Supported:supported?macro/supported:0,
    supportedClasses:supported,
    classes,confusion:matrix
  };
}
export interface QualityAuditResult {
  schema:1;
  status:"DEVELOPMENT_DIAGNOSTIC_ONLY";
  totalCases:number;
  labeledComparisons:number;
  provenance:{unverified:boolean;independentBlindEvidence:false;humanAdjudicationVerified:false;releaseAuthorized:false};
  overlap:{exactTrainingMatches:number;duplicateAmongEvaluation:number;groupOverlapWithTraining:number;overlapIds:string[];duplicateIds:string[];groupOverlapIds:string[]};
  byHead:Record<string,Record<string,unknown>>;
  safetyEvents:{rawFalseAffirm:number;guardedFalseAffirm:number;selectiveFalseAffirm:number;rawDestructiveFalseNegative:number;guardedDestructiveFalseNegative:number;rawSensitiveMiss:number;guardedSensitiveMiss:number};
  advisory:{[head:string]:{accepted:number;errorsAmongAccepted:number;acceptanceRate:number;observedErrorRate:number}};
  triage:Array<{id:string;head:AuditedHead;reason:string;actual:string;raw:string;guarded:string;selective?:string;severity:number;sourceCategory:string;trainingOverlap:boolean}>;
  groupDiagnostics:{groups:number;repeatedGroups:number};
}
export function auditSenopatiV2(
  model:ShadowModel,profile:SelectivePolicyProfile,
  cases:AuditCase[],trainingCases:Array<{text:string;context?:string;group?:string}>=[]
):QualityAuditResult {
  assertAuditCases(cases);
  const trainFingerprints=new Set<string>();
  const trainGroups=new Set<string>();
  for(const x of trainingCases){
    if(typeof x.text!=="string"||typeof x.context!=="string"&&x.context!==undefined)
      throw new Error("Invalid training-reference fingerprint input");
    trainFingerprints.add(fingerprint(x.text,x.context??""));
    if(typeof x.group==="string"&&x.group)trainGroups.add(x.group);
  }
  const matrices:Record<string,Record<string,Matrix>>={};
  for(const head of HEADS){
    const values=SENOPATI_V2_HEADS[head];
    matrices[head]={
      raw:confusion(values),guarded:confusion(values),
      ...(head==="approval"?{selective:confusion(values)}:{})
    };
  }
  const advisory:QualityAuditResult["advisory"]={};
  for(const h of HEADS)advisory[h]={accepted:0,errorsAmongAccepted:0,acceptanceRate:0,observedErrorRate:0};
  const events:QualityAuditResult["safetyEvents"]={
    rawFalseAffirm:0,guardedFalseAffirm:0,selectiveFalseAffirm:0,
    rawDestructiveFalseNegative:0,guardedDestructiveFalseNegative:0,
    rawSensitiveMiss:0,guardedSensitiveMiss:0,
  };
  const overlaps:string[]=[],duplicates:string[]=[],groupOverlaps:string[]=[],triage:QualityAuditResult["triage"]=[];
  const seenInputs=new Set<string>(),groups=new Map<string,number>();
  let comparisons=0;
  for(const item of cases){
    const context=item.context??"";
    const raw=model.predict(item.text,context);
    const guarded=model.predictGuarded(item.text,context);
    if(raw.authorizesExecution!==false||guarded.authorizesExecution!==false)
      throw new Error("Non-shadow classification cannot be audited");
    const assessed=assessSelectiveShadow(guarded,profile);
    if(!assessed.abstain||assessed.authorizesExecution!==false||assessed.eligibleForAutomaticToolRouting!==false)
      throw new Error("Unsafe selective decision in quality audit");
    const hash=fingerprint(item.text,context);
    const inTrain=trainFingerprints.has(hash);
    if(inTrain)overlaps.push(item.id);
    if(item.group&&trainGroups.has(item.group))groupOverlaps.push(item.id);
    if(seenInputs.has(hash))duplicates.push(item.id);
    seenInputs.add(hash);
    if(item.group)groups.set(item.group,(groups.get(item.group)??0)+1);
    for(const head of HEADS){
      const truth=item[head];
      if(truth===undefined)continue;
      comparisons++;
      const p=raw.labels[head],g=guarded.labels[head];
      matrices[head].raw[truth][p]++;
      matrices[head].guarded[truth][g]++;
      let selective:string|undefined;
      if(head==="approval"){
        selective=inferSelectiveApproval(item.text,context);
        matrices.approval.selective[truth][selective]++;
        if(selective==="affirm"&&truth!=="affirm")events.selectiveFalseAffirm++;
        if(p==="affirm"&&truth!=="affirm")events.rawFalseAffirm++;
        if(g==="affirm"&&truth!=="affirm")events.guardedFalseAffirm++;
      }
      if(head==="risk"){
        if(truth==="destructive"&&p!=="destructive")events.rawDestructiveFalseNegative++;
        if(truth==="destructive"&&g!=="destructive")events.guardedDestructiveFalseNegative++;
        if(truth==="sensitive"&&p==="safe")events.rawSensitiveMiss++;
        if(truth==="sensitive"&&g==="safe")events.guardedSensitiveMiss++;
      }
      const ad=assessed.heads[head];
      if(ad.advisoryAccept){
        advisory[head].accepted++;
        if(g!==truth)advisory[head].errorsAmongAccepted++;
      }
      if(p!==truth||g!==truth||(selective!==undefined&&selective!==truth)){
        const severity=head==="approval"&&(p==="affirm"||g==="affirm"||selective==="affirm")&&truth!=="affirm"?100:
          head==="risk"&&truth==="destructive"&&(p!=="destructive"||g!=="destructive")?95:
          head==="risk"&&truth==="sensitive"&&(p==="safe"||g==="safe")?85:
          head==="approval"?70:head==="risk"?60:30;
        triage.push({
          id:item.id,head,reason:severity>=85?"safety_misclassification":
            p!==truth&&g!==truth?"raw_and_guarded_error":"model_disagreement",
          actual:truth,raw:p,guarded:g,...(selective!==undefined?{selective}:{}),
          severity,sourceCategory:item.source?.startsWith("GPT-6")?"ai_authored_development":"development_or_unverified",
          trainingOverlap:inTrain,
        });
      }
    }
  }
  const byHead:QualityAuditResult["byHead"]={};
  for(const h of HEADS){
    byHead[h]={};
    const support=Object.values(matrices[h].raw).reduce((acc,row)=>acc+Object.values(row).reduce((a,b)=>a+b,0),0);
    const a=advisory[h];
    a.acceptanceRate=support?a.accepted/support:0;
    a.observedErrorRate=a.accepted?a.errorsAmongAccepted/a.accepted:0;
    for(const [variant,matrix] of Object.entries(matrices[h]))
      byHead[h][variant]=countMetric(matrix,SENOPATI_V2_HEADS[h]);
  }
  triage.sort((a,b)=>b.severity-a.severity||a.id.localeCompare(b.id)||a.head.localeCompare(b.head));
  return {
    schema:1,status:"DEVELOPMENT_DIAGNOSTIC_ONLY",totalCases:cases.length,labeledComparisons:comparisons,
    provenance:{unverified:true,independentBlindEvidence:false,humanAdjudicationVerified:false,releaseAuthorized:false},
    overlap:{exactTrainingMatches:overlaps.length,duplicateAmongEvaluation:duplicates.length,groupOverlapWithTraining:groupOverlaps.length,
      overlapIds:overlaps,duplicateIds:duplicates,groupOverlapIds:groupOverlaps},
    byHead,safetyEvents:events,advisory,triage,
    groupDiagnostics:{groups:groups.size,repeatedGroups:[...groups.values()].filter(x=>x>1).length}
  };
}
