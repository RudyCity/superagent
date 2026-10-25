/**
 * Offline ONLY: compare Cika V5 candidate observations to the existing
 * local SuperAgent Senopati ONNX classifier without changing active routing.
 *
 * Cika Choice labels have six values, while active ONNX categories have seven.
 * Therefore we report a cross-tabulation, NOT misleading numeric parity.
 * Raw message text is never persisted to the comparison output.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  classifyWithSenopatiONNX,
  getSenopatiModelPaths,
  type ClassificationResult,
} from "../src/core/requestClassifier.js";
import {verifyCikaV5Shadow} from "./verify-senopati-cika-joint-v5-shadow.js";

const ROOT_REL="build/senopati_v4_research/joint_v5";
const hash=(x:Buffer|string)=>crypto.createHash("sha256").update(x).digest("hex");
const parseJsonl=(buffer:Buffer)=>{
  return buffer.toString("utf8").split(/\r?\n/).filter(Boolean).map(line=>{
    const parsed=JSON.parse(line);
    if(typeof parsed!=="object"||!parsed||Array.isArray(parsed))throw new Error("Invalid input object");
    return parsed as Record<string,any>;
  });
};
function boundedFile(filename:string,max:number){
  const info=fs.lstatSync(filename);
  if(!info.isFile()||info.isSymbolicLink()||info.size>max||info.size<2){
    throw new Error("Unsafe/missing shadow artifact");
  }
  return fs.readFileSync(filename);
}
function within(root:string,relative:string){
  const resolved=path.resolve(root,...relative.split("/"));
  const canonicalRoot=fs.realpathSync.native(root);
  const canonicalFile=fs.realpathSync.native(resolved);
  const rel=path.relative(canonicalRoot,canonicalFile);
  if(!rel||rel.startsWith("..")||path.isAbsolute(rel)){
    throw new Error("Research shadow file escapes Cika root");
  }
  return resolved;
}
export async function compareCikaJointV5Shadow(cikaRoot:string){
  const verification=await verifyCikaV5Shadow(cikaRoot);
  if(!getSenopatiModelPaths())throw new Error("Existing SuperAgent ONNX model missing");
  const fixturePath=within(cikaRoot,ROOT_REL+"/shadow_fixture_18.jsonl");
  const predictionPath=within(cikaRoot,ROOT_REL+"/shadow_observations/dryrun18_v1.jsonl");
  const reportPath=within(cikaRoot,ROOT_REL+"/shadow_observations/dryrun18_v1.json");
  const fixtureBuffer=boundedFile(fixturePath,150000);
  const predictionBuffer=boundedFile(predictionPath,200000);
  const report=JSON.parse(boundedFile(reportPath,100000).toString("utf8"));
  if(report.production_approved!==false||
     report.no_tool_calls!==true||
     report.no_delegation!==true||
     report.no_private_data_access!==true||
     report.no_input_text_persisted!==true||
     report.active_router_unchanged!==true||
     report.status!=="OFFLINE_RESEARCH_SHADOW_OBSERVATIONS_ONLY"){
    throw new Error("Cika candidate is not a blocked research observation");
  }
  if(hash(fixtureBuffer)!==report.data_input_sha256||
     hash(predictionBuffer)!==report.shadow_output_sha256){
    throw new Error("Shadow input/output integrity failure");
  }
  const fixture=parseJsonl(fixtureBuffer);
  const candidate=parseJsonl(predictionBuffer);
  if(fixture.length!==18||candidate.length!==18)throw new Error("Expected 18 paired research examples");
  const byId=new Map(candidate.map(row=>[row.message_id_sha256,row]));
  if(byId.size!==candidate.length)throw new Error("Duplicate candidate messages");
  const comparison:Record<string,Record<string,number>>={};
  let count=0;
  for(const row of fixture){
    if(typeof row.id!=="string"||typeof row.text!=="string"||!row.text.trim()){
      throw new Error("Invalid offline benchmark row");
    }
    const proposal=byId.get(hash(row.id));
    if(!proposal||proposal.message_sha256!==hash(row.text)||
       proposal.can_execute!==false||proposal.can_delegate!==false||
       proposal.can_access_private_data!==false||proposal.message_text_recorded!==false){
      throw new Error("Candidate missing or authorizes an action");
    }
    // Pure local ONNX inference without running the live Agent or any tools.
    const existing:ClassificationResult|null=await classifyWithSenopatiONNX(row.text);
    if(!existing)throw new Error("Cannot load existing ONNX classifier for comparison");
    const category=existing.category;
    const choice=proposal.proposed_choice_score_noul?.choice;
    if(typeof choice!=="string")throw new Error("Invalid candidate choice");
    comparison[category]??={};
    comparison[category][choice]=(comparison[category][choice]??0)+1;
    count++;
  }
  return {
    status:"OFFLINE_CIKA_V5_TO_SUPERAGENT_COMPARISON_ONLY",
    handoff:verification.status,
    n:count,
    activeOnnxCategoriesVersusCandidateChoices:comparison,
    labelsNotIdenticalSoNumericParityNotClaimed:true,
    classifiedExistingModelInReadOnlyMode:true,
    sampledFromSyntheticResearchOnly:true,
    productionRoutingModified:false,
    toolExecutionAuthorized:false,
    delegationAuthorized:false,
    privateDataAccessAuthorized:false,
    promotionAuthorized:false,
    inputTextPersistedInReport:false,
  };
}
if(import.meta.main){
  const args=process.argv.slice(2);
  const i=args.indexOf("--cika-root");
  if(i<0||!args[i+1])throw new Error("Usage: bun scripts/compare-senopati-cika-joint-v5-shadow.ts --cika-root CIKA_PATH");
  const result=await compareCikaJointV5Shadow(args[i+1]);
  // Only the count and aggregate confusion table are printed.
  console.log(JSON.stringify(result,null,2));
}
