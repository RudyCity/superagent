import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createShadowRegistry, loadShadowRegistry } from "../src/core/senopatiV2CandidateRegistry.js";
import { assessSelectiveShadow, validateSelectiveProfile, type SelectivePolicyProfile } from "../src/core/senopatiV2SelectiveDecision.js";
import { SENOPATI_V2_HEADS, SenopatiV2Shadow } from "../src/core/senopatiV2Shadow.js";

function modelData(){
  return {
    format: "senopati-v2-sparse-baseline", deployment: "candidate-only",
    heads: Object.fromEntries(Object.entries(SENOPATI_V2_HEADS).map(([k,v])=>[k,[...v]])),
    records:[
      {features: {"w:message":3,"w:hello":3},
       domain:"conversation", intent:"chat",action:"answer",risk:"safe",approval:"none"}
    ],
  };
}
function policy():SelectivePolicyProfile {
  return {
    schema:1,model_family:"senopati-v2-sparse",
    mode:"DEVELOPMENT_ONLY",calibration_certified:false,
    true_probability_calibration:false,independent_blind_test:false,
    release_authorized:false,authorizes_execution:false,
    scores_are_relative_similarity_not_probabilities:true,
    heads:Object.fromEntries(Object.keys(SENOPATI_V2_HEADS).map(h=>[
      h,{threshold:h==="risk"||h==="approval"?null:0.2,
         accept_enabled:h!=="risk"&&h!=="approval",
         safety_head_requires_independent_verification:h==="risk"||h==="approval",
         oof_count:100}])) as SelectivePolicyProfile["heads"],
  };
}
const tmpDirs:string[]=[];
function fixtures(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"senopati-selective-"));
  tmpDirs.push(root);
  const m=path.join(root,"model.json"),p=path.join(root,"policy.json"),r=path.join(root,"registry.json");
  fs.writeFileSync(m,JSON.stringify(modelData()));
  fs.writeFileSync(p,JSON.stringify(policy()));
  return {m,p,r};
}
afterEach(()=>{
  for(const p of tmpDirs.splice(0))fs.rmSync(p,{recursive:true,force:true});
});

describe("Senopati V2 selective shadow calibration guards",()=>{
  it("retains abstain and tool authorization false even with strong relative scores",()=>{
    const model=new SenopatiV2Shadow(modelData() as any);
    const decision=assessSelectiveShadow(model.predict("hello"),policy());
    expect(decision.abstain).toBe(true);
    expect(decision.authorizesExecution).toBe(false);
    expect(decision.eligibleForAutomaticToolRouting).toBe(false);
    expect(decision.heads.risk.abstain).toBe(true);
    expect(decision.heads.approval.abstain).toBe(true);
    expect(decision.confidenceCalibrated).toBe(false);
    expect(decision.heads.domain.relativeScore).toBeGreaterThan(0);
  });
  it("rejects claimed independent calibration or release",()=>{
    for(const [key,value] of [["calibration_certified",true],["release_authorized",true],["independent_blind_test",true],["authorizes_execution",true]] as const){
      expect(()=>validateSelectiveProfile({...policy(),[key]:value})).toThrow();
    }
  });
  it("rejects safety head acceptance even if someone edits the profile",()=>{
    const p=policy();
    p.heads.risk={...p.heads.risk,threshold:0.01,accept_enabled:true};
    expect(()=>validateSelectiveProfile(p)).toThrow(/Safety head acceptance/);
    const q=policy();
    q.heads.approval={...q.heads.approval,threshold:0,accept_enabled:true};
    expect(()=>validateSelectiveProfile(q)).toThrow(/Safety head acceptance/);
  });
  it("rejects impossible relative score and unsafe model classification",()=>{
    const model=new SenopatiV2Shadow(modelData() as any);
    const prediction=model.predict("hello");
    expect(()=>assessSelectiveShadow({
      ...prediction,relativeScores:{...prediction.relativeScores,risk:1.2}},policy())).toThrow();
    expect(()=>assessSelectiveShadow({...prediction,authorizesExecution:true} as any,policy())).toThrow();
  });
  it("creates an immutable hash-pinned registry, never production routing",()=>{
    const {m,p,r}=fixtures();
    fs.writeFileSync(r,JSON.stringify(createShadowRegistry(m,p)));
    const loaded=loadShadowRegistry(r);
    expect(loaded.registry.status).toBe("SHADOW_ONLY");
    expect(loaded.registry.automaticRoutingEnabled).toBe(false);
    expect(loaded.registry.authorizesExecution).toBe(false);
    expect(loaded.model.predict("hello").authorizesExecution).toBe(false);
  });
  it("rejects edited model weights after registry creation",()=>{
    const {m,p,r}=fixtures();
    fs.writeFileSync(r,JSON.stringify(createShadowRegistry(m,p)));
    fs.appendFileSync(m," ");
    expect(()=>loadShadowRegistry(r)).toThrow(/hash mismatch/);
  });
  it("rejects edited profile after registry creation",()=>{
    const {m,p,r}=fixtures();
    fs.writeFileSync(r,JSON.stringify(createShadowRegistry(m,p)));
    fs.appendFileSync(p," ");
    expect(()=>loadShadowRegistry(r)).toThrow(/hash mismatch/);
  });
  it("rejects registry promoting model to automatic routing",()=>{
    const {m,p,r}=fixtures();
    const value=createShadowRegistry(m,p);
    fs.writeFileSync(r,JSON.stringify({...value,automaticRoutingEnabled:true}));
    expect(()=>loadShadowRegistry(r)).toThrow(/shadow-only/);
  });
  it("rejects profile unsafe at registration time",()=>{
    const {m,p}=fixtures();
    fs.writeFileSync(p,JSON.stringify({...policy(),calibration_certified:true}));
    expect(()=>createShadowRegistry(m,p)).toThrow(/Unapproved/);
  });
});
