import {describe,it,expect} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {SENOPATI_V2_HEADS} from "../src/core/senopatiV2Shadow.js";
import {verifyCikaP11Shadow} from "../scripts/verify-senopati-cika-p11-shadow.js";

const hash=(data:Buffer|string)=>crypto.createHash("sha256").update(data).digest("hex");
const heads=Object.keys(SENOPATI_V2_HEADS);
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"cika-p11-readonly-"));
  const file=(rel:string)=>path.join(root,...rel.split("/"));
  const make=(rel:string,data:string)=>{
    const filename=file(rel);fs.mkdirSync(path.dirname(filename),{recursive:true});
    fs.writeFileSync(filename,data);return filename;
  };
  const model=file("build/superagent/v3_p10_curriculum/trained_sparse_p10.json");
  const headModel=file("build/superagent/v3_p10_curriculum/trained_nb_candidates.json");
  const p10meta=file("build/superagent/v3_p10_curriculum/candidate_manifest.json");
  const v2=file("build/superagent/senopati_v2_candidate/sparse_baseline.json");
  make("build/superagent/v3_p10_curriculum/trained_sparse_p10.json",'{"research":true}');
  make("build/superagent/v3_p10_curriculum/trained_nb_candidates.json",'{"head":"research"}');
  make("build/superagent/senopati_v2_candidate/sparse_baseline.json",'{"v2":"research"}');
  make("build/superagent/v3_p10_curriculum/candidate_manifest.json",JSON.stringify({
    schema:1,status:"P10_TRAINED_SYNTHETIC_CANDIDATE_QUARANTINED",
    sparseSha256:hash(fs.readFileSync(model)),
    headModelsSha256:hash(fs.readFileSync(headModel)),
    activationAllowed:false,automaticRoutingAuthorized:false,
    toolExecutionAuthorized:false,productionReleaseAuthorized:false,
    externalHumanGoldLabels:0
  }));
  const labels=Object.fromEntries(heads.map(h=>[h,
    h==="approval"?"none":h==="risk"?"safe":
    (SENOPATI_V2_HEADS as any)[h][0]]));
  const observations:any[]=[];
  const source:any[]=[];
  const summaryConf:Record<string,any>={};
  for(const family of ["p10","v2"]){
    summaryConf[family]={};
    for(const head of heads){
      const cls=(SENOPATI_V2_HEADS as any)[head] as string[];
      const confusion=Object.fromEntries(cls.map(actual=>[
        actual,Object.fromEntries(cls.map(pred=>[pred,actual===labels[head]&&pred===labels[head]?72:0]))
      ]));
      summaryConf[family][head]={confusion,macroF1:1};
    }
  }
  const perLanguage:Record<string,any>={};
  for(const language of ["id","en","mixed"]){
    perLanguage[language]={};
    for(const family of ["p10","v2"]){
      perLanguage[language][family]={};
      for(const head of heads){
        const cls=(SENOPATI_V2_HEADS as any)[head] as string[];
        perLanguage[language][family][head]={
          confusion:Object.fromEntries(cls.map(actual=>[
            actual,Object.fromEntries(cls.map(pred=>[pred,actual===labels[head]&&pred===labels[head]?24:0]))
          ])),
        };
      }
    }
  }
  for(let i=0;i<72;i++){
    const group=Math.floor(i/3),language=["id","en","mixed"][i%3];
    const item={
      id:`p11-${String(group).padStart(2,"0")}-${language}`,
      group:`p11-semantic-${group}`,language,
      text:`Synthetic non-identifying scenario ${group} in ${language}`,
      context:"",source:"ai_authored_p11_form_shift_synthetic_no_external_gold",
      ...labels
    };
    source.push(item);
    observations.push({
      id:item.id,group:item.group,language:item.language,
      sampleSha256:hash(item.context+"\0"+item.text),
      p10Advisory:{...labels},v2ResearchBaseline:{...labels},
      guardedApproval:"none",manualReviewRequired:false,
      automaticToolExecutionAuthorized:false,
      automaticDelegationAuthorized:false,
      productionReleaseAuthorized:false,
    });
  }
  const dataset=make("superagent/datasets/v3_p11_form_shift_rev1.jsonl",
    source.map(x=>JSON.stringify(x)).join("\n")+"\n");
  const obs=make("build/superagent/v3_p11_shadow_v2/cika_p11_observations.jsonl",
    observations.map(x=>JSON.stringify(x)).join("\n")+"\n");
  const summary={
    schema:1,status:"P11_INSPECTED_AI_SYNTHETIC_FORM_SHIFT_READ_ONLY",
    sampleCount:72,scenarioCount:24,languages:{id:24,en:24,mixed:24},
    benchmarkIsIndependentHumanGold:false,sourceIsArtificialAndTestNowInspected:true,
    trainOnThisBenchmark:false,productionCandidateActivated:false,
    comparedToLiveProductionTraffic:false,verifiedHumanGoldLabels:0,
    publisherSignatureVerified:false,productionReleaseAuthorized:false,
    toolAuthorization:false,guardToolAuthorizationCount:0,
    guardManualReviewCount:0,guardBlockedApprovalCount:0,
    perHead:summaryConf,perLanguage,
    safetyConfusions:{
      p10:{destructiveAsSafe:0,sensitiveAsSafe:0,totalUnsafeAsSafe:0,falseAffirm:0,falseDeny:0},
      v2:{destructiveAsSafe:0,sensitiveAsSafe:0,totalUnsafeAsSafe:0,falseAffirm:0,falseDeny:0},
    },
  };
  const h={
    schema:1,status:"CIKA_P11_SHADOW_OBSERVATIONS_ONLY",origin:"Cika",
    sampleCount:72,sampleDatasetSha256:hash(fs.readFileSync(dataset)),
    observationsSha256:hash(fs.readFileSync(obs)),
    p10ModelSha256:hash(fs.readFileSync(model)),
    p10HeadModelsSha256:hash(fs.readFileSync(headModel)),
    p10ManifestSha256:hash(fs.readFileSync(p10meta)),
    v2ModelSha256:hash(fs.readFileSync(v2)),
    p10ModelPath:model,p10HeadsPath:headModel,p10ManifestPath:p10meta,v2ModelPath:v2,
    modelFormat:"Cika-Rudy-development-only",
    summary,
    humanGoldLabels:0,sourceIndependentOfDeveloper:false,
    publisherSignatureVerified:false,activationAllowed:false,
    automaticRoutingEnabled:false,authorizesExecution:false,
    retrainingAuthorized:false,productionReleaseAuthorized:false,
  };
  const handoff=make("build/superagent/v3_p11_shadow_v2/cika_p11_shadow_handoff.json",JSON.stringify(h));
  const invoke=()=>verifyCikaP11Shadow(root,handoff,obs);
  const update=(changes:Record<string,unknown>)=>fs.writeFileSync(handoff,JSON.stringify({...h,...changes}));
  return {root,model,headModel,p10meta,v2,obs,dataset,handoff,h,observations,source,invoke,update};
}

describe("P11 pinned Cika synthetic shadow artifact consumer",()=>{
  it("checks hashes and ALL aggregate confusion counts without enabling runtime",()=>{
    const f=fixture();
    try{
      const result=f.invoke();
      expect(result.status).toBe("CIKA_P11_SHADOW_CONSUMED_READ_ONLY");
      expect(result.cases).toBe(72);
      expect(result.productionModelChanged).toBe(false);
      expect(result.toolAuthorization).toBe(false);
      expect(result.independentHumanGold).toBe(false);
      expect(result.liveProductionParityVerified).toBe(false);
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  });
  it("rejects modified model and observation bytes, without even reading live models",()=>{
    const f=fixture();
    try{
      fs.appendFileSync(f.model," ");
      expect(()=>f.invoke()).toThrow(/digest differs/);
      fs.writeFileSync(f.model,'{"research":true}');
      fs.appendFileSync(f.obs," ");
      expect(()=>f.invoke()).toThrow(/digest differs/);
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  });
  it("rejects forged publisher, release, routing and outside model paths",()=>{
    const f=fixture();
    try{
      for(const change of [
        {activationAllowed:true},{automaticRoutingEnabled:true},
        {productionReleaseAuthorized:true},{publisherSignatureVerified:true},
        {authorizesExecution:true},{sourceIndependentOfDeveloper:true},
        {p10ModelPath:"C:/Other/model.json"},
      ]){
        f.update(change);
        expect(()=>f.invoke()).toThrow();
      }
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  });
  it("rejects forged confidence/aggregate safety reports and mismatched sample labels",()=>{
    const f=fixture();
    try{
      f.update({summary:{...f.h.summary,guardManualReviewCount:2}});
      expect(()=>f.invoke()).toThrow(/guard summary mismatch/);
      f.update({summary:{...f.h.summary,perHead:{
        ...f.h.summary.perHead,p10:{...f.h.summary.perHead.p10,
          risk:{...f.h.summary.perHead.p10.risk,macroF1:0.99}}
      }}});
      expect(()=>f.invoke()).toThrow(/aggregate F1/);
      f.update({summary:{...f.h.summary,safetyConfusions:{
        ...f.h.summary.safetyConfusions,p10:{...f.h.summary.safetyConfusions.p10,
          totalUnsafeAsSafe:10}}
      }});
      expect(()=>f.invoke()).toThrow(/safety-mismatch/);
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  });
});
