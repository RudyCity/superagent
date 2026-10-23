/**
 * Read-only coverage diagnostics over freshly re-verified signed review inputs.
 * Never treats signature verification, a coverage target, or a local manifest as
 * independent human gold labels or as permission to train/deploy.
 */
import {createHash} from "node:crypto";
import {SENOPATI_V2_HEADS} from "./senopatiV2Shadow.js";
import {HEADS,type Head,type ReviewPacket} from "./senopatiV3EvidenceIntake.js";
import type {ReviewEvidenceSummary} from "./senopatiV3SignedReview.js";

type Partition="train"|"calibration"|"sealed_evaluation";
export interface V3PartitionPlan {
  schema:1;
  status:"UNVERIFIED_FROZEN_DEVELOPMENT_PARTITIONS";
  partitionPlan:Record<string,{partition:Partition;ids:string[]}>;
  digest:string;sourcePacketHash:string;releaseAuthorized:false;
}
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const PARTS:Partition[]=["train","calibration","sealed_evaluation"];
const LANGUAGES=["id","en","mixed"] as const;
const MIN_EVALUATION_PER_CLASS=20;
const MIN_EVALUATION_GROUPS_PER_CLASS=5;
const MIN_EVALUATION_PER_LANGUAGE=50;
const required=new Map<Head,readonly string[]>([
  ["intent",SENOPATI_V2_HEADS.intent],
  ["risk",["sensitive","destructive"]],
  ["approval",["affirm","deny","conditional"]]
]);
export function auditV3QuarantinedCoverage(
  packet:ReviewPacket[],
  manifest:{packetHash:string;reviewSetDigest:string;status:string},
  plan:V3PartitionPlan,
  verified:ReviewEvidenceSummary
){
  if(manifest?.status!=="QUARANTINE_ONLY"||plan?.schema!==1||
     plan.status!=="UNVERIFIED_FROZEN_DEVELOPMENT_PARTITIONS"||
     plan.releaseAuthorized!==false||
     !Array.isArray(packet)||packet.length===0||packet.length>10000||
     verified.status!=="SIGNATURE_CHECKED_QUARANTINE_ONLY"||
     verified.trainingAuthorized!==false||
     verified.identitiesIndependentlyAuthenticated!==false||
     verified.packetHash!==manifest.packetHash||
     plan.sourcePacketHash!==manifest.packetHash||
     plan.digest!==manifest.reviewSetDigest||
     hash(JSON.stringify(plan.partitionPlan))!==plan.digest)
    throw new Error("Invalid/changed quarantined coverage evidence manifest");
  const ids=new Map(packet.map(row=>[row.id,row]));
  if(ids.size!==packet.length)throw new Error("Duplicate review packet IDs");
  const partitionIds=new Map<string,{partition:Partition;group:string}>();
  for(const [group,entry] of Object.entries(plan.partitionPlan)){
    if(!group||group.length>128||
       !entry||!PARTS.includes(entry.partition)||!Array.isArray(entry.ids)||entry.ids.length===0)
      throw new Error("Invalid frozen partition or group");
    for(const id of entry.ids){
      if(!ids.has(id)||partitionIds.has(id))throw new Error("Split leakage, extra IDs or duplicate group member");
      partitionIds.set(id,{partition:entry.partition,group});
    }
  }
  if(partitionIds.size!==ids.size)throw new Error("Incomplete frozen partition sample coverage");
  if(verified.counts.requests!==packet.length||
     verified.counts.agreements+verified.counts.disagreements!==packet.length||
     verified.finalizedRows.length!==verified.counts.agreements+verified.counts.adjudicated||
     verified.counts.unresolved!==verified.counts.disagreements-verified.counts.adjudicated)
    throw new Error("Inconsistent signed review aggregation");
  const cells=Object.fromEntries(PARTS.map(p=>[p,{
    examples:0,completeSignedAnnotations:0,groups:new Set<string>(),
    language:Object.fromEntries(LANGUAGES.map(l=>[l,0])) as Record<string,number>,
    classSupport:Object.fromEntries(HEADS.map(head=>[
      head,Object.fromEntries(SENOPATI_V2_HEADS[head].map(label=>[label,0]))
    ])) as Record<Head,Record<string,number>>,
    classGroups:Object.fromEntries(HEADS.map(head=>[
      head,Object.fromEntries(SENOPATI_V2_HEADS[head].map(label=>[label,new Set<string>()]))
    ])) as Record<Head,Record<string,Set<string>>>,
  }])) as Record<Partition,{
    examples:number;completeSignedAnnotations:number;groups:Set<string>;
    language:Record<string,number>;classSupport:Record<Head,Record<string,number>>;
    classGroups:Record<Head,Record<string,Set<string>>>;
  }>;
  for(const [id,row] of ids){
    const {partition,group}=partitionIds.get(id)!;
    cells[partition].examples++;
    cells[partition].groups.add(group);
    if(!LANGUAGES.includes(row.language as (typeof LANGUAGES)[number]))
      throw new Error("Invalid language in screened packet");
  }
  const finalizedIds=new Set<string>();
  for(const result of verified.finalizedRows){
    if(finalizedIds.has(result.id)||!ids.has(result.id)||
       ids.get(result.id)!.sampleHash!==result.sampleHash)
      throw new Error("Invalid adjudicated review row");
    finalizedIds.add(result.id);
    const item=ids.get(result.id)!;
    const {partition,group}=partitionIds.get(result.id)!;
    cells[partition].completeSignedAnnotations++;
    cells[partition].language[item.language]++;
    for(const head of HEADS){
      const label=result.labels[head];
      if(!Object.hasOwn(cells[partition].classSupport[head],label))
        throw new Error("Invalid finalized label");
      cells[partition].classSupport[head][label]++;
      cells[partition].classGroups[head][label].add(group);
    }
  }
  const holes:Array<{head:string;label:string;support:number;groups:number;requiredSupport:number;requiredGroups:number}>=[];
  const heldout=cells.sealed_evaluation;
  for(const [head,labels] of required){
    for(const label of labels){
      const support=heldout.classSupport[head][label];
      const groups=heldout.classGroups[head][label].size;
      if(support<MIN_EVALUATION_PER_CLASS||groups<MIN_EVALUATION_GROUPS_PER_CLASS){
        holes.push({head,label,support,groups,
          requiredSupport:MIN_EVALUATION_PER_CLASS,requiredGroups:MIN_EVALUATION_GROUPS_PER_CLASS});
      }
    }
  }
  const languageGaps=LANGUAGES.slice(0,2).map(language=>({
    language,reviewed:heldout.language[language],required:MIN_EVALUATION_PER_LANGUAGE
  })).filter(cell=>cell.reviewed<cell.required);
  const summaries=Object.fromEntries(PARTS.map(part=>[
    part,{
      examples:cells[part].examples,
      annotated:cells[part].completeSignedAnnotations,
      groups:cells[part].groups.size,
      language:cells[part].language,
      classSupport:cells[part].classSupport,
    }
  ]));
  return {
    schema:1,status:"UNVERIFIED_QUARANTINE_COVERAGE_DIAGNOSTIC" as const,
    partitionPlanDigest:plan.digest,
    packetHash:manifest.packetHash,
    partitions:summaries,
    unresolvedReviewCount:verified.counts.unresolved,
    minorityCoverageDeficits:holes,languageCoverageDeficits:languageGaps,
    coverageRequirementsMet:holes.length===0&&languageGaps.length===0&&
      verified.counts.unresolved===0&&
      PARTS.every(p=>cells[p].completeSignedAnnotations>0),
    humanIdentityIndependentlyVerified:false as const,
    sourceProvenanceIndependentlyVerified:false as const,
    actualIndependentGoldLabelsAvailable:0 as const,
    modelTrainingAuthorized:false as const,
    sealedEvaluationAuthorized:false as const,
    productionReleaseAuthorized:false as const,
    toolAuthorization:false as const,
  };
}
