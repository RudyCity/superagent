import {describe,it,expect} from "vitest";
import {generateKeyPairSync,sign,createHash} from "node:crypto";
import {screenV3Intake,type IntakeRow,type ReviewPacket} from "../src/core/senopatiV3EvidenceIntake.js";
import {
  canonicalReviewData,verifySenopatiV3ReviewEvidence,
  type ReviewRoster,type SignedReview,type SignedLabels
} from "../src/core/senopatiV3SignedReview.js";

function rows():IntakeRow[]{
  return [
    {id:"fresh-one",text:"Please create a glossary of unusual botanical taxonomy terms for my study.",
      context:"",language:"en",group:"field-study-1",source:"external-id-1",origin:"new_external_collection"},
    {id:"fresh-two",text:"Tolong bandingkan dua pendekatan pembelajaran matematika untuk murid.",
      context:"",language:"id",group:"field-study-2",source:"external-id-2",origin:"new_external_collection"},
    {id:"fresh-three",text:"Tinjau ulang ringkasan rapat tanpa mengubah file aslinya.",
      context:"",language:"id",group:"field-study-1",source:"external-id-3",origin:"new_external_collection"},
  ];
}
const hist=[
  {text:"Apa itu inflasi dan dampaknya?",context:"",group:"old-template"},
  {text:"Lihat laporan perubahan harga emas",context:""},
];
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
function setup(){
  const screened=screenV3Intake(rows(),hist);
  const keys=Array.from({length:3},(_,i)=>{
    const pair=generateKeyPairSync("ed25519");
    return {
      id:i===0?"reviewer-alpha":i===1?"reviewer-beta":"adjudicator-charlie",
      role:i===2?"adjudicator" as const:"reviewer" as const,
      publicKeyPem:pair.publicKey.export({type:"spki",format:"pem"}).toString(),
      privateKey:pair.privateKey,
    };
  });
  const roster:ReviewRoster={schema:1,
    identities:keys.map(({id,role,publicKeyPem})=>({id,role,publicKeyPem})),
    externalIdentityVerification:"not_verified"};
  function submission(index:number, overrides:Record<string,Partial<{intent:string;risk:string;approval:string}>>={}):SignedReview{
    const all:SignedLabels[]=screened.packet.map(p=>({
      id:p.id,sampleHash:p.sampleHash,
      labels:{intent:"research",risk:"safe",approval:"none",...overrides[p.id]},
    }));
    const rowsToSign=index===2?all.filter(r=>overrides[r.id]!==undefined):all;
    const base={schema:1 as const,packetHash:screened.manifest.packetHash,
      signerId:keys[index].id,rows:rowsToSign};
    const signature=sign(null,Buffer.from(canonicalReviewData(base)),keys[index].privateKey).toString("base64");
    return {...base,signature};
  }
  return {screened,keys,roster,submission};
}
describe("Senopati V3 evidence intake and quarantine",()=>{
  it("accepts new unlabelled prompts and retains deterministic group-frozen plan",()=>{
    const a=screenV3Intake(rows(),hist),b=screenV3Intake([...rows()].reverse(),hist);
    expect(a.manifest.acceptedForBlindReview).toBe(3);
    expect(a.packet).toEqual(b.packet);
    expect(a.manifest.packetHash).toBe(b.manifest.packetHash);
    expect(a.manifest.reviewSetDigest).toBe(b.manifest.reviewSetDigest);
    expect(a.manifest.trainingAuthorized).toBe(false);
    expect(a.manifest.independentHumanGoldLabels).toBe(0);
    const groups=a.internalPartitionPlan;
    expect(groups["field-study-1"].ids).toEqual(["fresh-one","fresh-three"]);
    expect(groups["field-study-1"].partition).toMatch(/train|calibration|sealed_evaluation/);
    for(const p of a.packet){
      expect(Object.keys(p).sort()).toEqual([
        "context","id","language","model_predictions_exposed","review_status",
        "sampleHash","text","weak_labels_exposed"
      ]);
      expect(JSON.stringify(p)).not.toContain("confidence");
    }
  });
  it("blocks exact, near-identical, historical and unredacted sensitive text",()=>{
    const candidates: IntakeRow[]=[
      {...rows()[0],id:"original"},
      {...rows()[0],id:"historic",origin:"historical_development_replay"},
      {...rows()[0],id:"exact",text:"Apa itu inflasi dan dampaknya?"},
      {...rows()[0],id:"near",text:"Apa itu inflasi dan dampaknya??"},
      {...rows()[0],id:"private",text:"Kirim laporan ke budi@example.org"},
      {...rows()[0],id:"copy",text:rows()[0].text.toUpperCase()},
    ];
    const result=screenV3Intake(candidates,hist);
    expect(result.manifest.acceptedForBlindReview).toBe(1);
    expect(result.manifest.excluded).toBe(5);
    const reason=(id:string)=>result.blocked.find(x=>x.id===id)!.reasons;
    expect(reason("historic")).toContain("historical_dev_source");
    expect(reason("exact")).toContain("exact_development_overlap");
    expect(reason("near")).toContain("near_development_overlap");
    expect(reason("private")).toContain("potential_unredacted_personal_data");
    expect(reason("copy")).toContain("duplicate_in_batch");
  });
  it("rejects invalid language and duplicate identifiers",()=>{
    expect(()=>screenV3Intake([rows()[0],rows()[0]],hist)).toThrow(/duplicate id/);
    expect(()=>screenV3Intake([{...rows()[0],language:"unverified"}],hist)).toThrow(/Invalid V3/);
  });
});
describe("Cryptographically checked, non-authorizing dual review",()=>{
  it("verifies two distinct keys and stays quarantined even on full agreement",()=>{
    const {screened,roster,submission}=setup();
    const result=verifySenopatiV3ReviewEvidence(
      screened.packet,screened.manifest,roster,submission(0),submission(1));
    expect(result.counts).toEqual({
      requests:3,agreements:3,disagreements:0,adjudicated:0,unresolved:0
    });
    expect(result.status).toBe("SIGNATURE_CHECKED_QUARANTINE_ONLY");
    expect(result.annotationCoverageByHead.intent).toEqual({research:3});
    expect(result.identitiesIndependentlyAuthenticated).toBe(false);
    expect(result.newGoldLabelsAuthorized).toBe(0);
    expect(result.trainingAuthorized).toBe(false);
    expect(result.evaluationReleaseAuthorized).toBe(false);
    expect(result.toolRoutingAuthorized).toBe(false);
  });
  it("detects missing adjudication and accepts correctly signed third-party resolution",()=>{
    const {screened,roster,submission}=setup();
    const other=submission(1,{"fresh-two":{intent:"ask"}});
    const pending=verifySenopatiV3ReviewEvidence(
      screened.packet,screened.manifest,roster,submission(0),other);
    expect(pending.counts).toMatchObject({agreements:2,disagreements:1,unresolved:1});
    expect(pending.finalizedRows.length).toBe(2);
    const adjudicated=submission(2,{"fresh-two":{intent:"ask"}});
    const final=verifySenopatiV3ReviewEvidence(
      screened.packet,screened.manifest,roster,submission(0),other,adjudicated);
    expect(final.counts).toMatchObject({agreements:2,disagreements:1,adjudicated:1,unresolved:0});
    expect(final.trainingAuthorized).toBe(false);
  });
  it("rejects tampering, packet replay, role spoofing and duplicated reviewer keys",()=>{
    const {screened,roster,submission}=setup();
    const a=submission(0),b=submission(1);
    const tampered={...a,rows:a.rows.map((r,i)=>i? r:{...r,labels:{...r.labels,intent:"execute"}})};
    expect(()=>verifySenopatiV3ReviewEvidence(
      screened.packet,screened.manifest,roster,tampered,b)).toThrow(/signature/);
    expect(()=>verifySenopatiV3ReviewEvidence(
      screened.packet,{...screened.manifest,packetHash:"0".repeat(64)},roster,a,b)).toThrow(/hash/);
    expect(()=>verifySenopatiV3ReviewEvidence(
      screened.packet,screened.manifest,roster,a,a)).toThrow(/distinct/);
    const duplicateKey={...roster,identities:[
      roster.identities[0],
      {...roster.identities[1],publicKeyPem:roster.identities[0].publicKeyPem},
      roster.identities[2]
    ]};
    expect(()=>verifySenopatiV3ReviewEvidence(
      screened.packet,screened.manifest,duplicateKey,a,b)).toThrow(/keys must be distinct/);
    const modifiedPacket=screened.packet.map(x=>x.id==="fresh-one"?{
      ...x,text:x.text+" modified",
    }:x);
    expect(()=>verifySenopatiV3ReviewEvidence(
      modifiedPacket,screened.manifest,roster,a,b)).toThrow(/hash/);
  });
  it("rejects a reviewer acting as adjudicator and mismatched signed label set",()=>{
    const {screened,roster,submission}=setup();
    const other=submission(1,{"fresh-two":{intent:"ask"}});
    const badAdj=submission(0,{"fresh-two":{intent:"ask"}});
    expect(()=>verifySenopatiV3ReviewEvidence(
      screened.packet,screened.manifest,roster,submission(0),other,badAdj)).toThrow(/third adjudicator/);
    const missing=submission(1);
    missing.rows.pop();
    expect(()=>verifySenopatiV3ReviewEvidence(
      screened.packet,screened.manifest,roster,submission(0),missing)).toThrow(/coverage/);
  });
});
