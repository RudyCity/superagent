import {afterEach,describe,expect,it} from "vitest";
import {generateKeyPairSync} from "node:crypto";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=path.resolve("build","superagent","quality");
const cli=fileURLToPath(new URL("../scripts/senopati-v3-evidence.ts",import.meta.url));
const signer=fileURLToPath(new URL("../scripts/sign-senopati-v3-review.ts",import.meta.url));
const cleanup:string[]=[];
const fixture=()=>{
  const dir=fs.mkdtempSync(path.join(root,"cli-smoke-"));cleanup.push(dir);
  const secure=fs.mkdtempSync(path.join(os.tmpdir(),"senopati-reviewer-"));cleanup.push(secure);
  const source=path.join(dir,"external.jsonl");
  const reference=path.join(dir,"historical.jsonl");
  const manifest=path.join(dir,"manifest.json");
  const sample=[
    {id:"new-1",text:"Summarize approaches to ecological restoration and community science.",context:"",
      language:"en",group:"ecology-2026",source:"review-test-only",origin:"new_external_collection"},
    {id:"new-2",text:"Bandingkan evaluasi literasi dasar dalam program pelatihan desa.",context:"",
      language:"id",group:"literacy-2026",source:"review-test-only",origin:"new_external_collection"},
    {id:"new-3",text:"Berikan ulasan mengenai penyajian grafik edukasi numerasi.",context:"",
      language:"id",group:"literacy-2026",source:"review-test-only",origin:"new_external_collection"},
  ];
  fs.writeFileSync(source,sample.map(x=>JSON.stringify(x)).join("\n")+"\n");
  fs.writeFileSync(reference,JSON.stringify({text:"Create an inventory report",context:"",group:"old"})+"\n");
  function run(command:string,args:string[],expectCode=0){
    const p=spawnSync(process.execPath,[command,...args],{
      cwd:process.cwd(),encoding:"utf8",timeout:30000,windowsHide:true,maxBuffer:1024*1024
    });
    if(p.error)throw p.error;
    expect(p.status,JSON.stringify({stderr:p.stderr,stdout:p.stdout})).toBe(expectCode);
    return p;
  }
  run(cli,["prepare","--source",source,"--reference",reference,"--out",manifest]);
  const packet=manifest.replace(/\.json$/,"_reviewer_packet.jsonl");
  const originals=fs.readFileSync(packet,"utf8").split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));
  const keys=Array.from({length:3},(_,i)=>{
    const generated=generateKeyPairSync("ed25519");
    const id=["reviewer-one","reviewer-two","adjudicator-three"][i];
    const key=path.join(secure,id+".pem");
    fs.writeFileSync(key,generated.privateKey.export({format:"pem",type:"pkcs8"}));
    return {id,key,publicKeyPem:generated.publicKey.export({format:"pem",type:"spki"}).toString(),
      role:i===2?"adjudicator":"reviewer"};
  });
  const roster=path.join(dir,"roster.json");
  fs.writeFileSync(roster,JSON.stringify({schema:1,
    identities:keys.map(({id,role,publicKeyPem})=>({id,role,publicKeyPem})),
    externalIdentityVerification:"not_verified"
  }));
  const outputs:string[]=[];
  for(let i=0;i<3;i++){
    const annotations=path.join(secure,"annotated-"+i+".jsonl");
    let annotationsRows=originals.map(row=>({id:row.id,sampleHash:row.sampleHash,
      labels:{intent:"research",risk:"safe",approval:"none"}}));
    if(i===1)annotationsRows[1].labels.intent="ask";
    if(i===2)annotationsRows=[
      {...annotationsRows[1],labels:{intent:"ask",risk:"safe",approval:"none"}}
    ];
    fs.writeFileSync(annotations,annotationsRows.map(x=>JSON.stringify(x)).join("\n")+"\n");
    const out=path.join(dir,"signed-"+i+".json");
    run(signer,[
      "--manifest",manifest,"--packet",packet,"--annotations",annotations,
      "--private-key",keys[i].key,"--signer",keys[i].id,"--out",out,
      ...(i===2?["--adjudication"]:[])
    ]);
    outputs.push(out);
  }
  return {dir,manifest,packet,roster,outputs,run};
};
afterEach(()=>{for(const p of cleanup.splice(0))fs.rmSync(p,{recursive:true,force:true});});
describe("Senopati V3 reviewer CLI integration",()=>{
  it("roundtrips new sample screening, offline Ed25519 signing, conflicts and quarantine",()=>{
    const f=fixture();
    const verified=path.join(f.dir,"verified.json");
    const frozenPlan=f.manifest.replace(/\.json$/,"_sealed_partition_plan.json");
    f.run(cli,["verify","--manifest",f.manifest,"--packet",f.packet,
      "--plan",frozenPlan,
      "--roster",f.roster,"--a",f.outputs[0],"--b",f.outputs[1],
      "--adjudication",f.outputs[2],"--out",verified]);
    const outcome=JSON.parse(fs.readFileSync(verified,"utf8"));
    expect(outcome.counts).toEqual({
      requests:3,agreements:2,disagreements:1,adjudicated:1,unresolved:0
    });
    expect(outcome.trainingAuthorized).toBe(false);
    expect(outcome.coverage.status).toBe("UNVERIFIED_QUARANTINE_COVERAGE_DIAGNOSTIC");
    expect(outcome.coverage.productionReleaseAuthorized).toBe(false);
    expect(outcome.coverage.actualIndependentGoldLabelsAvailable).toBe(0);
    expect(outcome.coverage.minorityCoverageDeficits.length).toBeGreaterThan(0);
    expect(outcome.newGoldLabelsAuthorized).toBe(0);
    expect(outcome.identitiesIndependentlyAuthenticated).toBe(false);
    expect(outcome.status).toBe("SIGNATURE_CHECKED_QUARANTINE_ONLY");
  });
  it("refuses altered frozen group partitions even when two reviews were correctly signed",()=>{
    const f=fixture();
    const frozen=f.manifest.replace(/\.json$/,"_sealed_partition_plan.json");
    const plan=JSON.parse(fs.readFileSync(frozen,"utf8"));
    const group=Object.keys(plan.partitionPlan)[0];
    plan.partitionPlan[group].ids.push("forged-id");
    fs.writeFileSync(frozen,JSON.stringify(plan));
    const out=path.join(f.dir,"tampered-plan-denied.json");
    f.run(cli,["verify","--manifest",f.manifest,"--packet",f.packet,
      "--plan",frozen,"--roster",f.roster,
      "--a",f.outputs[0],"--b",f.outputs[1],
      "--adjudication",f.outputs[2],"--out",out],1);
    expect(fs.existsSync(out)).toBe(false);
  });
  it("rejects tampered external signer payloads without writing a verified result",()=>{
    const f=fixture();
    const file=f.outputs[1];
    const item=JSON.parse(fs.readFileSync(file,"utf8"));
    item.rows[0].labels.intent="execute";
    fs.writeFileSync(file,JSON.stringify(item));
    const out=path.join(f.dir,"denied.json");
    f.run(cli,["verify","--manifest",f.manifest,"--packet",f.packet,
      "--roster",f.roster,"--a",f.outputs[0],"--b",f.outputs[1],"--out",out],1);
    expect(fs.existsSync(out)).toBe(false);
  });
});
