import {describe,expect,it} from "vitest";
import {IntentV3NaiveBayesResearch,splitIntentResearchRows,intentMetrics,
  assessIntentV3Candidate,type IntentTrainingRow} from "../src/core/senopatiV2IntentCandidateResearch.js";

function fixture():IntentTrainingRow[]{
  const intents=["chat","ask","research","draft","create","modify","execute","approve","reject"] as const;
  return Array.from({length:180},(_,i)=>{
    const label=intents[Math.floor(i/20)];
    return {
      id:"dev-"+i,group:"template-"+label+"-"+Math.floor((i%20)/2),
      text:label+" keyword"+(i%3)+" sample-"+i,
      context:label==="approve"?"PLANNING_PENDING":"",
      intent:label,domain:"conversation",action:"answer",risk:"safe",approval:"none"
    };
  });
}
describe("Senopati V3 intent experimental training",()=>{
  it("isolates complete groups and makes deterministic splits independent of row order",()=>{
    const records=fixture();
    const first=splitIntentResearchRows(records);
    const last=splitIntentResearchRows([...records].reverse());
    const groups=(rows:IntentTrainingRow[])=>new Set(rows.map(x=>x.group));
    const a=groups(first.train),b=groups(first.validation),c=groups(first.test);
    for(const x of a){expect(b.has(x)).toBe(false);expect(c.has(x)).toBe(false);}
    for(const x of b)expect(c.has(x)).toBe(false);
    expect(first.train.length+first.validation.length+first.test.length).toBe(records.length);
    for(const key of ["train","validation","test"] as const){
      expect(first[key].map(x=>x.id).sort()).toEqual(last[key].map(x=>x.id).sort());
    }
    expect(first.datasetFingerprint).toBe(last.datasetFingerprint);
  });
  it("refuses duplicate IDs, invalid labels, and text leaked across partitions",()=>{
    const rows=fixture();
    expect(()=>splitIntentResearchRows([...rows,rows[0]])).toThrow(/duplicate/);
    expect(()=>splitIntentResearchRows([{...rows[0],intent:"unknown" as any},...rows.slice(1)])).toThrow(/Invalid/);
    const duplicated=fixture();
    const baseline=splitIntentResearchRows(duplicated);
    const fromTrain=baseline.train[0];
    const intoTest=baseline.test[0];
    const position=duplicated.findIndex(x=>x.id===intoTest.id);
    duplicated[position]={...duplicated[position],text:fromTrain.text,context:fromTrain.context};
    expect(()=>splitIntentResearchRows(duplicated)).toThrow(/Repeated normalized text/);
  });
  it("trains and predicts with bounded outputs, not execution permissions",()=>{
    const {train,validation}=splitIntentResearchRows(fixture());
    const model=new IntentV3NaiveBayesResearch({alpha:.25,priorWeight:.5,minDf:1}).fit(train);
    expect(model.stats().vocabulary).toBeGreaterThan(20);
    const result=model.predict(validation[0].text,validation[0].context);
    expect(typeof result.label).toBe("string");
    expect(result.relativeScore).toBeGreaterThan(0);
    expect(result.relativeScore).toBeLessThanOrEqual(1);
    expect(result.authorizesExecution).toBe(false);
    const metrics=intentMetrics(validation,row=>model.predict(row.text,row.context).label);
    expect(metrics.n).toBe(validation.length);
    expect(metrics.macroF1).toBeGreaterThanOrEqual(0);
    expect(metrics.accuracy).toBeLessThanOrEqual(1);
    expect(()=>model.predict("x".repeat(8193))).toThrow(/Invalid/);
  });
  it("rejects candidate with degraded macro/minority outcomes even if validation looked better",()=>{
    const baseline={macroF1:0.70,accuracy:0.76,minorityMacroF1:0.52};
    const candidate={macroF1:0.60,accuracy:0.83,minorityMacroF1:0.31};
    const gate=assessIntentV3Candidate(baseline,candidate);
    expect(gate.status).toBe("REJECTED_ON_GROUP_TEST");
    expect(gate.productionPromotionAuthorized).toBe(false);
    expect(gate.eligibleForAutomaticToolRouting).toBe(false);
  });
  it("does not grant production permission even to a synthetic perfect research candidate",()=>{
    const gate=assessIntentV3Candidate(
      {macroF1:0.60,accuracy:0.75,minorityMacroF1:0.5},
      {macroF1:0.90,accuracy:0.92,minorityMacroF1:0.8});
    expect(gate.status).toBe("FURTHER_REVIEW_ON_NEW_DATA_REQUIRED");
    expect(gate.productionPromotionAuthorized).toBe(false);
    expect(gate.blindIndependentBenchmark).toBe(false);
    expect(gate.trainingLabelsHumanVerified).toBe(false);
    expect(()=>assessIntentV3Candidate(
      {macroF1:0.6,accuracy:0.8,minorityMacroF1:0.5},
      {macroF1:Infinity,accuracy:0.8,minorityMacroF1:0.5})).toThrow(/Invalid/);
  });
});
