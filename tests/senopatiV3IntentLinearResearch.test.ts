import {describe,expect,it} from "vitest";
import {
  planLinearIntentDevelopmentSplit,applyLinearIntentDevelopmentPlan,
  IntentV3LinearResearch,
} from "../src/core/senopatiV3IntentLinearResearch.js";
import {assessIntentV3Candidate,type IntentTrainingRow} from "../src/core/senopatiV2IntentCandidateResearch.js";
const corpusHash="a".repeat(64);
function examples():IntentTrainingRow[]{
  const intents=["chat","ask","research","draft","create","modify","execute","approve","reject"] as const;
  return intents.flatMap((intent,c)=>
    Array.from({length:30},(_,i)=>({
      id:"case-"+c+"-"+i,
      group:"grp-"+intent+"-"+Math.floor(i/2),
      text:`word${c} unique${i} request intent${intent} Indonesian English`,
      context:intent==="approve"?"PLANNING_PENDING":"",
      intent,
      domain:"conversation",action:"answer",risk:"safe",approval:"none"
    }))
  );
}
describe("Senopati V3 linear research split preregistration",()=>{
  it("disallows training until a deterministic group-frozen plan matches",()=>{
    const rows=examples(),plan=planLinearIntentDevelopmentSplit(rows,corpusHash);
    expect(plan.status).toBe("DEVELOPMENT_SPLIT_PRE_REGISTERED");
    expect(plan.createdBeforeTraining).toBe(true);
    expect(plan.releaseAuthorized).toBe(false);
    const parts=applyLinearIntentDevelopmentPlan(rows,corpusHash,plan);
    const groups=(rows:IntentTrainingRow[])=>new Set(rows.map(r=>r.group));
    const train=groups(parts.train),validation=groups(parts.validation),test=groups(parts.test);
    for(const g of train){expect(validation.has(g)).toBe(false);expect(test.has(g)).toBe(false);}
    for(const g of validation)expect(test.has(g)).toBe(false);
    expect(parts.train.length+parts.validation.length+parts.test.length).toBe(rows.length);
    const reordered=planLinearIntentDevelopmentSplit([...rows].reverse(),corpusHash);
    expect(reordered).toEqual(plan);
  });
  it("rejects mutated manifest assignments, source SHA, or claimed release flags",()=>{
    const rows=examples(),plan=planLinearIntentDevelopmentSplit(rows,corpusHash);
    expect(()=>applyLinearIntentDevelopmentPlan(rows,"b".repeat(64),plan)).toThrow();
    const altered=structuredClone(plan);
    const group=Object.keys(altered.groupAssignment)[0];
    altered.groupAssignment[group]="test";
    expect(()=>applyLinearIntentDevelopmentPlan(rows,corpusHash,altered)).toThrow(/changed/);
    expect(()=>applyLinearIntentDevelopmentPlan(rows,corpusHash,{...plan,releaseAuthorized:true} as any)).toThrow();
    expect(()=>applyLinearIntentDevelopmentPlan(rows,corpusHash,{...plan,planDigest:"0".repeat(64)})).toThrow();
  });
  it("rejects cross-partition duplicate prompts independently of group metadata",()=>{
    const rows=examples(),plan=planLinearIntentDevelopmentSplit(rows,corpusHash);
    const trainRow=rows.find(r=>plan.groupAssignment[r.group]==="train")!;
    const testIndex=rows.findIndex(r=>plan.groupAssignment[r.group]==="test");
    const same=[...rows];
    same[testIndex]={...same[testIndex],text:trainRow.text,context:trainRow.context};
    expect(()=>planLinearIntentDevelopmentSplit(same,corpusHash)).toThrow(/Cross-split duplicate/);
  });
});
describe("Senopati intent V3 linear candidate",()=>{
  it("fits deterministically without allowing automatic tool permission",()=>{
    const rows=examples(),plan=planLinearIntentDevelopmentSplit(rows,corpusHash);
    const {train,validation}=applyLinearIntentDevelopmentPlan(rows,corpusHash,plan);
    const params={learningRate:0.12,epochs:12,l2:0.002,balanceClasses:true};
    const modelA=new IntentV3LinearResearch(params).fit(train);
    const modelB=new IntentV3LinearResearch(params).fit([...train].reverse());
    expect(modelA.stats().vocabulary).toBeGreaterThan(10);
    for(const row of validation.slice(0,12)){
      const a=modelA.predict(row.text,row.context);
      const b=modelB.predict(row.text,row.context);
      expect(a).toEqual(b);
      expect(a.authorizesExecution).toBe(false);
      expect(a.relativeScore).toBeGreaterThan(0);
      expect(a.relativeScore).toBeLessThanOrEqual(1);
    }
  });
  it("blocks invalid inference, invalid hyperparameters and rejects regressions",()=>{
    expect(()=>new IntentV3LinearResearch({learningRate:900,epochs:12,l2:0,balanceClasses:false})).toThrow();
    const model=new IntentV3LinearResearch({learningRate:0.04,epochs:12,l2:0,balanceClasses:false});
    expect(()=>model.predict("hello")).toThrow(/Invalid/);
    model.fit(examples());
    expect(()=>model.predict("z".repeat(8193))).toThrow(/Invalid/);
    const gate=assessIntentV3Candidate(
      {accuracy:.7,macroF1:.63,minorityMacroF1:.60},
      {accuracy:.67,macroF1:.59,minorityMacroF1:.54}
    );
    expect(gate.status).toBe("REJECTED_ON_GROUP_TEST");
    expect(gate.productionPromotionAuthorized).toBe(false);
  });
});
