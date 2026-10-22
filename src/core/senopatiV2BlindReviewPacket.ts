/**
 * Prepare a reviewer-blind local packet from a development-quality audit.
 * The manager must not share prediction/error details with reviewers.
 * Excluded: exact training overlaps, repeated evaluation texts, shared
 * training groups. These remaining examples are still NOT a blind benchmark.
 */
import {createHash} from "node:crypto";
import type {AuditCase,QualityAuditResult} from "./senopatiV2QualityAudit.js";
export interface BlindReviewRequest {
  id:string;
  text:string;
  context:string;
  fingerprint:string;
  review_status:"needs_independent_review";
  labels:null;
  suggested_labels_exposed:false;
}
export function prepareQualityBlindReview(
  cases:AuditCase[],report:QualityAuditResult
):{
  packets:BlindReviewRequest[];
  manifest:{
    status:"UNVERIFIED_DEV_REVIEW_PACKET";
    original:number;excluded:number;retained:number;
    excludedForTrainingOverlap:number;excludedForEvaluationDuplicate:number;excludedForGroupOverlap:number;
    independentHumanReviewVerified:false;
    modelTrainingAuthorized:false;
    releaseAuthorized:false;
  };
} {
  if(report.status!=="DEVELOPMENT_DIAGNOSTIC_ONLY"||
     report.provenance.independentBlindEvidence!==false||
     report.provenance.releaseAuthorized!==false||
     report.totalCases!==cases.length)throw new Error("Invalid source quality report");
  const blocked=new Set([
    ...report.overlap.overlapIds,
    ...report.overlap.duplicateIds,
    ...report.overlap.groupOverlapIds,
  ]);
  const seen=new Set<string>();
  const packets:BlindReviewRequest[]=[];
  for(const row of cases){
    if(seen.has(row.id))throw new Error("Repeated review sample ID");
    seen.add(row.id);
    if(blocked.has(row.id))continue;
    // All human labels and AI predictions remain outside reviewer packets.
    const context=row.context??"";
    packets.push({
      id:row.id,text:row.text,context,
      fingerprint:createHash("sha256").update(row.id+"\u0000"+context+"\u0000"+row.text).digest("hex"),
      review_status:"needs_independent_review",
      labels:null,suggested_labels_exposed:false,
    });
  }
  packets.sort((a,b)=>a.id.localeCompare(b.id));
  if(packets.length+blocked.size!==cases.length){
    throw new Error("Unmatched report exclusions or changed sample IDs");
  }
  return {
    packets,
    manifest:{
      status:"UNVERIFIED_DEV_REVIEW_PACKET",
      original:cases.length,excluded:blocked.size,retained:packets.length,
      excludedForTrainingOverlap:report.overlap.exactTrainingMatches,
      excludedForEvaluationDuplicate:report.overlap.duplicateAmongEvaluation,
      excludedForGroupOverlap:report.overlap.groupOverlapWithTraining,
      independentHumanReviewVerified:false,modelTrainingAuthorized:false,
      releaseAuthorized:false,
    }
  };
}
