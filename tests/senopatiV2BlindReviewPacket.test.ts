import {describe,expect,it} from "vitest";
import {prepareQualityBlindReview} from "../src/core/senopatiV2BlindReviewPacket.js";
import type {AuditCase,QualityAuditResult} from "../src/core/senopatiV2QualityAudit.js";

const cases:AuditCase[]=[
  {id:"train",text:"Do not delete anything",context:"",risk:"safe"},
  {id:"duplicate",text:"Maybe later",approval:"conditional",context:"PLANNING_PENDING"},
  {id:"unique-b",text:"Do a security review",intent:"research",risk:"safe",approval:"none"},
  {id:"group",text:"Please summarize",intent:"ask",context:""},
  {id:"unique-a",text:"Yes—but only after review",context:"PLANNING_PENDING",approval:"conditional"},
];
function report():QualityAuditResult {
  return {
    schema:1,status:"DEVELOPMENT_DIAGNOSTIC_ONLY",
    totalCases:5,labeledComparisons:8,
    provenance:{unverified:true,independentBlindEvidence:false,
      humanAdjudicationVerified:false,releaseAuthorized:false},
    overlap:{exactTrainingMatches:1,duplicateAmongEvaluation:1,groupOverlapWithTraining:1,
      overlapIds:["train"],duplicateIds:["duplicate"],groupOverlapIds:["group"]},
    byHead:{},safetyEvents:{
      rawFalseAffirm:0,guardedFalseAffirm:0,selectiveFalseAffirm:0,
      rawDestructiveFalseNegative:0,guardedDestructiveFalseNegative:0,
      rawSensitiveMiss:0,guardedSensitiveMiss:0,
      experimentalSensitiveMiss:0,experimentalDestructiveFalseNegative:0,experimentalRiskFalsePositive:0,experimentalNewFalsePositive:0,experimentalRiskEscalations:0,
    },
    advisory:{},triage:[],groupDiagnostics:{groups:0,repeatedGroups:0}
  };
}
describe("Senopati quality-audit reviewer-blind packet",()=>{
  it("removes leaked/duplicate/group-overlapping samples and keeps unlabelled requests only",()=>{
    const r=prepareQualityBlindReview(cases,report());
    expect(r.manifest.original).toBe(5);
    expect(r.manifest.excluded).toBe(3);
    expect(r.manifest.retained).toBe(2);
    expect(r.packets.map(x=>x.id)).toEqual(["unique-a","unique-b"]);
    for(const p of r.packets){
      expect(p.labels).toBeNull();
      expect(p.suggested_labels_exposed).toBe(false);
      expect(p.review_status).toBe("needs_independent_review");
      expect(p.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.keys(p).sort()).toEqual([
        "context","fingerprint","id","labels","review_status","suggested_labels_exposed","text"
      ]);
    }
    expect(r.manifest.independentHumanReviewVerified).toBe(false);
    expect(r.manifest.modelTrainingAuthorized).toBe(false);
    expect(r.manifest.releaseAuthorized).toBe(false);
  });
  it("rejects forged audit release claims and a mismatched source pool",()=>{
    const ok=report();
    expect(()=>prepareQualityBlindReview(cases.slice(0,3),ok)).toThrow(/Invalid source/);
    expect(()=>prepareQualityBlindReview(cases,{...ok,status:"CERTIFIED"} as any)).toThrow(/Invalid source/);
    expect(()=>prepareQualityBlindReview(cases,{...ok,provenance:{
      ...ok.provenance,releaseAuthorized:true
    }})).toThrow(/Invalid source/);
  });
  it("binds fingerprints to exact unchanged text and context",()=>{
    const a=prepareQualityBlindReview(cases,report()).packets[0];
    const changed=cases.map(c=>({...c}));
    changed[4].text="Yes, proceed now";
    const b=prepareQualityBlindReview(changed,report()).packets[0];
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});
