import {describe,expect,it} from "vitest";
import {
  evaluateIntentDevelopmentThreshold,groupIntentDevelopmentSplit,wilsonLower,
  type IntentAuditSample,
} from "../src/core/senopatiV2IntentSplitExperiment.js";
import type {SenopatiV2ShadowPrediction} from "../src/core/senopatiV2Shadow.js";

function data(n=120):IntentAuditSample[]{
  return Array.from({length:n},(_,i)=>({
    id:"intent-dev-"+i,text:"unique content "+i+(i%19===0?" OVERRIDE":""),
    context:"",group:"grp-"+Math.floor(i/2),
    intent:i%2===0?"chat":"ask",
  }));
}
function fakeModel(perfect:boolean){
  const predict=(text:string,guarded=false):SenopatiV2ShadowPrediction=>{
    const m=/unique content (\d+)/.exec(text);
    const idx=m?Number(m[1]):0;
    const actual=idx%2===0?"chat":"ask";
    const label=perfect?actual:(actual==="chat"?"ask":"chat");
    const override=guarded&&text.includes("OVERRIDE")?"approve":label;
    return {
      labels:{domain:"conversation",intent:override,action:"answer",risk:"safe",approval:"none"},
      relativeScores:{domain:.8,intent:.75,action:.7,risk:.7,approval:.7},
      source:"senopati-v2-sparse-shadow",authorizesExecution:false,
    };
  };
  return {
    predict:(text:string)=>predict(text,false),
    predictGuarded:(text:string)=>predict(text,true),
  };
}
describe("intent grouped development split and threshold abstention",()=>{
  it("keeps whole groups disjoint and does not leak exact training or repeated texts",()=>{
    const cases=data(60);
    cases.push({id:"duplicate",text:cases[0].text.toUpperCase(),context:"",intent:"chat",group:"another"});
    const split=groupIntentDevelopmentSplit(cases,[{text:cases[2].text,context:""}]);
    expect(split.excludedTrainingOverlap).toBe(1);
    expect(split.excludedDuplicates).toBe(1);
    const a=new Set(split.calibration.map(x=>x.group));
    const b=new Set(split.evaluation.map(x=>x.group));
    for(const g of a)expect(b.has(g)).toBe(false);
    expect(split.calibration.length+split.evaluation.length).toBe(59);
  });
  it("never selects a threshold on uniformly wrong development predictions",()=>{
    const result=evaluateIntentDevelopmentThreshold(fakeModel(false),data());
    expect(result.chosenThreshold).toBeNull();
    expect(result.reason).toBe("NO_THRESHOLD_MEETS_DEVELOPMENT_BOUND");
    expect(result.calibration.accepted).toBe(0);
    expect(result.evaluation.accepted).toBe(0);
    expect(result.releaseAuthorized).toBe(false);
    expect(result.automaticRoutingEnabled).toBe(false);
    expect(result.confidenceCalibrated).toBe(false);
  });
  it("can fit a research-only threshold on a separate calibration partition",()=>{
    const result=evaluateIntentDevelopmentThreshold(fakeModel(true),data(200));
    expect(result.chosenThreshold).not.toBeNull();
    expect(result.calibration.wilson95Lower).toBeGreaterThanOrEqual(0.90);
    expect(result.evaluation.accepted).toBeGreaterThan(0);
    expect(result.evaluation.acceptedPrecision).toBe(1);
    expect(result.evaluation.labelOverriddenByGuard).toBeGreaterThan(0);
    expect(result.calibration.labelOverriddenByGuard).toBeGreaterThan(0);
    expect(result.overriddenIntentScoresAreNotValidConfidence).toBe(true);
    expect(result.releaseAuthorized).toBe(false);
    expect(result.authorizesExecution).toBe(false);
    expect(result.automaticRoutingEnabled).toBe(false);
  });
  it("rejects duplicate IDs and wrong/oversized input",()=>{
    const cases=data(20);
    expect(()=>groupIntentDevelopmentSplit([...cases,cases[1]])).toThrow(/duplicate/);
    expect(()=>groupIntentDevelopmentSplit([{...cases[0],intent:"unknown"},...cases.slice(1)])).toThrow(/Invalid/);
    expect(()=>groupIntentDevelopmentSplit([{...cases[0],text:"x".repeat(8193)},...cases.slice(1)])).toThrow(/Invalid/);
  });
  it("Wilson bound has expected conservative behavior at small sample sizes",()=>{
    expect(wilsonLower(0,0)).toBe(0);
    expect(wilsonLower(1,1)).toBeLessThan(.5);
    expect(wilsonLower(100,100)).toBeGreaterThan(.90);
  });
});
