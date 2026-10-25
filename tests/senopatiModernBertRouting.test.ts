/** Unit-level guarded mmBERT 6-class to legacy 7-category adapter tests.
 * No real tools or private data, no model downloads; active host permissions
 * are NEVER computed from classifier Choice / Score / Noul.
 */
import {describe,it,expect} from "vitest";
import {
  MODERN_MODEL, GUARDED_POLICY, LEGACY_POLICY,
  mergeModernIntent, validateModernPolicy, decodeModernPrediction,
  type ModernPrediction,
} from "../src/core/senopatiModernBert.js";
import type {ClassificationResult} from "../src/core/requestClassifier.js";

const old=(category:ClassificationResult["category"],destructive=false):ClassificationResult=>({
  category, confidence:"high", reason:"legacy original", heuristicOnly:false,
  classificationTokens:0, isDestructive:destructive, urgencyScore:4.2,
});
const candidate=(intent:ModernPrediction["intent"],confidence=.98,riskProbability=.98):ModernPrediction=>({
  intent,confidence,riskProbability,score:4.9,modelName:MODERN_MODEL,
});
describe("Senopati V6.4 guarded replacement adapter",()=>{
  it("preserves original destructive guard on all six semantic intents",()=>{
    for(const intent of ["answer","artifact","delegate","none","retrieve","tools"] as const){
      const previous=old("question",true);
      const result=mergeModernIntent(previous,candidate(intent));
      expect(result.isDestructive).toBe(true);
      expect(result.urgencyScore).toBe(4.2);
    }
  });
  it("cannot expand toolset from conversation/question into command",()=>{
    for(const oldCategory of ["conversation","question","research"] as const){
      for(const intent of ["tools","delegate","artifact","none"] as const){
        const result=mergeModernIntent(old(oldCategory),candidate(intent));
        expect(result.category).toBe(oldCategory);
      }
    }
  });
  it("never broadens conversation into research due to the new model",()=>{
    const result=mergeModernIntent(old("conversation"),candidate("retrieve"));
    expect(result.category).toBe("conversation");
  });
  it("uses stronger retrieve classification for an already read-only question",()=>{
    const result=mergeModernIntent(old("question"),candidate("retrieve"));
    expect(result.category).toBe("research");
    expect(result.secondaryCategory).toBe("question");
    expect(result.reason).toContain("intent-only");
    expect(result.isDestructive).toBe(false);
  });
  it("can map non-action research to an informational question",()=>{
    expect(mergeModernIntent(old("research"),candidate("answer")).category).toBe("question");
  });
  it("does not rewrite an existing coding/edit category",()=>{
    for(const category of ["simple_edit","complex_task","debug","command"] as const){
      const result=mergeModernIntent(old(category),candidate("answer"));
      expect(result.category).toBe(category);
    }
  });
  it("confidence gating and invalid candidate fall back to same old object",()=>{
    const previous=old("command",true);
    expect(mergeModernIntent(previous,null)).toBe(previous);
    expect(mergeModernIntent(previous,candidate("retrieve",.2))).toBe(previous);
    expect(mergeModernIntent(previous,{...candidate("retrieve"),modelName:"unverified"})).toBe(previous);
    expect(mergeModernIntent(previous,{...candidate("retrieve"),riskProbability:NaN})).toBe(previous);
  });
  it("refuses unsafe policy and permits immediate legacy rollback",()=>{
    expect(validateModernPolicy(GUARDED_POLICY)).toEqual(GUARDED_POLICY);
    expect(validateModernPolicy(LEGACY_POLICY)).toEqual(LEGACY_POLICY);
    for(const invalid of [
      {...GUARDED_POLICY, preserveLegacySafety:false},
      {...GUARDED_POLICY, noAuthorizationFromModel:false},
      {...GUARDED_POLICY, backend:"legacy",enabled:true},
      {...GUARDED_POLICY, minConfidence:-1},
      {...GUARDED_POLICY, minConfidence:2},
      {...GUARDED_POLICY, minConfidence:NaN},
      {...GUARDED_POLICY, precision:"int4_all"},
      {...GUARDED_POLICY, precision:"unverified-model"},
    ]){
      expect(()=>validateModernPolicy(invalid)).toThrow();
    }
  });
  it("quantization selection defaults safely for old policies and restricts assets",()=>{
    const prior={...GUARDED_POLICY} as Record<string,unknown>;
    delete prior.precision;
    expect(validateModernPolicy(prior)).toEqual({...GUARDED_POLICY,precision:"fp32"});
    expect(validateModernPolicy({...GUARDED_POLICY,precision:"int8_embedding"}).precision).toBe("int8_embedding");
    expect(validateModernPolicy({...GUARDED_POLICY,precision:"int4_embedding"}).precision).toBe("int4_embedding");
    expect(validateModernPolicy({...GUARDED_POLICY,precision:"fp32"}).precision).toBe("fp32");
    expect(()=>validateModernPolicy({...GUARDED_POLICY,precision:"int4_all"})).toThrow();
  });
  it("decodes three independent model heads and rejects invalid tensors",()=>{
    const decoded=decodeModernPrediction([0,0,0,0,0,10],[0,0,0,0,4],[0]);
    expect(decoded.intent).toBe("tools");
    expect(decoded.confidence).toBeGreaterThan(.9);
    expect(decoded.riskProbability).toBeCloseTo(.5);
    expect(decoded.score).toBeGreaterThan(4);
    expect(()=>decodeModernPrediction([1,2],[0,0,0,0,0],[0])).toThrow();
    expect(()=>decodeModernPrediction([0,0,0,0,0,NaN],[0,0,0,0,0],[0])).toThrow();
  });
});
