/**
 * Senopati V3 intent-only discriminative candidate. Research only.
 * No hooks into live routing, permissions, risk or approval.
 *
 * A local split manifest is prepared BEFORE fitting any candidate. The
 * manifest stores group assignments and SHA-256 of the entire input JSONL,
 * not private prompt text, and rejects edited/missing group assignments.
 */
import { createHash } from "node:crypto";
import { extractSenopatiV2SparseFeatures, SENOPATI_V2_HEADS } from "./senopatiV2Shadow.js";
import { validateIntentResearchRows, type IntentTrainingRow } from "./senopatiV2IntentCandidateResearch.js";

const INTENTS=SENOPATI_V2_HEADS.intent;
type Intent=(typeof INTENTS)[number];
type Partition="train"|"validation"|"test";
const SEED="senopati-v3-linear-group-plan-v1-20261023";
const sha=(v:string)=>createHash("sha256").update(v).digest("hex");
const normalize=(v:string)=>v.normalize("NFKC").toLowerCase().replace(/\s+/gu," ").trim();
export interface FrozenLinearResearchPlan {
  schema:1;
  status:"DEVELOPMENT_SPLIT_PRE_REGISTERED";
  sourceSha256:string;
  seed:string;
  groupAssignment:Record<string,Partition>;
  splitCounts:Record<Partition,number>;
  groupCounts:Record<Partition,number>;
  planDigest:string;
  createdBeforeTraining:true;
  independentBlindBenchmark:false;
  releaseAuthorized:false;
}
function counts(){return {train:0,validation:0,test:0};}
function planDigest(x:Omit<FrozenLinearResearchPlan,"planDigest">):string {
  return sha(JSON.stringify(x));
}
export function planLinearIntentDevelopmentSplit(rows:IntentTrainingRow[],sourceSha256:string):FrozenLinearResearchPlan {
  validateIntentResearchRows(rows);
  if(!/^[a-f0-9]{64}$/.test(sourceSha256))throw new Error("Unpinned intent research corpus");
  const groups=new Map<string,IntentTrainingRow[]>();
  for(const row of rows){
    const items=groups.get(row.group);
    if(items)items.push(row);else groups.set(row.group,[row]);
  }
  const strata=new Map<Intent,string[]>();
  for(const [group,items] of groups){
    const votes=new Map<Intent,number>();
    for(const item of items)votes.set(item.intent,(votes.get(item.intent)??0)+1);
    const label=[...votes].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0][0];
    const list=strata.get(label);
    if(list)list.push(group);else strata.set(label,[group]);
  }
  const groupAssignment:Record<string,Partition>=Object.create(null);
  for(const [label,ids] of [...strata].sort((a,b)=>a[0].localeCompare(b[0]))){
    ids.sort((a,b)=>sha(SEED+"\u0000"+label+"\u0000"+a).localeCompare(sha(SEED+"\u0000"+label+"\u0000"+b)));
    const n=ids.length;
    const test=n>=3?Math.max(1,Math.floor(n*0.20)):0;
    const validation=n>=3?Math.max(1,Math.floor(n*0.20)):0;
    ids.forEach((id,i)=>groupAssignment[id]=i<test?"test":i<test+validation?"validation":"train");
  }
  const splitCounts=counts(),groupCounts=counts();
  for(const row of rows)splitCounts[groupAssignment[row.group]]++;
  for(const part of Object.values(groupAssignment))groupCounts[part]++;
  if(splitCounts.train<40||splitCounts.validation<20||splitCounts.test<20)
    throw new Error("Insufficient groups for research partition");
  // Strict normalized-text leakage check independent of group IDs.
  const observed=new Map<string,Partition>();
  for(const row of rows){
    const fp=sha(row.context+"\u0000"+normalize(row.text));
    const part=groupAssignment[row.group];
    const previous=observed.get(fp);
    if(previous!==undefined&&previous!==part)
      throw new Error("Cross-split duplicate normalized prompt: "+row.id);
    observed.set(fp,part);
  }
  const payload={
    schema:1 as const,status:"DEVELOPMENT_SPLIT_PRE_REGISTERED" as const,
    sourceSha256,seed:SEED,
    groupAssignment:Object.fromEntries(Object.entries(groupAssignment).sort((a,b)=>a[0].localeCompare(b[0]))) as Record<string,Partition>,
    splitCounts,groupCounts,createdBeforeTraining:true as const,
    independentBlindBenchmark:false as const,releaseAuthorized:false as const,
  };
  return {...payload,planDigest:planDigest(payload)};
}
export function applyLinearIntentDevelopmentPlan(
  rows:IntentTrainingRow[],sourceSha256:string,plan:FrozenLinearResearchPlan
):Record<Partition,IntentTrainingRow[]> {
  // Regenerate the plan from the current byte-identical corpus; fail closed
  // even when the saved JSON claims a correct digest.
  const fresh=planLinearIntentDevelopmentSplit(rows,sourceSha256);
  if(plan?.schema!==1||plan.status!=="DEVELOPMENT_SPLIT_PRE_REGISTERED"||
     plan.sourceSha256!==sourceSha256||plan.seed!==SEED||
     plan.releaseAuthorized!==false||plan.independentBlindBenchmark!==false||
     plan.createdBeforeTraining!==true||
     plan.planDigest!==fresh.planDigest||
     JSON.stringify(plan.groupAssignment)!==JSON.stringify(fresh.groupAssignment)||
     JSON.stringify(plan.splitCounts)!==JSON.stringify(fresh.splitCounts)||
     JSON.stringify(plan.groupCounts)!==JSON.stringify(fresh.groupCounts))
    throw new Error("Research split plan changed, incorrect, or not pre-registered");
  const split:{train:IntentTrainingRow[];validation:IntentTrainingRow[];test:IntentTrainingRow[]}={
    train:[],validation:[],test:[]
  };
  for(const row of rows)split[plan.groupAssignment[row.group]].push(row);
  return split;
}
export interface LinearParams{
  learningRate:number;
  epochs:number;
  l2:number;
  balanceClasses:boolean;
}
export class IntentV3LinearResearch {
  readonly source="senopati-v3-linear-experiment-only";
  readonly authorizesExecution=false;
  private vocab=new Map<string,number>();
  private weights:Float64Array[]=[];
  private biases=new Float64Array(INTENTS.length);
  private params:LinearParams;
  constructor(params:LinearParams){
    if(![0.04,0.12,0.25].includes(params.learningRate)||
       ![12,24].includes(params.epochs)||
       ![0,0.002].includes(params.l2)||
       typeof params.balanceClasses!=="boolean")
      throw new Error("Invalid preregistered discriminative research parameters");
    this.params=params;
  }
  private static input(text:string,context:string){
    return context?`context ${context} message ${text}`:`message ${text}`;
  }
  private encode(text:string,context:string):Array<[number,number]>{
    const input=extractSenopatiV2SparseFeatures(IntentV3LinearResearch.input(text,context));
    const features:Array<[number,number]>=[];
    let sum=0;
    for(const [term,value] of Object.entries(input)){
      const id=this.vocab.get(term);
      if(id===undefined)continue;
      sum+=value*value;
      features.push([id,value]);
    }
    if(sum>0){
      const norm=Math.sqrt(sum);
      for(const v of features)v[1]/=norm;
    }
    return features;
  }
  fit(rows:IntentTrainingRow[]):this{
    validateIntentResearchRows(rows);
    const frequency=new Map<string,number>();
    for(const row of rows){
      const features=extractSenopatiV2SparseFeatures(IntentV3LinearResearch.input(row.text,row.context));
      for(const key of Object.keys(features))frequency.set(key,(frequency.get(key)??0)+1);
    }
    // Train-only vocabulary, deterministic lexicographic feature IDs.
    this.vocab=new Map([...frequency.keys()].sort().map((key,id)=>[key,id]));
    if(this.vocab.size<10||this.vocab.size>200000)throw new Error("Invalid research vocabulary");
    this.weights=INTENTS.map(()=>new Float64Array(this.vocab.size));
    this.biases=new Float64Array(INTENTS.length);
    const samples=rows.map(row=>({
      id:row.id,
      label:INTENTS.indexOf(row.intent),
      features:this.encode(row.text,row.context),
    }));
    const counts=new Float64Array(INTENTS.length);
    for(const s of samples)counts[s.label]++;
    // Smooth and cap rare-class weights, never synthesize labels.
    const weights=INTENTS.map((_,i)=>this.params.balanceClasses?
      Math.min(4,Math.sqrt(samples.length/(INTENTS.length*Math.max(1,counts[i])))):1);
    for(let epoch=0;epoch<this.params.epochs;epoch++){
      const ordered=[...samples].sort((a,b)=>
        sha(SEED+"\u0000"+epoch+"\u0000"+a.id).localeCompare(sha(SEED+"\u0000"+epoch+"\u0000"+b.id)));
      const rate=this.params.learningRate/Math.sqrt(1+epoch*0.2);
      for(const sample of ordered){
        const logits=INTENTS.map((_,i)=>{
          let value=this.biases[i];
          const w=this.weights[i];
          for(const [j,x] of sample.features)value+=w[j]*x;
          return value;
        });
        const max=Math.max(...logits);
        const exps=logits.map(x=>Math.exp(x-max));
        const total=exps.reduce((a,b)=>a+b,0);
        for(let i=0;i<INTENTS.length;i++){
          const grad=(Number(i===sample.label)-exps[i]/total)*weights[sample.label]*rate;
          this.biases[i]+=grad;
          for(const [j,x] of sample.features)this.weights[i][j]+=grad*x;
        }
      }
      const shrink=Math.max(0,1-this.params.l2);
      if(shrink!==1)for(const w of this.weights)for(let j=0;j<w.length;j++)w[j]*=shrink;
    }
    return this;
  }
  predict(text:string,context=""):{
    label:Intent;relativeScore:number;authorizesExecution:false;
  } {
    if(typeof text!=="string"||typeof context!=="string"||
      text.length>8192||context.length>512||this.weights.length!==INTENTS.length)
      throw new Error("Invalid shadow-only discriminative inference request");
    const features=this.encode(text,context);
    const scores=INTENTS.map((_,i)=>{
      let score=this.biases[i];
      for(const [id,x] of features)score+=this.weights[i][id]*x;
      return score;
    });
    let best=0;
    for(let i=1;i<scores.length;i++)if(scores[i]>scores[best])best=i;
    const m=scores[best];
    const exp=scores.map(x=>Math.exp(x-m));
    return {
      label:INTENTS[best],relativeScore:exp[best]/exp.reduce((a,b)=>a+b,0),
      authorizesExecution:false,
    };
  }
  stats(){return {vocabulary:this.vocab.size,params:this.params,authorizesExecution:false as const};}
}
