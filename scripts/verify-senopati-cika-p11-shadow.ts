/**
 * Cika P11 research-only shadow artifact consumer. READ-ONLY.
 *
 * This validates a Cika-authored artificial challenge, its predictions and
 * SHA256 pinned candidate files, independently recomputes confusion counts
 * from known AI-written test labels, and NEVER loads model into runtime.
 * Signature trust, human-gold, live production parity and rollout are absent.
 */
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import crypto from "node:crypto";
import {SENOPATI_V2_HEADS} from "../src/core/senopatiV2Shadow.js";

const SHA=/^[0-9a-f]{64}$/;
const HEADS=Object.keys(SENOPATI_V2_HEADS);
type Row=Record<string,unknown>;
const sha=(data:Buffer|string)=>crypto.createHash("sha256").update(data).digest("hex");
function assert(condition:unknown,reason:string): asserts condition {
  if(!condition)throw new Error("Cika P11 handoff rejected: "+reason);
};
function bounded(file:string,limit:number):Buffer{
  const stat=fs.lstatSync(file);
  assert(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=limit,"file missing, symlink, or oversize");
  return fs.readFileSync(file);
}
function object(value:unknown):value is Record<string,any>{
  return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
}
function lines(bytes:Buffer):Row[]{
  const result=bytes.toString("utf8").split(/\r?\n/).filter(x=>x.trim()).map(x=>JSON.parse(x));
  assert(result.every(object),"invalid line-based records");
  return result;
}
function pin(file:string,digest:string,limit:number){
  assert(SHA.test(digest),"invalid expected sha");
  assert(sha(bounded(file,limit))===digest,"pinned file digest differs");
}
function samePath(a:string,b:string):boolean{
  return path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
}
function validateHeadLabels(labels:unknown){
  assert(object(labels)&&Object.keys(labels).length===HEADS.length,"incomplete five head prediction");
  for(const h of HEADS){
    assert(Array.isArray(SENOPATI_V2_HEADS[h as keyof typeof SENOPATI_V2_HEADS])&&
      SENOPATI_V2_HEADS[h as keyof typeof SENOPATI_V2_HEADS].includes(labels[h]),"noncanonical predicted label");
  }
}
function confusion(dataset:Row[],observations:Row[],family:"p10"|"v2"){
  const out:Record<string,Record<string,Record<string,number>>>={};
  for(const h of HEADS){
    out[h]={};
    for(const actual of SENOPATI_V2_HEADS[h as keyof typeof SENOPATI_V2_HEADS]){
      out[h][actual]={};
      for(const pred of SENOPATI_V2_HEADS[h as keyof typeof SENOPATI_V2_HEADS])out[h][actual][pred]=0;
    }
  }
  for(let i=0;i<dataset.length;i++){
    const labels=family==="p10"?observations[i].p10Advisory:observations[i].v2ResearchBaseline;
    for(const head of HEADS)out[head][String(dataset[i][head])][String((labels as any)[head])]++;
  }
  return out;
}
function matchesConfusionMatrix(actual:Record<string,Record<string,number>>,expected:unknown):boolean{
  if(!object(expected)||Object.keys(expected).length!==Object.keys(actual).length)return false;
  for(const cls of Object.keys(actual)){
    if(!object(expected[cls])||Object.keys(expected[cls]).length!==Object.keys(actual[cls]).length)return false;
    for(const predicted of Object.keys(actual[cls]))if(actual[cls][predicted]!==expected[cls][predicted])return false;
  }
  return true;
}
function metrics(conf:Record<string,Record<string,number>>){
  let total=0;
  let f1=0;
  let represented=0;
  for(const actual of Object.keys(conf)){
    const support=Object.values(conf[actual]).reduce((a,b)=>a+b,0);
    total+=support;
    if(support>0){
      represented++;
      const tp=conf[actual][actual];
      let predicted=0;
      for(const other of Object.keys(conf))predicted+=conf[other][actual];
      const denominator=support+predicted;
      f1+=denominator>0?2*tp/denominator:0;
    }
  }
  return {total,macroF1:f1/Math.max(1,represented)};
}

export function verifyCikaP11Shadow(root:string,handoffFile:string,observationsFile:string){
  const cikaRoot=fs.realpathSync.native(path.resolve(root));
  const p11Dir=path.resolve(cikaRoot,"build","superagent","v3_p11_shadow_v2");
  const artifact=path.resolve(cikaRoot,"superagent","datasets","v3_p11_form_shift_rev1.jsonl");
  assert(samePath(handoffFile,path.resolve(p11Dir,"cika_p11_shadow_handoff.json")),"must use canonical Cika P11 handoff location");
  assert(samePath(observationsFile,path.resolve(p11Dir,"cika_p11_observations.jsonl")),"must use canonical Cika P11 observations");
  const h=JSON.parse(bounded(handoffFile,2*1024*1024).toString("utf8"));
  assert(object(h)&&h.schema===1&&h.status==="CIKA_P11_SHADOW_OBSERVATIONS_ONLY"&&h.origin==="Cika","invalid handoff status");
  for(const fld of ["publisherSignatureVerified","activationAllowed","automaticRoutingEnabled","authorizesExecution","retrainingAuthorized","productionReleaseAuthorized","sourceIndependentOfDeveloper"]){
    assert(h[fld]===false,"unexpected enabled trust/routing flag "+fld);
  }
  assert(h.humanGoldLabels===0&&h.modelFormat==="Cika-Rudy-development-only"&&h.sampleCount===72,"no human-gold/incorrect model format");
  const sum=h.summary;
  assert(object(sum)&&sum.schema===1&&sum.status==="P11_INSPECTED_AI_SYNTHETIC_FORM_SHIFT_READ_ONLY"&&
    sum.sampleCount===72&&sum.scenarioCount===24&&sum.benchmarkIsIndependentHumanGold===false&&
    sum.sourceIsArtificialAndTestNowInspected===true&&sum.trainOnThisBenchmark===false&&
    sum.productionCandidateActivated===false&&sum.comparedToLiveProductionTraffic===false&&
    sum.verifiedHumanGoldLabels===0&&sum.publisherSignatureVerified===false&&
    sum.productionReleaseAuthorized===false&&sum.toolAuthorization===false&&
    sum.guardToolAuthorizationCount===0,"unsafe or forged summary flags");
  const known={
    p10Model: path.resolve(cikaRoot,"build","superagent","v3_p10_curriculum","trained_sparse_p10.json"),
    p10Heads: path.resolve(cikaRoot,"build","superagent","v3_p10_curriculum","trained_nb_candidates.json"),
    p10Manifest: path.resolve(cikaRoot,"build","superagent","v3_p10_curriculum","candidate_manifest.json"),
    v2Model: path.resolve(cikaRoot,"build","superagent","senopati_v2_candidate","sparse_baseline.json"),
  };
  assert(samePath(h.p10ModelPath,known.p10Model)&&samePath(h.p10HeadsPath,known.p10Heads)&&
    samePath(h.p10ManifestPath,known.p10Manifest)&&samePath(h.v2ModelPath,known.v2Model),
    "model path does not match canonical development-only repository");
  pin(known.p10Model,h.p10ModelSha256,25*1024*1024);
  pin(known.p10Heads,h.p10HeadModelsSha256,25*1024*1024);
  pin(known.p10Manifest,h.p10ManifestSha256,1024*1024);
  pin(known.v2Model,h.v2ModelSha256,25*1024*1024);
  pin(artifact,h.sampleDatasetSha256,1024*1024);
  pin(observationsFile,h.observationsSha256,1024*1024);
  const meta=JSON.parse(bounded(known.p10Manifest,1024*1024).toString("utf8"));
  assert(meta.status==="P10_TRAINED_SYNTHETIC_CANDIDATE_QUARANTINED"&&
    meta.sparseSha256===h.p10ModelSha256&&meta.headModelsSha256===h.p10HeadModelsSha256&&
    meta.activationAllowed===false&&meta.automaticRoutingAuthorized===false&&
    meta.toolExecutionAuthorized===false&&meta.productionReleaseAuthorized===false&&
    meta.externalHumanGoldLabels===0,"untrusted P10 pinned checkpoint");

  const data=lines(bounded(artifact,1024*1024));
  const observed=lines(bounded(observationsFile,1024*1024));
  assert(data.length===72&&observed.length===72&&sum.languages?.id===24&&sum.languages?.en===24&&sum.languages?.mixed===24,"sample coverage changed");
  const ids=new Set<string>(),groupLanguages=new Map<string,Set<string>>();
  let manual=0,approvalBlocked=0;
  for(let i=0;i<data.length;i++){
    const item=data[i],obs=observed[i];
    assert(typeof item.id==="string"&&item.id===obs.id&&!ids.has(item.id),"sample IDs reordered/replayed");
    ids.add(item.id);
    assert(item.source==="ai_authored_p11_form_shift_synthetic_no_external_gold"&&
      item.group===obs.group&&item.language===obs.language&&
      ["id","en","mixed"].includes(String(item.language)),"sample language/provenance/group mismatch");
    assert(typeof item.text==="string"&&typeof item.context==="string"&&
      sha(item.context+"\0"+item.text)===obs.sampleSha256,"prompt fingerprint altered");
    for(const h of HEADS){
      assert(SENOPATI_V2_HEADS[h as keyof typeof SENOPATI_V2_HEADS].includes(item[h] as never),"bad AI-authored expected label");
    }
    validateHeadLabels(obs.p10Advisory);
    validateHeadLabels(obs.v2ResearchBaseline);
    assert(Object.keys(obs).length===11&&!Object.prototype.hasOwnProperty.call(obs,"text"),"unexpected raw prompt or hidden data");
    assert(obs.guardedApproval==="none"&&obs.automaticToolExecutionAuthorized===false&&
      obs.automaticDelegationAuthorized===false&&obs.productionReleaseAuthorized===false&&
      typeof obs.manualReviewRequired==="boolean","unsafe shadow observation");
    if(obs.manualReviewRequired)manual++;
    if((obs.p10Advisory as any).approval!=="none")approvalBlocked++;
    const group=String(item.group);
    if(!groupLanguages.has(group))groupLanguages.set(group,new Set());
    assert(!groupLanguages.get(group)!.has(String(item.language)),"duplicated translation");
    groupLanguages.get(group)!.add(String(item.language));
  }
  assert(groupLanguages.size===24&&[...groupLanguages.values()].every(l=>l.size===3),"incomplete scenario translations");
  assert(manual===sum.guardManualReviewCount&&approvalBlocked===sum.guardBlockedApprovalCount,"guard summary mismatch");
  for(const family of ["p10","v2"] as const){
    const counts=confusion(data,observed,family);
    for(const head of HEADS){
      assert(matchesConfusionMatrix(counts[head],sum.perHead?.[family]?.[head]?.confusion),"per-head confusion does not match samples");
      const {total,macroF1}=metrics(counts[head]);
      assert(total===72&&Math.abs(macroF1-sum.perHead[family][head].macroF1)<1e-8,"wrong aggregate F1");
    }
    for(const language of ["id","en","mixed"]){
      const idx=data.map((r,i)=>r.language===language?i:-1).filter(i=>i>=0);
      const sub=confusion(idx.map(i=>data[i]),idx.map(i=>observed[i]),family);
      for(const head of HEADS){
        assert(matchesConfusionMatrix(sub[head],sum.perLanguage?.[language]?.[family]?.[head]?.confusion),
          "per-language confusion does not match samples");
      }
    }
    const risk=counts.risk, approval=counts.approval;
    const safety=sum.safetyConfusions?.[family];
    let affirm=0,deny=0;
    for(const actual of Object.keys(approval)){
      if(actual!=="affirm")affirm+=approval[actual].affirm;
      if(actual!=="deny")deny+=approval[actual].deny;
    }
    assert(safety?.destructiveAsSafe===risk.destructive.safe&&safety?.sensitiveAsSafe===risk.sensitive.safe&&
      safety?.totalUnsafeAsSafe===risk.destructive.safe+risk.sensitive.safe&&
      safety?.falseAffirm===affirm&&safety?.falseDeny===deny,"safety-mismatch");
  }
  return {
    status:"CIKA_P11_SHADOW_CONSUMED_READ_ONLY",
    source:"AI_SYNTHETIC_DEVELOPMENT_ONLY",
    cases:72,scenarioGroups:24,
    candidate:"P10 Rudy research checkpoint",
    comparison:"V2 research-only fallback; NOT live production",
    unsafeAsSafe:sum.safetyConfusions,
    productionModelChanged:false,
    publisherSignatureVerified:false,
    independentHumanGold:false,
    liveProductionParityVerified:false,
    automaticRoutingEnabled:false,
    toolAuthorization:false,
    releaseAuthorized:false,
  };
}

const flag=(key:string)=>{
  const index=process.argv.indexOf(key);
  if(index<0||!process.argv[index+1])throw new Error("Missing "+key);
  return process.argv[index+1];
};
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  // Use --cika-root, never infer untrusted checkout paths.
  console.log(JSON.stringify(verifyCikaP11Shadow(flag("--cika-root"),flag("--handoff"),flag("--observations")),null,2));
}
