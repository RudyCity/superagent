/**
 * Offline intent-only V3 candidate research.
 * Multinomial weighted-feature naive Bayes on development labels ONLY.
 * It is not a runtime classifier, ToolExecutor permission, a gold-label
 * generator, or independent benchmark evidence.
 */
import {createHash} from "node:crypto";
import {extractSenopatiV2SparseFeatures,SENOPATI_V2_HEADS} from "./senopatiV2Shadow.js";

const INTENTS=SENOPATI_V2_HEADS.intent;
type Intent=(typeof INTENTS)[number];
export interface IntentTrainingRow{
  id:string;group:string;text:string;context:string;intent:Intent;
  domain:string;action:string;risk:string;approval:string;
}
type IntentModelParams={alpha:number;priorWeight:number;minDf:number};
export interface ResearchPrediction{label:Intent;relativeScore:number;authorizesExecution:false}
function fingerprint(text:string,context:string){
  return createHash("sha256").update(context+"\u0000"+text.normalize("NFKC").toLowerCase().replace(/\s+/gu," ").trim()).digest("hex");
}
function deterministic(group:string){
  return createHash("sha256").update("senopati-intent-v3-dev-20261023\u0000"+group).digest("hex");
}
function input(row:Pick<IntentTrainingRow,"text"|"context">){
  return row.context?`context ${row.context} message ${row.text}`:`message ${row.text}`;
}
export function validateIntentResearchRows(rows:IntentTrainingRow[]):void {
  if(!Array.isArray(rows)||rows.length<60||rows.length>10000)
    throw new Error("Intent research requires a bounded labeled development corpus");
  const ids=new Set<string>(),strata=new Map<string,string>();
  for(const row of rows){
    if(!row||typeof row.id!=="string"||!row.id||ids.has(row.id)||
       typeof row.group!=="string"||!row.group||typeof row.text!=="string"||
       typeof row.context!=="string"||row.text.length>8192||row.context.length>512||
       !(INTENTS as readonly string[]).includes(row.intent))
      throw new Error("Invalid/duplicate labeled research record");
    ids.add(row.id);
    const old=strata.get(row.group);
    if(old===undefined)strata.set(row.group,row.intent);
    // Group can legitimately include several intents, but it MUST remain
    // intact. Stratification uses a single deterministic representative.
  }
}
export function splitIntentResearchRows(rows:IntentTrainingRow[]){
  validateIntentResearchRows(rows);
  const groups=new Map<string,IntentTrainingRow[]>();
  for(const row of rows){
    const list=groups.get(row.group);
    if(list)list.push(row);else groups.set(row.group,[row]);
  }
  const byStratum=new Map<string,string[]>();
  for(const [group,items] of groups){
    const counts=new Map<string,number>();
    for(const row of items)counts.set(row.intent,(counts.get(row.intent)??0)+1);
    const labels=[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
    const stratum=labels[0][0];
    const list=byStratum.get(stratum);
    if(list)list.push(group);else byStratum.set(stratum,[group]);
  }
  const partitions:{train:IntentTrainingRow[];validation:IntentTrainingRow[];test:IntentTrainingRow[]}={
    train:[],validation:[],test:[]
  };
  const groupCounts={train:0,validation:0,test:0};
  // Hashes fixed independently of row input order; group membership is never split.
  for(const [stratum,g] of [...byStratum].sort((a,b)=>a[0].localeCompare(b[0]))){
    g.sort((a,b)=>deterministic(stratum+"\u0000"+a).localeCompare(deterministic(stratum+"\u0000"+b)));
    const n=g.length;
    const testCount=n>=5?Math.max(1,Math.floor(n*0.20)):n>=3?1:0;
    const valCount=n>=5?Math.max(1,Math.floor(n*0.20)):n>=3?1:0;
    for(let i=0;i<n;i++){
      const part:"train"|"validation"|"test" =
        i<testCount?"test":i<testCount+valCount?"validation":"train";
      partitions[part].push(...groups.get(g[i])!);
      groupCounts[part]++;
    }
  }
  const partitionFingerprints=new Map<string,string>();
  const leaks:string[]=[];
  for(const part of ["train","validation","test"] as const){
    for(const row of partitions[part]){
      const hash=fingerprint(row.text,row.context);
      const previous=partitionFingerprints.get(hash);
      if(previous&&previous!==part)leaks.push(row.id);
      else partitionFingerprints.set(hash,part);
    }
  }
  // Exact repeats across partitions invalidate the entire experiment.
  if(leaks.length)throw new Error("Repeated normalized text across research partitions ("+leaks.length+" samples)");
  if(partitions.train.length<40||partitions.validation.length<10||partitions.test.length<10)
    throw new Error("Missing meaningful group-isolated partitions");
  return {...partitions,groupCounts,datasetFingerprint:createHash("sha256")
    .update(rows.map(r=>r.id+"\u0000"+r.group+"\u0000"+r.text+"\u0000"+r.intent).sort().join("\n"))
    .digest("hex")};
}
export class IntentV3NaiveBayesResearch{
  private weights:Float64Array[]=[];
  private bias:Float64Array=new Float64Array(INTENTS.length);
  private features=new Map<string,number>();
  private readonly params:IntentModelParams;
  readonly source="senopati-v3-intent-research-only";
  readonly authorizesExecution=false;
  constructor(params:IntentModelParams){
    if(!Number.isFinite(params.alpha)||params.alpha<=0||
       !Number.isFinite(params.priorWeight)||params.priorWeight<0||params.priorWeight>2||
       !Number.isInteger(params.minDf)||params.minDf<1||params.minDf>10)
      throw new Error("Invalid intent candidate parameters");
    this.params=params;
  }
  fit(rows:IntentTrainingRow[]):this{
    const docCount=new Map<string,number>();
    const documents=rows.map(row=>{
      const feats=extractSenopatiV2SparseFeatures(input(row));
      for(const key of Object.keys(feats))docCount.set(key,(docCount.get(key)??0)+1);
      return {label:row.intent,features:feats};
    });
    this.features=new Map([...docCount].filter(([,n])=>n>=this.params.minDf)
      .map(([key],index)=>[key,index]));
    const vocabularySize=this.features.size;
    if(vocabularySize<3)throw new Error("Research vocabulary too small");
    const counts=INTENTS.map(()=>new Float64Array(vocabularySize));
    const totals=new Float64Array(INTENTS.length);
    const classCounts=new Float64Array(INTENTS.length);
    for(const row of documents){
      const labelIndex=INTENTS.indexOf(row.label);
      classCounts[labelIndex]++;
      for(const [term,value] of Object.entries(row.features)){
        const id=this.features.get(term);
        if(id===undefined)continue;
        counts[labelIndex][id]+=value;
        totals[labelIndex]+=value;
      }
    }
    this.weights=INTENTS.map((_,index)=>{
      const w=new Float64Array(vocabularySize);
      const denom=totals[index]+this.params.alpha*vocabularySize;
      for(let i=0;i<vocabularySize;i++)
        w[i]=Math.log((counts[index][i]+this.params.alpha)/denom);
      this.bias[index]=this.params.priorWeight*Math.log((classCounts[index]+1)/(documents.length+INTENTS.length));
      return w;
    });
    return this;
  }
  predict(text:string,context=""):ResearchPrediction{
    if(typeof text!=="string"||typeof context!=="string"||
       text.length>8192||context.length>512||this.weights.length!==INTENTS.length)
      throw new Error("Invalid intent candidate prediction request");
    const feats=extractSenopatiV2SparseFeatures(input({text,context}));
    const scores=INTENTS.map((_,i)=>{
      let score=this.bias[i];
      const w=this.weights[i];
      for(const [term,value] of Object.entries(feats)){
        const id=this.features.get(term);
        if(id!==undefined)score+=value*w[id];
      }
      return score;
    });
    let best=0;
    for(let i=1;i<scores.length;i++)if(scores[i]>scores[best])best=i;
    const max=scores[best];
    const weight=scores.map(s=>Math.exp(Math.max(-700,s-max)));
    const share=weight[best]/weight.reduce((a,b)=>a+b,0);
    return {label:INTENTS[best],relativeScore:share,authorizesExecution:false};
  }
  stats(){return {vocabulary:this.features.size,labels:INTENTS.length,parameters:this.params};}
}
export function intentMetrics(rows:IntentTrainingRow[],predict:(row:IntentTrainingRow)=>Intent):{
  n:number;macroF1:number;accuracy:number;minorityMacroF1:number;
  perClass:Record<string,{support:number;tp:number;fp:number;fn:number;f1:number}>;
}{
  const values=INTENTS.map(label=>({label,support:0,tp:0,fp:0,fn:0,f1:0}));
  let right=0;
  for(const row of rows){
    const predicted=predict(row);
    if(!(INTENTS as readonly string[]).includes(predicted))throw new Error("Invalid predicted intent");
    values[INTENTS.indexOf(row.intent)].support++;
    if(predicted===row.intent){right++;values[INTENTS.indexOf(row.intent)].tp++;}
    else {
      values[INTENTS.indexOf(predicted)].fp++;
      values[INTENTS.indexOf(row.intent)].fn++;
    }
  }
  for(const c of values){
    const denom=2*c.tp+c.fp+c.fn;
    c.f1=denom?2*c.tp/denom:0;
  }
  const supported=values.filter(v=>v.support>0);
  const minority=supported.filter(v=>["chat","approve","reject","modify"].includes(v.label));
  return {
    n:rows.length,macroF1:supported.reduce((x,y)=>x+y.f1,0)/Math.max(1,supported.length),
    accuracy:right/Math.max(1,rows.length),
    minorityMacroF1:minority.reduce((x,y)=>x+y.f1,0)/Math.max(1,minority.length),
    perClass:Object.fromEntries(values.map(v=>[v.label,{support:v.support,tp:v.tp,fp:v.fp,fn:v.fn,f1:v.f1}]))
  };
}

/** Research selection gate — NEVER a production release gate. */
export function assessIntentV3Candidate(
  baseline:{macroF1:number;accuracy:number;minorityMacroF1:number},
  candidate:{macroF1:number;accuracy:number;minorityMacroF1:number}
){
  for(const [name,m] of [["baseline",baseline],["candidate",candidate]] as const){
    if([m.macroF1,m.accuracy,m.minorityMacroF1].some(x=>!Number.isFinite(x)||x<0||x>1))
      throw new Error("Invalid "+name+" classifier research metrics");
  }
  const macroGain=candidate.macroF1-baseline.macroF1;
  const minorityGain=candidate.minorityMacroF1-baseline.minorityMacroF1;
  const accuracyGain=candidate.accuracy-baseline.accuracy;
  const improvesDevelopment=macroGain>0 && minorityGain>=0 && accuracyGain>=-0.01;
  return {
    status:improvesDevelopment?
      "FURTHER_REVIEW_ON_NEW_DATA_REQUIRED" as const:
      "REJECTED_ON_GROUP_TEST" as const,
    reason:improvesDevelopment?
      "Development improvements remain unverified; new independent data required":
      "Fails development macro-F1/minority or accuracy non-regression gate",
    deltas:{macroF1:macroGain,minorityMacroF1:minorityGain,accuracy:accuracyGain},
    eligibleForAutomaticToolRouting:false as const,
    productionPromotionAuthorized:false as const,
    trainingLabelsHumanVerified:false as const,
    blindIndependentBenchmark:false as const,
  };
}
