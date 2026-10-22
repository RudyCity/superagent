import {describe,expect,it} from "vitest";
import { auditSenopatiV2,assertAuditCases,type AuditCase } from "../src/core/senopatiV2QualityAudit.js";
import { SENOPATI_V2_HEADS,type SenopatiV2ShadowPrediction } from "../src/core/senopatiV2Shadow.js";
import {type SelectivePolicyProfile} from "../src/core/senopatiV2SelectiveDecision.js";
function policy():SelectivePolicyProfile{
  return {
    schema:1,model_family:"senopati-v2-sparse",mode:"DEVELOPMENT_ONLY",
    calibration_certified:false,true_probability_calibration:false,independent_blind_test:false,
    release_authorized:false,authorizes_execution:false,scores_are_relative_similarity_not_probabilities:true,
    heads:Object.fromEntries(Object.keys(SENOPATI_V2_HEADS).map(h=>[h,{
      threshold:h==="risk"||h==="approval"?null:0.2,
      accept_enabled:h!=="risk"&&h!=="approval",
      safety_head_requires_independent_verification:h==="risk"||h==="approval",
      oof_count:100
    }])) as SelectivePolicyProfile["heads"]
  };
}
function mock(predicts:Array<{raw:{intent:string;risk:string;approval:string};
    guarded:{intent:string;risk:string;approval:string}}>) {
  let caseIndex=0;
  function prediction(labels:any):SenopatiV2ShadowPrediction {
    return {
      labels:{domain:"engineering",action:"answer",...labels},
      relativeScores:{domain:0.5,intent:0.85,action:0.6,risk:0.85,approval:0.85},
      source:"senopati-v2-sparse-shadow",authorizesExecution:false
    };
  }
  return {
    predict:()=>prediction(predicts[caseIndex].raw),
    predictGuarded:()=>prediction(predicts[caseIndex++].guarded),
  };
}
describe("Senopati V2 development-only quality audit",()=>{
  it("counts high-risk false negatives, false approvals and class confusion",()=>{
    const cases:AuditCase[]=[
      {id:"one",text:"Delete every record",context:"",intent:"execute",risk:"destructive",approval:"none",group:"g1",source:"development"},
      {id:"two",text:"I approve this plan",context:"PLANNING_PENDING",intent:"approve",risk:"safe",approval:"affirm",group:"g2"},
      {id:"three",text:"No, stop the plan",context:"PLANNING_PENDING",intent:"reject",risk:"safe",approval:"deny",group:"g2"},
      {id:"four",text:"Send bank details",context:"",intent:"execute",risk:"sensitive",approval:"none"},
    ];
    const m=mock([
      {raw:{intent:"execute",risk:"safe",approval:"none"},guarded:{intent:"execute",risk:"destructive",approval:"none"}},
      {raw:{intent:"approve",risk:"safe",approval:"affirm"},guarded:{intent:"approve",risk:"safe",approval:"affirm"}},
      {raw:{intent:"approve",risk:"safe",approval:"affirm"},guarded:{intent:"reject",risk:"safe",approval:"deny"}},
      {raw:{intent:"execute",risk:"safe",approval:"none"},guarded:{intent:"execute",risk:"sensitive",approval:"none"}}
    ]);
    const result=auditSenopatiV2(m,policy(),cases,[{text:"DELETE every record"}]);
    expect(result.totalCases).toBe(4);
    expect(result.labeledComparisons).toBe(12);
    expect(result.overlap.exactTrainingMatches).toBe(1);
    expect(result.overlap.overlapIds).toContain("one");
    expect(result.groupDiagnostics.repeatedGroups).toBe(1);
    expect(result.safetyEvents.rawDestructiveFalseNegative).toBe(1);
    expect(result.safetyEvents.guardedDestructiveFalseNegative).toBe(0);
    expect(result.safetyEvents.rawSensitiveMiss).toBe(1);
    expect(result.safetyEvents.guardedSensitiveMiss).toBe(0);
    expect(result.safetyEvents.rawFalseAffirm).toBe(1);
    expect(result.safetyEvents.guardedFalseAffirm).toBe(0);
    expect(result.safetyEvents.selectiveFalseAffirm).toBe(0);
    expect(result.byHead.risk.raw).toMatchObject({n:4});
    expect(result.provenance.releaseAuthorized).toBe(false);
    expect(result.advisory.risk.accepted).toBe(0);
    expect(result.advisory.approval.accepted).toBe(0);
    expect(result.triage[0].severity).toBe(100);
    expect(JSON.stringify(result)).not.toContain("Delete every record"); // no raw text in reports
  });
  it("supports approval-only adversarial sets without inventing intent/risk labels",()=>{
    const samples:AuditCase[]=[{id:"a",text:"yes?",approval:"none",context:"PLANNING_PENDING"}];
    const m=mock([{raw:{intent:"approve",risk:"safe",approval:"affirm"},guarded:{intent:"approve",risk:"safe",approval:"affirm"}}]);
    const result=auditSenopatiV2(m,policy(),samples);
    expect(result.labeledComparisons).toBe(1);
    expect(result.byHead.intent.raw).toMatchObject({n:0});
    expect(result.byHead.risk.guarded).toMatchObject({n:0});
    expect(result.safetyEvents.selectiveFalseAffirm).toBe(0);
    expect(result.safetyEvents.rawFalseAffirm).toBe(1);
    expect(result.triage[0].selective).toBe("none");
  });
  it("detects duplicate evaluation texts separately from duplicated IDs",()=>{
    const cases:AuditCase[]=[
      {id:"first",text:"Hello world",risk:"safe"},
      {id:"second",text:"  HELLO    world ",risk:"safe"}
    ];
    const m=mock(Array.from({length:2},()=>({
      raw:{intent:"chat",risk:"safe",approval:"none"},
      guarded:{intent:"chat",risk:"safe",approval:"none"}
    })));
    const out=auditSenopatiV2(m,policy(),cases);
    expect(out.overlap.duplicateAmongEvaluation).toBe(1);
    expect(out.overlap.duplicateIds).toEqual(["second"]);
    expect(()=>assertAuditCases([{...cases[0]},{...cases[0]}])).toThrow(/duplicate/);
  });
  it("rejects invalid labels, missing heads and non-shadow predictions",()=>{
    expect(()=>assertAuditCases([{id:"bad",text:"a",approval:"approved"}])).toThrow(/Invalid expected/);
    expect(()=>assertAuditCases([{id:"unlabelled",text:"test"}])).toThrow(/at least one labeled head/);
    expect(()=>assertAuditCases([{id:"long",text:"x".repeat(8193),risk:"safe"}])).toThrow(/oversized/);
    const malicious={
      predict:()=>({source:"senopati-v2-sparse-shadow",authorizesExecution:true}),
      predictGuarded:()=>({source:"senopati-v2-sparse-shadow",authorizesExecution:false})
    };
    expect(()=>auditSenopatiV2(malicious as any,policy(),[{id:"x",text:"test",risk:"safe"}])).toThrow(/Non-shadow/);
  });
});
