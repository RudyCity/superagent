import { describe, expect, it } from "vitest";
import { SenopatiV2Shadow, SENOPATI_V2_HEADS, extractSenopatiV2SparseFeatures } from "../src/core/senopatiV2Shadow.js";
import { SenopatiV2CompactShadow } from "../src/core/senopatiV2CompactShadow.js";
import { validateSenopatiV2CompactCandidate } from "../src/core/senopatiV2CandidateValidation.js";

function payload(){
  return {
    format:"senopati-v2-sparse-baseline" as const,
    deployment:"candidate-only" as const,
    heads:Object.fromEntries(Object.entries(SENOPATI_V2_HEADS).map(([k,v])=>[k,[...v]])) as any,
    records:[
      {features:extractSenopatiV2SparseFeatures("message tulis email profesional"),
       domain:"writing",intent:"draft",action:"answer",risk:"safe",approval:"none"},
      {features:extractSenopatiV2SparseFeatures("context PLANNING_PENDING message iya"),
       domain:"conversation",intent:"approve",action:"none",risk:"safe",approval:"affirm"},
    ],
  };
}
describe("Compact schema validator against original Senopati reference",()=>{
  it("accepts the reference candidate and preserves the same output",()=>{
    const data=payload();
    expect(()=>validateSenopatiV2CompactCandidate(data)).not.toThrow();
    const a=new SenopatiV2Shadow(data as any);
    const b=new SenopatiV2CompactShadow(data as any);
    for(const text of ["tulis email profesional","iya","no match",""]){
      for(const context of ["","PLANNING_PENDING"]){
        const expected=a.predictGuarded(text,context),actual=b.predictGuarded(text,context);
        expect(actual).toEqual(expected);
        expect(actual.authorizesExecution).toBe(false);
      }
    }
  });
  it("rejects the same dangerous or malformed schemas as the reference",()=>{
    const badCases:any[]=[
      null, {}, {...payload(),deployment:"production"},
      {...payload(),heads:{...payload().heads,risk:["destructive","sensitive","safe"]}},
      {...payload(),records:[]},
      {...payload(),records:[{...payload().records[0],domain:"made_up"}]},
      {...payload(),records:[{...payload().records[0],features:{"q:invalid":1}}]},
      {...payload(),records:[{...payload().records[0],features:{"w:bad":11}}]},
      {...payload(),records:[{...payload().records[0],features:{"w:bad":-1}}]},
      {...payload(),records:[{...payload().records[0],features:{"w:bad":Infinity}}]},
      {...payload(),records:[{...payload().records[0],features:Object.fromEntries(Array.from({length:601},(_,i)=>["w:key"+i,1]))}]},
    ];
    for(const bad of badCases){
      expect(()=>new SenopatiV2Shadow(bad)).toThrow();
      expect(()=>validateSenopatiV2CompactCandidate(bad)).toThrow();
      expect(()=>new SenopatiV2CompactShadow(bad)).toThrow();
    }
  });
  it("does not grant tool authority or change input candidate records",()=>{
    const obj=payload();
    const before=JSON.stringify(obj);
    validateSenopatiV2CompactCandidate(obj);
    const compact=new SenopatiV2CompactShadow(obj as any);
    expect(JSON.stringify(obj)).toBe(before);
    expect(compact.predictGuarded("iya","PLANNING_PENDING").authorizesExecution).toBe(false);
  });
});
