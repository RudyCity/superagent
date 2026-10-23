/**
 * Senopati V3 evidence intake — always quarantine, never training or release.
 * Does not use model predictions or teacher labels when choosing review rows.
 */
import {createHash} from "node:crypto";
import {SENOPATI_V2_HEADS} from "./senopatiV2Shadow.js";
export const HEADS=["intent","risk","approval"] as const;
export type Head=typeof HEADS[number];
const LANGUAGES=new Set(["id","en","mixed"]);
const SEED="senopati-v3-independent-collection-plan-v1";
export type IntakeOrigin="new_external_collection"|"historical_development_replay";
export type IntakeRow={
  id:string;text:string;context:string;language:string;group:string;
  source:string;origin:IntakeOrigin;
};
export type ReviewPacket={
  id:string;text:string;context:string;language:string;
  sampleHash:string;review_status:"awaiting_external_human_review";
  weak_labels_exposed:false;model_predictions_exposed:false;
};
export type IntakeBlock={
  id:string;
  reasons:string[];
};
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const normalized=(s:string)=>s.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu," ").trim();
function chargrams(s:string):Set<string>{
  const x=normalized(s);
  if(x.length<=4)return new Set([x]);
  const items=new Set<string>();
  for(let i=0;i+4<=x.length;i++)items.add(x.slice(i,i+4));
  return items;
}
function near(a:Set<string>,b:Set<string>):boolean{
  if(a.size===0||b.size===0)return false;
  let match=0;
  const smaller=a.size<=b.size?a:b,larger=a.size<=b.size?b:a;
  for(const item of smaller)if(larger.has(item))match++;
  return match/(a.size+b.size-match)>=0.82;
}
function hasUnredactedPii(text:string):boolean{
  // Defensive common-pattern check, not a complete privacy/PII detector.
  return /[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/.test(text)||
    /\b(?:\+62|0)8\d[\d -]{7,12}\b/.test(text);
}
export function screenV3Intake(
  cases:IntakeRow[],
  references:Array<{text:string;context?:string;group?:string}>,
):{
  manifest:{
    schema:1;status:"QUARANTINE_ONLY";seed:string;
    received:number;acceptedForBlindReview:number;excluded:number;
    blockedByReason:Record<string,number>;
    independentHumanGoldLabels:0;releaseAuthorized:false;
    trainingAuthorized:false;externalProvenanceVerified:false;
    packetHash:string;reviewSetDigest:string;
  };
  packet:ReviewPacket[];
  blocked:IntakeBlock[];
  internalPartitionPlan:Record<string,{partition:"train"|"calibration"|"sealed_evaluation";ids:string[]}>;
}{
  if(!Array.isArray(cases)||cases.length===0||cases.length>10000||
     !Array.isArray(references)||references.length===0||references.length>15000)
    throw new Error("Invalid/bounded V3 intake corpus");
  const prior=new Set<string>(),referenceQ:Array<{text:string;grams:Set<string>}>=[];
  const priorGroups=new Set<string>();
  for(const item of references){
    if(typeof item.text!=="string"||typeof item.context!=="string"&&item.context!==undefined)
      throw new Error("Invalid corpus used for contamination screening");
    const x=normalized(item.context??"")+"\u0000"+normalized(item.text);
    if(!prior.has(x))referenceQ.push({text:x,grams:chargrams(x)});
    prior.add(x);
    if(item.group)priorGroups.add(item.group);
  }
  const seenIds=new Set<string>(),seenTexts=new Set<string>();
  const accepted:Array<ReviewPacket & {group:string}>=[];
  const blocked:IntakeBlock[]=[];
  const reasonCounts:Record<string,number>=Object.create(null);
  for(const row of cases){
    if(!row||typeof row.id!=="string"||row.id.length<1||row.id.length>128||seenIds.has(row.id)||
       typeof row.text!=="string"||row.text.length<1||row.text.length>8192||
       typeof row.context!=="string"||row.context.length>512||
       typeof row.group!=="string"||row.group.length<1||row.group.length>128||
       typeof row.source!=="string"||row.source.length<1||row.source.length>128||
       !LANGUAGES.has(row.language)||
       (row.origin!=="new_external_collection"&&row.origin!=="historical_development_replay"))
      throw new Error("Invalid V3 intake format, label or duplicate id");
    seenIds.add(row.id);
    const joined=normalized(row.context)+"\u0000"+normalized(row.text);
    const reasons:string[]=[];
    if(row.origin!=="new_external_collection")reasons.push("historical_dev_source");
    if(priorGroups.has(row.group))reasons.push("training_group_collision");
    if(prior.has(joined))reasons.push("exact_development_overlap");
    if(seenTexts.has(joined))reasons.push("duplicate_in_batch");
    if(hasUnredactedPii(row.text)||hasUnredactedPii(row.context))
      reasons.push("potential_unredacted_personal_data");
    const grams=chargrams(joined);
    if(!prior.has(joined)&&referenceQ.some(ref=>near(grams,ref.grams)))
      reasons.push("near_development_overlap");
    if(accepted.some(other=>near(grams,chargrams(normalized(other.context)+"\u0000"+normalized(other.text)))))
      reasons.push("near_batch_duplicate");
    seenTexts.add(joined);
    for(const reason of reasons)reasonCounts[reason]=(reasonCounts[reason]??0)+1;
    if(reasons.length){blocked.push({id:row.id,reasons});continue;}
    // Same semantic group cannot be split into independent reviewer/holdout
    // allocations later; group ID is retained only in the local plan.
    const sampleHash=hash(row.id+"\u0000"+row.context+"\u0000"+row.text);
    accepted.push({
      id:row.id,text:row.text,context:row.context,language:row.language,
      sampleHash,review_status:"awaiting_external_human_review",
      weak_labels_exposed:false,model_predictions_exposed:false,group:row.group,
    });
  }
  // Deterministic, group-frozen allocation; reviewer packet itself never
  // exposes model labels, split assignment or selection priority.
  accepted.sort((a,b)=>a.id.localeCompare(b.id));
  const packet:ReviewPacket[]=accepted.map(({group:_group,...item})=>item);
  const packetHash=hash(packet.map(item=>JSON.stringify(item)).join("\n")+"\n");
  const byGroup=new Map<string,string[]>();
  for(const row of accepted){
    const ids=byGroup.get(row.group)??[];
    ids.push(row.id);byGroup.set(row.group,ids);
  }
  const plan=Object.fromEntries([...byGroup].sort((a,b)=>a[0].localeCompare(b[0])).map(([group,ids])=>[
    group,{partition:parseInt(hash(SEED+"\u0000"+group).slice(0,8),16)%10<7?"train":parseInt(hash(SEED+"\u0000"+group).slice(0,8),16)%10<9?"calibration":"sealed_evaluation",ids}
  ]));
  const reviewSetDigest=hash(JSON.stringify(plan));
  return {
    internalPartitionPlan:plan as Record<string,{partition:"train"|"calibration"|"sealed_evaluation";ids:string[]}>,
    manifest:{
      schema:1,status:"QUARANTINE_ONLY",seed:SEED,
      received:cases.length,acceptedForBlindReview:packet.length,excluded:blocked.length,
      blockedByReason:reasonCounts,independentHumanGoldLabels:0,
      releaseAuthorized:false,trainingAuthorized:false,
      externalProvenanceVerified:false,packetHash,reviewSetDigest,
    },
    packet,blocked,
  };
}
export function checkReviewLabels(labels:unknown):labels is Record<Head,string>{
  if(!labels||typeof labels!=="object"||Array.isArray(labels))return false;
  const keys=Object.keys(labels);
  return keys.length===HEADS.length&&HEADS.every(head=>
    typeof (labels as Record<string,unknown>)[head]==="string"&&
    (SENOPATI_V2_HEADS[head] as readonly string[]).includes((labels as Record<string,string>)[head])
  );
}
