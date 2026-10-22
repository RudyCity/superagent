/**
 * Local reviewer-blind packet from inspected development data.
 * Exact source file digests must match the quality report; no weak labels,
 * truth labels, prioritization or model predictions are included.
 */
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {prepareQualityBlindReview} from "../src/core/senopatiV2BlindReviewPacket.js";
import type {AuditCase,QualityAuditResult} from "../src/core/senopatiV2QualityAudit.js";

const argv=process.argv.slice(2);
function opt(flag:string):string{
  const index=argv.indexOf(flag);
  if(index<0||!argv[index+1])throw new Error("Missing "+flag);
  return argv[index+1];
}
const auditPath=opt("--audit"),out=path.resolve(opt("--out"));
const safeRoot=path.resolve("build","superagent","quality")+path.sep;
if(!out.startsWith(safeRoot)||!out.endsWith(".jsonl"))throw new Error("Blind packet must be in ignored quality directory");
const report=JSON.parse(fs.readFileSync(auditPath,"utf8"));
if(report.status!=="UNVERIFIED_DEVELOPMENT_QUALITY_AUDIT"||
  report.releaseAuthorized!==false||report.independentBlindBenchmark!==false)
  throw new Error("Quality report is not an unverified development audit");
const fileSpecs:string[]=[];
for(let i=0;i<argv.length;i++)if(argv[i]==="--set"&&argv[i+1])fileSpecs.push(argv[i+1]);
if(fileSpecs.length!==report.sources.length)throw new Error("Sources must match audit report exactly");
const sources=new Map<string,{sha256:string;fileBasename:string}>();
for(const source of report.sources){
  if(sources.has(source.datasetName))throw new Error("Duplicate report source");
  sources.set(source.datasetName,source);
}
const inputs:AuditCase[]=[];
const consumed=new Set<string>();
for(const raw of fileSpecs){
  const pos=raw.indexOf("=");
  if(pos<1)throw new Error("Invalid --set NAME=PATH");
  const name=raw.slice(0,pos),filename=raw.slice(pos+1);
  const expected=sources.get(name);
  if(!expected||consumed.has(name))throw new Error("Unrecognized/duplicate source label");
  consumed.add(name);
  const bytes=fs.readFileSync(filename);
  if(bytes.length>5*1024*1024||path.basename(filename)!==expected.fileBasename||
     createHash("sha256").update(bytes).digest("hex")!==expected.sha256)
    throw new Error("Review source has changed since audit: "+name);
  const lines=bytes.toString("utf8").split(/\r?\n/).filter(Boolean);
  if(lines.length===0||lines.length>10000)throw new Error("Invalid review source size");
  for(const line of lines){
    const sample=JSON.parse(line);
    inputs.push(sample);
  }
}
const result=prepareQualityBlindReview(inputs,report.combined as QualityAuditResult);
const contents=result.packets.map(x=>JSON.stringify(x)).join("\n")+"\n";
const second=out.endsWith("_reviewer_a.jsonl") ? out.replace(/_reviewer_a\.jsonl$/,"_reviewer_b.jsonl") : out.replace(/\.jsonl$/,"_reviewer_b.jsonl");
const manifestFile=out.replace(/\.jsonl$/,"_manifest.json");
const manifest={...result.manifest,sourceAuditBasename:path.basename(auditPath),
  sourceAuditSha256:createHash("sha256").update(fs.readFileSync(auditPath)).digest("hex"),
  separateAuthenticatedReviewers:0,
  teacherLabelsExposed:false,
  packetSha256:createHash("sha256").update(contents).digest("hex"),
};
const outputs:[[string,string],[string,string],[string,string]]=[
  [out,contents],[second,contents],[manifestFile,JSON.stringify(manifest,null,2)+"\n"]
];
for(const [filename,value] of outputs){
  if(fs.existsSync(filename)&&fs.readFileSync(filename,"utf8")!==value)
    throw new Error("Refusing to overwrite changed existing blind review packet "+filename);
}
fs.mkdirSync(path.dirname(out),{recursive:true});
for(const [filename,value] of outputs)if(!fs.existsSync(filename))
  fs.writeFileSync(filename,value,{flag:"wx"});
console.log(JSON.stringify({
  status:manifest.status,requested:manifest.original,excluded:manifest.excluded,
  packets:manifest.retained,reviewerIdentitiesAuthenticated:0,
  trainingAllowed:false,releaseAuthorized:false,
  primary:out,second,manifest:manifestFile
},null,2));
