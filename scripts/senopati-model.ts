/** Manage only the guarded Senopati *intent* backend.
 * This never switches tool permissions or replaces the legacy destructive
 * command guardrail. All changes are atomic and reversible per new turn.
 *
 * bun scripts/senopati-model.ts status|activate|rollback|smoke
 */
import {
  GUARDED_POLICY, LEGACY_POLICY, getModernPolicy, setModernPolicy,
  inferModernPrediction, modernRuntimeStatus, modernPolicyFile,
  validateModernPolicy, type ModernPrecision,
} from "../src/core/senopatiModernBert.js";
import { classifyRequest } from "../src/core/requestClassifier.js";

const mode=process.argv[2]||"status";
if (!["status","activate","rollback","smoke"].includes(mode)) {
  throw new Error("Valid modes: status, activate, rollback, smoke");
}
if (mode==="rollback") {
  const p=setModernPolicy(LEGACY_POLICY);
  console.log(JSON.stringify({status:"ROLLED_BACK_TO_LEGACY",policy:p,
    configFile:modernPolicyFile(),
    keepsOriginalOnnx:true,changesToolPermissions:false},null,2));
} else if(mode==="activate") {
  const requested=process.argv[3] ?? "int8_embedding";
  if (!["fp32","int8_embedding","int4_embedding"].includes(requested)) {
    throw new Error("Supported precisions: fp32, int8_embedding, int4_embedding; full INT4 rejected due to poor semantic agreement");
  }
  const previous=getModernPolicy();
  const desired=validateModernPolicy({
    ...GUARDED_POLICY, precision: requested as ModernPrecision,
    inferenceMode: previous.inferenceMode === "shared_only" ? "shared_only" : "local",
  });
  // Each model is SHA256 validated at load and inference must succeed.
  // On failure, restore the previous precision/policy atomically.
  const p=setModernPolicy(desired);
  let sample=null;
  try {
    sample=await inferModernPrediction("Tolong cari dokumentasi proyek");
    if (!sample || sample.modelName!=="mmbert-v64-seed73-hard" ||
        !Number.isFinite(sample.confidence)) {
      throw new Error("Quantized ONNX failed trusted local inference smoke");
    }
  } catch (error) {
    setModernPolicy(previous);
    throw error;
  }
  console.log(JSON.stringify({status:"GUARDED_SEMANTIC_ROUTING_ACTIVATED",
    policy:p,selectedPrecision:requested,
    localModelSmoke:sample,configFile:modernPolicyFile(),
    originalFp32StillAvailable:true,
    onlyChangesSemanticIntent:true,legacyDestructiveGuardPreserved:true,
    classifierNeverAuthorizesTools:true,
    researchSafetyHeadProductionApproved:false},null,2));
} else if(mode==="smoke") {
  const texts=[
    "Halo, apa kabar?",
    "Tolong cari dokumentasi proyek",
    "Jelaskan kenapa mengakses data pribadi tanpa izin itu berbahaya",
    "Tolong audit proyek dan perbaiki error build",
    "rm -rf /",
  ];
  for(const text of texts){
    const result=await classifyRequest(text,undefined,{skipLLM:true});
    console.log(JSON.stringify({request:text,result:{
      category:result.category,confidence:result.confidence,
      reason:result.reason,isDestructive:result.isDestructive,
      urgencyScore:result.urgencyScore}},null,2));
  }
} else {
  console.log(JSON.stringify({policy:getModernPolicy(),
    status:modernRuntimeStatus(),configFile:modernPolicyFile()},null,2));
}
