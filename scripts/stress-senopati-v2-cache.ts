/** Isolated Senopati shadow cache restart / registry-switch stress. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {performance} from "node:perf_hooks";
import {createShadowRegistry,loadShadowRegistry} from "../src/core/senopatiV2CandidateRegistry.js";
import {SenopatiV2CompactShadow} from "../src/core/senopatiV2CompactShadow.js";
import {writeCompiledShadowCache} from "../src/core/senopatiV2CompactCache.js";
import {assessSelectiveShadow} from "../src/core/senopatiV2SelectiveDecision.js";

function arg(name:string,otherwise?:string){
  const i=process.argv.indexOf(name);
  if(i<0){if(otherwise!==undefined)return otherwise;throw new Error("Missing "+name);}
  if(!process.argv[i+1])throw new Error("Missing value "+name);
  return process.argv[i+1];
}
function bounded(value:string){const n=Number(value);if(!Number.isInteger(n)||n<1||n>30)throw new Error("Invalid repetition count");return n;}
function dataset(filename:string):Array<{text:string;context:string}>{
  const info=fs.statSync(filename);
  if(!info.isFile()||info.size>5*1024*1024)throw new Error("Dataset size exceeded");
  const lines=fs.readFileSync(filename,"utf8").split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s));
  if(lines.length<50||lines.length>10000||lines.some(r=>typeof r.text!=="string"||typeof r.context!=="string"))
    throw new Error("Invalid test dataset");
  return lines;
}
if(process.argv.includes("--child")){
  const start=performance.now();
  const {model,policy,cacheStatus}=loadShadowRegistry(arg("--registry"),"compact-cached",{cacheRoot:arg("--cache-root")});
  const loadMs=performance.now()-start;
  const inputs=dataset(arg("--dataset"));
  let cases=0;
  for(let i=0;i<bounded(arg("--iterations","3"));i++)for(const row of inputs){
    const decision=assessSelectiveShadow(model.predictGuarded(row.text,row.context),policy);
    if(!decision.abstain||decision.authorizesExecution||decision.eligibleForAutomaticToolRouting||
       decision.heads.risk.advisoryAccept||decision.heads.approval.advisoryAccept)throw new Error("Unsafe shadow decision");
    cases++;
  }
  console.log("SHADOW_RESTART:"+JSON.stringify({cacheStatus,loadMs,cases,toolAuthorization:false}));
}else{
  const registryName=arg("--registry"),inputs=arg("--dataset");
  const restarts=bounded(arg("--restarts","3")),iterations=bounded(arg("--iterations","3"));
  // Never modify the original registry, model, policy or working cache.
  loadShadowRegistry(registryName,"reference");
  dataset(inputs);
  const source=loadShadowRegistry(registryName,"reference").registry;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"senopati-cache-restarts-"));
  const records:Array<{scenario:string;cacheStatus:string;loadMs:number;cases:number}>=[];
  try{
    const cacheRoot=path.join(root,"cache");
    const originalModel=JSON.parse(fs.readFileSync(source.model.path,"utf8"));
    const policy=fs.readFileSync(source.policy.path);
    function variant(name:string,data:unknown){
      const modelPath=path.join(root,name+"-model.json"),policyPath=path.join(root,name+"-policy.json");
      const registryPath=path.join(root,name+"-registry.json");
      fs.writeFileSync(modelPath,JSON.stringify(data));fs.writeFileSync(policyPath,policy);
      fs.writeFileSync(registryPath,JSON.stringify(createShadowRegistry(modelPath,policyPath)));
      return registryPath;
    }
    const a=variant("a",originalModel);
    const changed=structuredClone(originalModel);
    if(!changed.records?.[0]?.features)throw new Error("No records for model switch");
    changed.records[0].features["w:cache_switch_test"]=1;
    const b=variant("b",changed);
    function compile(filename:string,repair=false){
      const loaded=loadShadowRegistry(filename,"compact");
      if(!(loaded.model instanceof SenopatiV2CompactShadow))throw new Error("No compact candidate");
      return writeCompiledShadowCache(loaded.model,loaded.registry.model.sha256,
        loaded.registry.policy.sha256,cacheRoot,{repair});
    }
    function verify(scenario:string,filename:string,expected:string){
      for(let n=0;n<restarts;n++){
        const child=spawnSync(process.execPath,[path.resolve(import.meta.path),"--child",
          "--registry",filename,"--cache-root",cacheRoot,
          "--dataset",inputs,"--iterations",String(iterations)],{
          cwd:process.cwd(),encoding:"utf8",timeout:45000,windowsHide:true,maxBuffer:1024*1024
        });
        if(child.error||child.status!==0)throw new Error("Restart child failed: "+String(child.error??child.stderr));
        const line=child.stdout.split(/\r?\n/).find(s=>s.startsWith("SHADOW_RESTART:"));
        if(!line)throw new Error("No child restart report");
        const result=JSON.parse(line.slice("SHADOW_RESTART:".length));
        if(result.cacheStatus!==expected||result.toolAuthorization!==false)
          throw new Error("Unexpected cache/fallback status in "+scenario+": "+result.cacheStatus);
        records.push({scenario,...result});
      }
    }
    const aCache=compile(a);
    verify("A_cached",a,"hit");
    verify("B_missing_fallback",b,"miss_fallback_reference");
    compile(b);
    verify("B_cached",b,"hit");
    verify("A_restored",a,"hit");
    const damaged=fs.readFileSync(aCache);damaged[damaged.length-40]^=1;
    fs.writeFileSync(aCache,damaged);
    verify("A_corrupt_fallback",a,"invalid_fallback_reference");
    let rejected=false;
    try{compile(a);}catch(e){rejected=String(e).includes("--repair");}
    if(!rejected)throw new Error("Compiler accepted implicit repair");
    compile(a,true);
    verify("A_repaired",a,"hit");
  }finally{fs.rmSync(root,{recursive:true,force:true});}
  const scenarios=Object.fromEntries([...new Set(records.map(x=>x.scenario))].map(s=>[
    s,{runs:records.filter(r=>r.scenario===s).length,
       medianLoadMs:records.filter(r=>r.scenario===s).map(r=>r.loadMs).sort((a,b)=>a-b)[Math.floor(restarts/2)]}
  ]));
  const report={schema:1,status:"SHADOW_CACHE_RESTART_STRESS",restarts,iterations,
    childRuns:records.length,scenarios,allAbstained:true,releaseAuthorized:false,
    note:"Temporary pinned model registries. No real runtime traffic or model accuracy assessment."};
  console.log(JSON.stringify(report,null,2));
  const output=arg("--out","");
  if(output){
    const target=path.resolve(output),prefix=path.resolve("build","superagent","benchmarks")+path.sep;
    if(!target.startsWith(prefix)||!target.endsWith(".json"))throw new Error("Report path outside ignored benchmarks");
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,JSON.stringify(report,null,2)+"\n");
  }
}
