/**
 * Verify a Cika V5 SHA256 pinned neural model handoff in READ-ONLY mode.
 *
 * No model loading, no Python launch, no automatic routing, no tool actions.
 * No production Senopati changes. A successful result only proves bytes match
 * the development manifest and release flags deny production activation.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const STATUS="CIKA_V5_JOINT_READ_ONLY_SHADOW_HANDOFF";
const REL="build/senopati_v4_research/joint_v5/joint_v5_shadow_handoff_v1.json";
const REQUIRED=[
  "build/models/laya-multilingual/model.safetensors",
  "build/senopati_v4_research/joint_v5/manifest_v1.json",
  "build/senopati_v4_research/joint_v5/checkpoints/joint_v5_seed41/heads.safetensors",
  "build/senopati_v4_research/joint_v5/checkpoints/joint_v5_seed41/metadata.json",
  "build/senopati_v4_research/joint_v5/joint_v5_multiseed_benchmark.json",
  "build/senopati_v4_research/joint_v5/release_gate_v1.json",
];
type RecordObject=Record<string,any>;
export interface ShadowHandoffVerification {
  status:"CIKA_V5_SHADOW_HANDOFF_VERIFIED_READ_ONLY";
  count:number;
  checkpointSeed:41;
  productionModelUnchanged:true;
  automaticRoutingEnabled:false;
  toolAuthorization:false;
  delegationAuthorization:false;
  privateDataAuthorization:false;
  humanGoldAvailable:false;
  releaseAuthorized:false;
  modelLoaded:false;
}
function assert(p:unknown,message:string):asserts p {
  if(!p)throw new Error("Cika V5 shadow verification rejected: "+message);
}
function obj(v:unknown):v is RecordObject {
  return typeof v==="object"&&v!==null&&!Array.isArray(v);
}
function canonical(file:string){return fs.realpathSync.native(path.resolve(file));}
function safeRelative(root:string,rel:string):string {
  assert(typeof rel==="string"&&/^[a-zA-Z0-9_.\/-]+$/.test(rel)&&!rel.startsWith("/")&&
         !rel.includes("\\")&&!rel.split("/").includes(".."),
         "bad relative path");
  const full=path.resolve(root,...rel.split("/"));
  const rootCanonical=canonical(root);
  const resolved=canonical(full);
  const relative=path.relative(rootCanonical,resolved);
  assert(relative!==""&&!relative.startsWith("..")&&!path.isAbsolute(relative),
         "path escapes Cika root");
  const st=fs.lstatSync(full);
  assert(st.isFile()&&!st.isSymbolicLink(),"symbolic link/non-file");
  return full;
}
function boundedJson(root:string,rel:string,limit=2*1024*1024):RecordObject {
  const f=safeRelative(root,rel);
  const size=fs.statSync(f).size;
  assert(size>1&&size<=limit,"bad JSON file size");
  const data=JSON.parse(fs.readFileSync(f,"utf8"));
  assert(obj(data),"invalid JSON object");
  return data;
}
async function shaFile(file:string):Promise<string> {
  const h=crypto.createHash("sha256");
  for await(const bytes of fs.createReadStream(file))h.update(bytes);
  return h.digest("hex");
}
export async function verifyCikaV5Shadow(root:string):Promise<ShadowHandoffVerification> {
  const handoff=boundedJson(root,REL,1024*1024);
  assert(handoff.schema===1&&handoff.status===STATUS&&handoff.origin==="Cika",
         "unrecognized handoff schema");
  assert(handoff.modelFormat==="laya-modernbert-shared-encoder-three-heads"&&
         handoff.checkpointSeed===41,"unknown candidate model");
  assert(handoff.selectedFrom==="train_internal_calibration_not_external_validation",
         "invalid selection provenance");
  assert(handoff.modelCheckpointHasOnlyHeadWeights===true&&
         handoff.registeredOnlyForOfflineShadow===true,"unexpected mode");
  for(const field of ["activationAllowed","automaticRoutingEnabled","authorizesExecution",
       "authorizesDelegation","authorizesPrivateDataAccess","productionReleaseAuthorized",
       "publisherSignatureVerified","isIndependentHumanGold","candidateChoiceValidationGatePassed"]) {
    assert(handoff[field]===false,"unexpected privileged field "+field);
  }
  assert(handoff.humanGoldReviewed===0,"human gold not independently audited");
  assert(Array.isArray(handoff.files)&&handoff.files.length===REQUIRED.length,
         "incomplete pinned files");
  const listed=new Map<string,RecordObject>();
  for(const entry of handoff.files){
    assert(obj(entry)&&typeof entry.relativePath==="string","invalid manifest entry");
    assert(!listed.has(entry.relativePath),"duplicate file record");
    listed.set(entry.relativePath,entry);
  }
  assert(REQUIRED.every(x=>listed.has(x)),"missing pinned required file");
  for(const rel of REQUIRED){
    const entry=listed.get(rel)!;
    assert(typeof entry.sha256==="string"&&/^[0-9a-f]{64}$/.test(entry.sha256),
           "invalid sha256 digest");
    assert(Number.isSafeInteger(entry.sizeBytes)&&entry.sizeBytes>0&&
           entry.sizeBytes<=800*1024*1024,"invalid file size");
    const f=safeRelative(root,rel);
    assert(fs.statSync(f).size===entry.sizeBytes,"file size changed: "+rel);
    assert(await shaFile(f)===entry.sha256,"file hash changed: "+rel);
  }
  const manifest=boundedJson(root,REQUIRED[1]);
  const metadata=boundedJson(root,REQUIRED[3]);
  const bench=boundedJson(root,REQUIRED[4],10*1024*1024);
  const gate=boundedJson(root,REQUIRED[5],5*1024*1024);
  assert(manifest.research_only===true&&manifest.human_gold_available===false&&
         manifest.no_historical_test_access===true,"training corpus not approved");
  assert(metadata.production_approved===false&&metadata.train_partition_only===true&&
         metadata.calibration_group_disjoint===true&&metadata.seed===41,
         "unverified research checkpoint");
  assert(bench.production_approved===false&&bench.same_encoder_for_all_heads===true&&
         obj(bench.models)&&obj(bench.models.seed41),"benchmark incompatible");
  assert(gate.research_only===true&&gate.production_approved===false&&
         gate.automatic_routing_enabled===false&&gate.authorizes_execution===false&&
         gate.validation_quality_pass===false,"release gate not explicitly blocked");
  return {
    status:"CIKA_V5_SHADOW_HANDOFF_VERIFIED_READ_ONLY",
    count:REQUIRED.length,checkpointSeed:41,
    productionModelUnchanged:true,
    automaticRoutingEnabled:false,toolAuthorization:false,
    delegationAuthorization:false,privateDataAuthorization:false,
    humanGoldAvailable:false,releaseAuthorized:false,modelLoaded:false,
  };
}
if(import.meta.main){
  const args=process.argv.slice(2);
  const idx=args.indexOf("--cika-root");
  if(idx<0||!args[idx+1])throw new Error("Usage: bun scripts/verify-senopati-cika-joint-v5-shadow.ts --cika-root CIKA_PATH");
  const report=await verifyCikaV5Shadow(args[idx+1]);
  console.log(JSON.stringify(report,null,2));
}
