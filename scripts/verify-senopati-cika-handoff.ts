/**
 * Read-only acceptance check for a Cika-authored SHA256 pinned Senopati
 * shadow-only handoff. No application routing, ONNX activation or writes.
 * Existing active/previous model remains untouched (automatic rollback).
 */
import fs from "node:fs";
import crypto from "node:crypto";
import {loadShadowRegistry} from "../src/core/senopatiV2CandidateRegistry.js";
import {assessSelectiveShadow} from "../src/core/senopatiV2SelectiveDecision.js";
const args=process.argv.slice(2);
function value(flag:string){
  const i=args.indexOf(flag);
  if(i<0||!args[i+1])throw new Error("Missing argument "+flag);
  return args[i+1];
}
const metadataName=value("--handoff"),registryName=value("--registry");
function bounded(filename:string,limit:number){
  const st=fs.lstatSync(filename);
  if(!st.isFile()||st.isSymbolicLink()||st.size<=4||st.size>limit)
    throw new Error("Invalid research handoff file");
  return fs.readFileSync(filename);
}
const metadata=JSON.parse(bounded(metadataName,1024*1024).toString("utf8"));
if(metadata.schema!==1||metadata.status!=="SHA256_PINNED_RESEARCH_HANDOFF_ONLY"||
   metadata.origin!=="Cika"||metadata.registrySchema!==1||
   metadata.modelFormat!=="senopati-v2-sparse-baseline"||
   metadata.v3WeightsExported!==false||
   metadata.cikaV3ResearchGate!=="REJECTED_ON_GROUP_TEST"||
   metadata.activationAllowed!==false||metadata.automaticRoutingEnabled!==false||
   metadata.authorizesExecution!==false||metadata.publisherSignatureVerified!==false||
   metadata.calibrationCertified!==false||metadata.candidateIsIndependentGoldVerified!==false)
  throw new Error("Unapproved Cika model activation or incompatible handoff");
const rawRegistry=bounded(registryName,1024*1024);
const sha=(bytes:Buffer)=>crypto.createHash("sha256").update(bytes).digest("hex");
if(sha(rawRegistry)!==metadata.registrySha256)
  throw new Error("Cika registry bytes modified after handoff");
const loaded=loadShadowRegistry(registryName,"reference");
if(loaded.registry.model.sha256!==metadata.sourceModelSha256||
   loaded.registry.policy.sha256!==metadata.selectivePolicySha256||
   metadata.recordCount<1||metadata.recordCount>10000)
  throw new Error("Cika handoff pinned model/policy mismatch");
const prediction=loaded.model.predictGuarded(
  "Jelaskan perbedaan kedua pendekatan, jangan jalankan tindakan apa pun.","");
const observation=assessSelectiveShadow(prediction,loaded.policy);
if(prediction.authorizesExecution!==false||
   observation.authorizesExecution!==false||observation.eligibleForAutomaticToolRouting!==false||
   observation.abstain!==true||
   observation.heads.risk.advisoryAccept!==false||
   observation.heads.approval.advisoryAccept!==false)
  throw new Error("Unsafe shadow handoff");
console.log(JSON.stringify({
  status:"CIKA_SHADOW_HANDOFF_VERIFIED_READ_ONLY",
  version:metadata.version,sourceModelSha256:metadata.sourceModelSha256,
  policySha256:metadata.selectivePolicySha256,
  inferredIntent:prediction.labels.intent,
  parityToProduction:"NOT_TESTED_NOT_ACTIVATED",
  productionModelUnchanged:true,automaticRoutingEnabled:false,
  rollback:"Existing runtime remains the only active source",
  publisherSignatureVerified:false,independentGoldVerified:false,
  releaseAuthorized:false,toolAuthorization:false
},null,2));
