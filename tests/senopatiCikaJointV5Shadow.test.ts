/**
 * Cika V5 read-only handoff verification regression tests.
 * No external model is loaded or executed. Synthetic fixtures test provenance
 * and SHA-256, not model accuracy or publisher identity.
 */
import {describe,it,expect} from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {verifyCikaV5Shadow} from "../scripts/verify-senopati-cika-joint-v5-shadow.js";

const ROOT_REL="build/senopati_v4_research/joint_v5";
const REFS=[
  "build/models/laya-multilingual/model.safetensors",
  ROOT_REL+"/manifest_v1.json",
  ROOT_REL+"/checkpoints/joint_v5_seed41/heads.safetensors",
  ROOT_REL+"/checkpoints/joint_v5_seed41/metadata.json",
  ROOT_REL+"/joint_v5_multiseed_benchmark.json",
  ROOT_REL+"/release_gate_v1.json",
];
function sha(bytes:Buffer|string) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cika-joint-v5-shadow-"));
  const write=(name:string,content:string)=>{
    const file=path.join(root,...name.split("/"));
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,content);
    return file;
  };
  const content=[
    "placeholder frozen weights, not executable",
    JSON.stringify({research_only:true,human_gold_available:false,no_historical_test_access:true}),
    "placeholder head weights, not executable",
    JSON.stringify({production_approved:false,train_partition_only:true,
      calibration_group_disjoint:true,seed:41}),
    JSON.stringify({production_approved:false,same_encoder_for_all_heads:true,
      models:{seed41:{research_only:true}}}),
    JSON.stringify({research_only:true,production_approved:false,
      automatic_routing_enabled:false,authorizes_execution:false,
      validation_quality_pass:false}),
  ];
  const files=REFS.map((name,i)=>({
    relativePath:name,sizeBytes:Buffer.byteLength(content[i]),sha256:sha(content[i]),
  }));
  REFS.forEach((rel,i)=>write(rel,content[i]));
  const handoff={
    schema:1,status:"CIKA_V5_JOINT_READ_ONLY_SHADOW_HANDOFF",
    origin:"Cika",modelFormat:"laya-modernbert-shared-encoder-three-heads",
    checkpointSeed:41,
    selectedFrom:"train_internal_calibration_not_external_validation",
    modelCheckpointHasOnlyHeadWeights:true,
    activationAllowed:false,automaticRoutingEnabled:false,
    authorizesExecution:false,authorizesDelegation:false,
    authorizesPrivateDataAccess:false,
    productionReleaseAuthorized:false,publisherSignatureVerified:false,
    isIndependentHumanGold:false,candidateChoiceValidationGatePassed:false,
    humanGoldReviewed:0,registeredOnlyForOfflineShadow:true,files,
  };
  write(ROOT_REL+"/joint_v5_shadow_handoff_v1.json",JSON.stringify(handoff));
  const cleanup=()=>fs.rmSync(root,{recursive:true,force:true});
  return {root,files,write,handoff,cleanup};
}
describe("Cika V5 neural handoff is shadow-only",()=>{
  it("accepts pinned research bytes and never authorizes actions",async()=>{
    const f=fixture();
    try{
      const result=await verifyCikaV5Shadow(f.root);
      expect(result.status).toBe("CIKA_V5_SHADOW_HANDOFF_VERIFIED_READ_ONLY");
      expect(result.releaseAuthorized).toBe(false);
      expect(result.modelLoaded).toBe(false);
      expect(result.toolAuthorization).toBe(false);
      expect(result.automaticRoutingEnabled).toBe(false);
    }finally{f.cleanup();}
  });
  it("rejects checkpoint changes after handoff",async()=>{
    const f=fixture();
    try{
      f.write(REFS[2],"modified checkpoint");
      await expect(verifyCikaV5Shadow(f.root)).rejects.toThrow();
    }finally{f.cleanup();}
  });
  it("rejects forged privileged handoff flags",async()=>{
    const f=fixture();
    try{
      for(const field of ["activationAllowed","automaticRoutingEnabled",
                          "authorizesExecution","authorizesDelegation"]){
        f.write(ROOT_REL+"/joint_v5_shadow_handoff_v1.json",
          JSON.stringify({...f.handoff,[field]:true}));
        await expect(verifyCikaV5Shadow(f.root)).rejects.toThrow();
      }
    }finally{f.cleanup();}
  });
  it("rejects path-traversing artifacts",async()=>{
    const f=fixture();
    try{
      f.write(ROOT_REL+"/joint_v5_shadow_handoff_v1.json",
        JSON.stringify({...f.handoff,files:[...f.files.slice(0,5),
          {...f.files[5],relativePath:"../escape.json"}]}));
      await expect(verifyCikaV5Shadow(f.root)).rejects.toThrow();
    }finally{f.cleanup();}
  });
  it("rejects a release gate forged even if all hashes are adjusted",async()=>{
    const f=fixture();
    try{
      const gate=JSON.stringify({research_only:true,production_approved:true,
         automatic_routing_enabled:true,authorizes_execution:true,
         validation_quality_pass:true});
      const forged=f.files.map((x,i)=>i===5?{
        ...x,sizeBytes:Buffer.byteLength(gate),sha256:sha(gate)}:x);
      f.write(REFS[5],gate);
      f.write(ROOT_REL+"/joint_v5_shadow_handoff_v1.json",
        JSON.stringify({...f.handoff,files:forged}));
      await expect(verifyCikaV5Shadow(f.root)).rejects.toThrow();
    }finally{f.cleanup();}
  });
});
