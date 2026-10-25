import {describe,it,expect} from "vitest";
import {toSenopatiEncoding,SENOPATI_MAX_TOKENS} from "../src/core/senopatiTokenizer.js";
import {validSharedPrediction} from "../src/core/senopatiSharedClient.js";
import {validateModernPolicy,GUARDED_POLICY,LEGACY_POLICY,
        mergeModernIntent,MODERN_MODEL} from "../src/core/senopatiModernBert.js";
import type {ClassificationResult} from "../src/core/requestClassifier.js";

const input=(ids:number[],active:number)=>{
 const tokens=[...ids,...Array(Math.max(0,SENOPATI_MAX_TOKENS-ids.length)).fill(0)];
 const mask=Array.from({length:SENOPATI_MAX_TOKENS},(_,i)=>i<active?1:0);
 return {tokens,mask};
};
const prediction={
 intent:"retrieve",confidence:.97,riskProbability:.04,score:3.5,
 modelName:MODERN_MODEL,
};
describe("Senopati native tokenizer and single-owner IPC boundaries",()=>{
 it("accepts exactly padded Rust/Python-compatible tokenizer ids",()=>{
  const sample=[2,64573,235269,15486,141882,235336,1];
  const {tokens,mask}=input(sample,7);
  const converted=toSenopatiEncoding(tokens,mask);
  expect(converted.inputIds.length).toBe(96);
  expect(Array.from(converted.inputIds.slice(0,7),Number)).toEqual(sample);
  expect(converted.attentionMask[7]).toBe(0n);
 });
 it("rejects missing EOS, invalid attention, token ids and invalid widths",()=>{
  const {tokens,mask}=input([2,64573,1],3);
  expect(()=>toSenopatiEncoding(tokens.slice(0,95),mask)).toThrow();
  expect(()=>toSenopatiEncoding([1,...tokens.slice(1)],mask)).toThrow();
  expect(()=>toSenopatiEncoding([2,64573,3,...tokens.slice(3)],mask)).toThrow();
  expect(()=>toSenopatiEncoding([2,256000,1,...tokens.slice(3)],mask)).toThrow();
  expect(()=>toSenopatiEncoding(tokens,[1,2,...mask.slice(2)])).toThrow();
  expect(()=>toSenopatiEncoding([2,64573,1,4,...tokens.slice(4)],mask)).toThrow();
  expect(()=>toSenopatiEncoding(tokens,[1,1,1,1,...mask.slice(4)])).toThrow();
 });
 it("rejects spoofed models, capabilities and non-finite IPC predictions",()=>{
  expect(validSharedPrediction(prediction)).toBe(true);
  for(const changed of [
   {...prediction,intent:"run_command"},
   {...prediction,modelName:"imposter"},
   {...prediction,confidence:1.3},
   {...prediction,confidence:NaN},
   {...prediction,riskProbability:-.3},
   {...prediction,score:0},
   {...prediction,score:Infinity},
   {...prediction,canExecute:true},
   null,
  ]){
   expect(validSharedPrediction(changed)).toBe(false);
  }
 });
 it("does not treat valid model scores as host tool permission",()=>{
  const legacy:ClassificationResult={
   category:"question",confidence:"medium",reason:"existing",
   heuristicOnly:false,classificationTokens:0,isDestructive:true,urgencyScore:5,
  };
  for(const intent of ["tools","delegate","retrieve"] as const){
   const result=mergeModernIntent(legacy,{...prediction,intent});
   expect(result.isDestructive).toBe(true);
   expect(result.urgencyScore).toBe(5);
   expect(["question","research"]).toContain(result.category);
  }
 });
 it("accepts shared-only mode, but refuses unsupported networks or modes",()=>{
  const enabled={...GUARDED_POLICY,inferenceMode:"shared_only"};
  expect(validateModernPolicy(enabled)).toEqual(enabled);
  const former={...GUARDED_POLICY} as Record<string,unknown>;
  delete former.inferenceMode;
  expect(validateModernPolicy(former).inferenceMode).toBe("local");
  expect(validateModernPolicy(LEGACY_POLICY).enabled).toBe(false);
  for(const invalid of [
   {...GUARDED_POLICY,inferenceMode:"http"},
   {...GUARDED_POLICY,inferenceMode:"remote"},
   {...GUARDED_POLICY,inferenceMode:123},
   {...GUARDED_POLICY,noAuthorizationFromModel:false},
  ]){
   expect(()=>validateModernPolicy(invalid)).toThrow();
  }
 });
});
