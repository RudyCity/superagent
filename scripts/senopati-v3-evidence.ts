/**
 * Senopati V3 local quarantined evidence workflow.
 * prepare -> sanitize and contamination-screen an externally collected,
 *            unlabelled JSONL source; generate source-bound blind packets
 * verify  -> verify signatures for two reviewers and adjudicator, then
 *            QUARANTINE agreed labels. Never authorizes retraining or release.
 *
 * Legacy development replay is supported only to exercise screening:
 *   --legacy-development forces all imported cases to remain BLOCKED.
 */
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {screenV3Intake,type IntakeRow,type ReviewPacket} from "../src/core/senopatiV3EvidenceIntake.js";
import {verifySenopatiV3ReviewEvidence,type SignedReview,type ReviewRoster} from "../src/core/senopatiV3SignedReview.js";
import {auditV3QuarantinedCoverage,type V3PartitionPlan} from "../src/core/senopatiV3CoverageAudit.js";
const args=process.argv.slice(2);
const mode=args[0];
if(mode!=="prepare"&&mode!=="verify")throw new Error("Usage: bun scripts/senopati-v3-evidence.ts prepare|verify");
function value(flag:string,optional=false):string{
  const i=args.indexOf(flag);
  if(i<0){if(optional)return "";throw new Error("Missing "+flag);}
  if(!args[i+1])throw new Error("Empty "+flag);
  return args[i+1];
}
function any(flag:string):string[]{
  const values:string[]=[];
  for(let i=0;i<args.length;i++)if(args[i]===flag&&args[i+1])values.push(args[i+1]);
  return values;
}
const out=path.resolve(value("--out"));
const safeRoot=path.resolve("build","superagent","quality")+path.sep;
if(!out.startsWith(safeRoot)||!out.endsWith(".json"))
  throw new Error("Evidence outputs must be ignored local JSON files under build/superagent/quality/");
function load(file:string,max=5*1024*1024):Buffer{
  const st=fs.statSync(file);
  if(!st.isFile()||st.size<1||st.size>max)throw new Error("Unbounded evidence input file");
  return fs.readFileSync(file);
}
function jsonl(file:string,maxLines=10000):unknown[]{
  const lines=load(file).toString("utf8").split(/\r?\n/).filter(Boolean);
  if(lines.length===0||lines.length>maxLines)throw new Error("Invalid evidence row count");
  return lines.map(line=>JSON.parse(line));
}
function digest(bytes:Buffer){return createHash("sha256").update(bytes).digest("hex");}
function createAll(entries:Array<{filename:string;content:string}>){
  for(const item of entries){
    if(fs.existsSync(item.filename))throw new Error("Existing evidence output must not be overwritten: "+item.filename);
    if(!path.resolve(item.filename).startsWith(safeRoot))throw new Error("Evidence output path not allowed");
  }
  fs.mkdirSync(path.dirname(out),{recursive:true,mode:0o700});
  const saved:string[]=[];
  try{
    for(const item of entries){
      fs.writeFileSync(item.filename,item.content,{flag:"wx",mode:0o600});
      saved.push(item.filename);
    }
  }catch(e){
    // Only files just created by this invocation may be removed.
    for(const file of saved)fs.unlinkSync(file);
    throw e;
  }
}
if(mode==="prepare"){
  const source=value("--source");
  const legacy=args.includes("--legacy-development");
  const sourceBytes=load(source);
  const raw=jsonl(source);
  const inputs:IntakeRow[]=raw.map((item,i)=>{
    if(!item||typeof item!=="object"||Array.isArray(item))throw new Error("Malformed intake row "+i);
    const r=item as Record<string,unknown>;
    if(legacy){
      // Historical reviewer packets must never masquerade as fresh data.
      return {id:r.id,text:r.text,context:r.context??"",language:"mixed",
        group:"old-review-"+String(r.id),source:"prior-inspected-development",
        origin:"historical_development_replay"} as IntakeRow;
    }
    return r as IntakeRow;
  });
  const referencesPaths=any("--reference");
  if(!referencesPaths.length||referencesPaths.length>10)throw new Error("Supply 1–10 --reference historical JSONL corpora");
  const references:Array<{text:string;context?:string;group?:string}>=[];
  const referenceDigests=[];
  for(const file of referencesPaths){
    const bytes=load(file);
    referenceDigests.push({name:path.basename(file),sha256:digest(bytes)});
    for(const item of jsonl(file)){
      const row=item as {text:string;context?:string;group?:string};
      references.push(row);
    }
  }
  const screened=screenV3Intake(inputs,references);
  const root=out.replace(/\.json$/,"");
  const packetPath=root+"_reviewer_packet.jsonl";
  const blockedPath=root+"_screening_exclusions.json";
  const planPath=root+"_sealed_partition_plan.json";
  const manifest={
    ...screened.manifest,
    originalSource:{name:path.basename(source),sha256:digest(sourceBytes),legacyDevelopment:legacy},
    contaminationReferences:referenceDigests,
    blindedPacketBasename:path.basename(packetPath),
    exclusionReportBasename:path.basename(blockedPath),
    sealedPartitionPlanBasename:path.basename(planPath),
    identityAttestationAvailable:false,
    dataCollectionIndependentlyVerified:false,
    sourceConsentExternallyVerified:false,
  };
  createAll([
    {filename:out,content:JSON.stringify(manifest,null,2)+"\n"},
    {filename:packetPath,content:screened.packet.map(row=>JSON.stringify(row)).join("\n")+(screened.packet.length?"\n":"")},
    {filename:blockedPath,content:JSON.stringify(screened.blocked,null,2)+"\n"},
    {filename:planPath,content:JSON.stringify({
      schema:1,status:"UNVERIFIED_FROZEN_DEVELOPMENT_PARTITIONS",
      partitionPlan:screened.internalPartitionPlan,
      digest:screened.manifest.reviewSetDigest,
      sourcePacketHash:screened.manifest.packetHash,
      releaseAuthorized:false,
    },null,2)+"\n"},
  ]);
  console.log(JSON.stringify({
    status:"QUARANTINE_ONLY",received:manifest.received,
    reviewersAuthenticated:0,acceptedForBlindReview:manifest.acceptedForBlindReview,
    excluded:manifest.excluded,blockedByReason:manifest.blockedByReason,
    packetPath,manifestPath:out,releaseAuthorized:false,trainingAuthorized:false,
  },null,2));
}else{
  const manifest=JSON.parse(load(value("--manifest")).toString("utf8"));
  const packet=jsonl(value("--packet")) as ReviewPacket[];
  const roster=JSON.parse(load(value("--roster")).toString("utf8")) as ReviewRoster;
  const reviewA=JSON.parse(load(value("--a")).toString("utf8")) as SignedReview;
  const reviewB=JSON.parse(load(value("--b")).toString("utf8")) as SignedReview;
  const adjFile=value("--adjudication",true);
  const adjudication=adjFile?JSON.parse(load(adjFile).toString("utf8")) as SignedReview:undefined;
  const result=verifySenopatiV3ReviewEvidence(packet,manifest,roster,reviewA,reviewB,adjudication);
  const planFile=value("--plan",true);
  const coverage=planFile?auditV3QuarantinedCoverage(packet,manifest,
    JSON.parse(load(planFile).toString("utf8")) as V3PartitionPlan,result):null;
  const audited={...result,...(coverage?{coverage}:{}),releaseAuthorized:false,trainingAuthorized:false};
  createAll([{filename:out,content:JSON.stringify(audited,null,2)+String.fromCharCode(10)}]);
  console.log(JSON.stringify({
    status:result.status,requests:result.counts.requests,
    agreement:result.counts.agreements,disagreement:result.counts.disagreements,
    adjudicated:result.counts.adjudicated,unresolved:result.counts.unresolved,
    reviewerSignaturesVerified:true,
    coverageInsufficientOrUnverified:coverage?!coverage.coverageRequirementsMet:true,
    identitiesIndependentlyAuthenticated:false,trainingAuthorized:false,releaseAuthorized:false,
    output:out
  },null,2));
}
