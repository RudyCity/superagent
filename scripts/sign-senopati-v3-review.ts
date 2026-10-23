/**
 * Sign Senopati V3 offline review answers on the REVIEWER'S OWN MACHINE.
 * Private key never leaves the reviewer device, is never logged, generated,
 * uploaded or persisted by this script.
 *
 * Input annotations JSONL: {"id":"...","sampleHash":"...","labels":{"intent":"...","risk":"...","approval":"..."}}
 * bun scripts/sign-senopati-v3-review.ts --manifest ... --packet ...
 *   --annotations ... --private-key /secure/path/key.pem --signer reviewer-1
 *   --out build/superagent/quality/reviewer-1-signed.json
 *
 * A valid signature does not prove independent human identity or approve
 * model training. Credentials and private keys must not be committed.
 */
import fs from "node:fs";
import path from "node:path";
import {sign,createPrivateKey,createHash} from "node:crypto";
import {canonicalReviewData,type SignedReview,type SignedLabels} from "../src/core/senopatiV3SignedReview.js";
import {checkReviewLabels,type ReviewPacket} from "../src/core/senopatiV3EvidenceIntake.js";
const args=process.argv.slice(2);
function arg(name:string){
  const i=args.indexOf(name);
  if(i<0||!args[i+1])throw new Error("Missing "+name);
  return args[i+1];
}
function file(filename:string,max=5*1024*1024){
  const stat=fs.statSync(filename);
  if(!stat.isFile()||stat.size===0||stat.size>max)throw new Error("Invalid signed-review input file");
  return fs.readFileSync(filename);
}
const manifest=JSON.parse(file(arg("--manifest")).toString("utf8"));
if(manifest.status!=="QUARANTINE_ONLY"||manifest.releaseAuthorized!==false)
  throw new Error("Only unverified, quarantined reviewer packets are signable");
const packet=file(arg("--packet")).toString("utf8").split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s)) as ReviewPacket[];
const computedPacketHash=createHash("sha256").update(packet.map(x=>JSON.stringify(x)).join("\n")+"\n").digest("hex");
if(packet.length<1||packet.length>10000||computedPacketHash!==manifest.packetHash)
  throw new Error("Changed or empty source packet");
const annotated=file(arg("--annotations")).toString("utf8").split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s)) as SignedLabels[];
const adjudication=args.includes("--adjudication");
if(annotated.length<1||(adjudication?annotated.length>packet.length:annotated.length!==packet.length))
  throw new Error("Annotation coverage does not match the source packet");
const expected=new Map(packet.map(r=>[r.id,r.sampleHash]));
const seen=new Set<string>();
for(const row of annotated){
  if(!row||seen.has(row.id)||expected.get(row.id)!==row.sampleHash||
     !checkReviewLabels(row.labels))throw new Error("Unrecognized, duplicated or invalid signed labels");
  seen.add(row.id);
}
const signer=arg("--signer");
if(!/^[-\w]{2,80}$/.test(signer))throw new Error("Invalid reviewer identifier");
const keyLocation=path.resolve(arg("--private-key"));
if(keyLocation.startsWith(path.resolve(process.cwd())+path.sep))
  throw new Error("Private key must reside OUTSIDE the project workspace");
const key=createPrivateKey(file(keyLocation,32*1024));
if(key.asymmetricKeyType!=="ed25519")throw new Error("Only Ed25519 private keys are supported");
const payload:Omit<SignedReview,"signature">={
  schema:1,packetHash:manifest.packetHash,signerId:signer,rows:annotated
};
const signature=sign(null,Buffer.from(canonicalReviewData(payload)),key).toString("base64");
const output=path.resolve(arg("--out"));
const root=path.resolve("build","superagent","quality")+path.sep;
if(!output.startsWith(root)||!output.endsWith(".json"))
  throw new Error("Signed reviewer output must be in an ignored quality JSON path");
fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});
fs.writeFileSync(output,JSON.stringify({...payload,signature},null,2)+"\n",{flag:"wx",mode:0o600});
console.log(JSON.stringify({
  status:"SIGNED_BUT_NOT_INDEPENDENTLY_AUTHENTICATED",
  signerId:signer,annotatedSamples:annotated.length,
  privateKeyStoredByScript:false,adjudicationSubmission:adjudication,
  releaseAuthorized:false,trainingAuthorized:false,
  output
},null,2));
