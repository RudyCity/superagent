import {describe,it,expect} from "vitest";
import {spawnSync} from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createShadowRegistry} from "../src/core/senopatiV2CandidateRegistry.js";
import {SENOPATI_V2_HEADS} from "../src/core/senopatiV2Shadow.js";

const script=fileURLToPath(new URL("../scripts/verify-senopati-cika-handoff.ts",import.meta.url));
const digest=(bytes:Buffer)=>crypto.createHash("sha256").update(bytes).digest("hex");
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cika-handoff-"));
  const source=path.join(root,"model.json"),policyFile=path.join(root,"policy.json");
  const registryFile=path.join(root,"registry.json"),handoffFile=path.join(root,"handoff.json");
  const labels=Object.fromEntries(Object.entries(SENOPATI_V2_HEADS).map(([h,v])=>[h,[...v]]));
  const model={
    format:"senopati-v2-sparse-baseline",deployment:"candidate-only",heads:labels,
    records:[
      {features:{"w:message":3,"w:test":3},domain:"conversation",
        intent:"ask",action:"answer",risk:"safe",approval:"none"},
      {features:{"w:message":3,"w:jelaskan":3},domain:"knowledge",
        intent:"ask",action:"answer",risk:"safe",approval:"none"},
    ],
  };
  const policy={
    schema:1,model_family:"senopati-v2-sparse",mode:"DEVELOPMENT_ONLY",
    calibration_certified:false,true_probability_calibration:false,
    independent_blind_test:false,release_authorized:false,authorizes_execution:false,
    scores_are_relative_similarity_not_probabilities:true,
    heads:Object.fromEntries(Object.keys(SENOPATI_V2_HEADS).map(h=>[
      h,{threshold:null,accept_enabled:false,
        safety_head_requires_independent_verification:h==="risk"||h==="approval",
        oof_count:10}
    ]))
  };
  fs.writeFileSync(source,JSON.stringify(model));
  fs.writeFileSync(policyFile,JSON.stringify(policy));
  const registry=createShadowRegistry(source,policyFile);
  const raw=Buffer.from(JSON.stringify(registry));
  fs.writeFileSync(registryFile,raw);
  const handoff={
    schema:1,status:"SHA256_PINNED_RESEARCH_HANDOFF_ONLY",origin:"Cika",
    registrySchema:1,modelFormat:"senopati-v2-sparse-baseline",
    v3WeightsExported:false,cikaV3ResearchGate:"REJECTED_ON_GROUP_TEST",
    activationAllowed:false,automaticRoutingEnabled:false,authorizesExecution:false,
    publisherSignatureVerified:false,calibrationCertified:false,
    candidateIsIndependentGoldVerified:false,recordCount:2,
    registrySha256:digest(raw),sourceModelSha256:registry.model.sha256,
    selectivePolicySha256:registry.policy.sha256,version:"test-shadow-v1",
  };
  fs.writeFileSync(handoffFile,JSON.stringify(handoff));
  function invoke(){
    return spawnSync(process.execPath,[script,"--handoff",handoffFile,"--registry",registryFile],{
      cwd:process.cwd(),encoding:"utf8",windowsHide:true,timeout:15000,maxBuffer:1024*1024
    });
  }
  return {root,source,policyFile,registryFile,handoffFile,registry,handoff,invoke};
}
describe("Cika authored shadow handoff (read-only)",()=>{
  it("accepts a pinned candidate without live activation",()=>{
    const f=fixture();
    try{
      const result=f.invoke();
      expect(result.status,result.stderr).toBe(0);
      const report=JSON.parse(result.stdout);
      expect(report.status).toBe("CIKA_SHADOW_HANDOFF_VERIFIED_READ_ONLY");
      expect(report.toolAuthorization).toBe(false);
      expect(report.productionModelUnchanged).toBe(true);
      expect(report.releaseAuthorized).toBe(false);
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  });
  it("rejects tampered model, policy, registry and forged release flags",()=>{
    const f=fixture();
    try{
      fs.appendFileSync(f.source," ");
      expect(f.invoke().status).not.toBe(0);
      fs.writeFileSync(f.source,fs.readFileSync(f.source,"utf8").trimEnd());
      fs.appendFileSync(f.policyFile," ");
      expect(f.invoke().status).not.toBe(0);
      fs.writeFileSync(f.policyFile,fs.readFileSync(f.policyFile,"utf8").trimEnd());
      fs.appendFileSync(f.registryFile," ");
      expect(f.invoke().status).not.toBe(0);
      fs.writeFileSync(f.registryFile,JSON.stringify(f.registry));
      fs.writeFileSync(f.handoffFile,JSON.stringify({...f.handoff,activationAllowed:true}));
      expect(f.invoke().status).not.toBe(0);
      fs.writeFileSync(f.handoffFile,JSON.stringify({...f.handoff,cikaV3ResearchGate:"FURTHER_INDEPENDENT_REVIEW_REQUIRED"}));
      expect(f.invoke().status).not.toBe(0);
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  });
});
