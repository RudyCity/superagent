import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach,describe,expect,it } from "vitest";
import { createShadowRegistry,loadShadowRegistry } from "../src/core/senopatiV2CandidateRegistry.js";
import { compiledCachePath, decodeCompiledShadowCache,encodeCompiledShadowCache,writeCompiledShadowCache } from "../src/core/senopatiV2CompactCache.js";
import { SENOPATI_V2_HEADS, SenopatiV2Shadow,extractSenopatiV2SparseFeatures } from "../src/core/senopatiV2Shadow.js";
import { SenopatiV2CompactShadow } from "../src/core/senopatiV2CompactShadow.js";

function payload(){
  const samples=[
    ["message tulis email profesional","writing","draft","answer","safe","none"],
    ["context PLANNING_PENDING message iya","conversation","approve","none","safe","affirm"],
    ["message tolong hapus database","engineering","execute","tools","destructive","none"],
  ];
  return {
    format:"senopati-v2-sparse-baseline",deployment:"candidate-only",
    heads:Object.fromEntries(Object.entries(SENOPATI_V2_HEADS).map(([h,x])=>[h,[...x]])),
    records:samples.map(([text,domain,intent,action,risk,approval])=>({
      features:extractSenopatiV2SparseFeatures(text),
      domain,intent,action,risk,approval,
    })),
  };
}
function policy(){
  return {
    schema:1,model_family:"senopati-v2-sparse",
    mode:"DEVELOPMENT_ONLY",calibration_certified:false,
    true_probability_calibration:false,independent_blind_test:false,
    release_authorized:false,authorizes_execution:false,
    scores_are_relative_similarity_not_probabilities:true,
    heads:Object.fromEntries(Object.keys(SENOPATI_V2_HEADS).map(h=>[
      h,{threshold:h==="risk"||h==="approval"?null:0.3,
        accept_enabled:h!=="risk"&&h!=="approval",
        safety_head_requires_independent_verification:h==="risk"||h==="approval",
        oof_count:108}
    ]))
  };
}
const cleanup:string[]=[];
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"senopati-cache-"));
  cleanup.push(root);
  const modelPath=path.join(root,"model.json"), policyPath=path.join(root,"policy.json"),
        registryPath=path.join(root,"registry.json"),cacheRoot=path.join(root,"cache");
  fs.writeFileSync(modelPath,JSON.stringify(payload()));
  fs.writeFileSync(policyPath,JSON.stringify(policy()));
  const registry=createShadowRegistry(modelPath,policyPath);
  fs.writeFileSync(registryPath,JSON.stringify(registry));
  const model=new SenopatiV2CompactShadow(payload() as any);
  const cachePath=compiledCachePath(registry.model.sha256,registry.policy.sha256,cacheRoot);
  return {root,modelPath,policyPath,registryPath,cacheRoot,cachePath,model,registry};
}
afterEach(()=>{for(const p of cleanup.splice(0))fs.rmSync(p,{recursive:true,force:true});});
function reseal(buffer:Buffer){
  const digest=createHash("sha256").update(buffer.subarray(0,buffer.length-32)).digest();
  digest.copy(buffer,buffer.length-32);
  return buffer;
}
describe("Senopati V2 compiled compact cache, shadow-only",()=>{
  it("roundtrips all raw and guarded outputs including scores",()=>{
    const f=fixture();
    const bytes=encodeCompiledShadowCache(f.model,f.registry.model.sha256,f.registry.policy.sha256);
    const loaded=decodeCompiledShadowCache(bytes,f.registry.model.sha256,f.registry.policy.sha256);
    const reference=new SenopatiV2Shadow(payload() as any);
    expect(bytes.length).toBeGreaterThan(100);
    for(const text of ["tulis email profesional","iya","hapus database","unknown test",""]){
      for(const context of ["","PLANNING_PENDING"]){
        expect(loaded.predict(text,context)).toEqual(reference.predict(text,context));
        expect(loaded.predictGuarded(text,context)).toEqual(reference.predictGuarded(text,context));
        expect(loaded.predictGuarded(text,context).authorizesExecution).toBe(false);
      }
    }
    expect(loaded.stats).toEqual(f.model.stats);
  });
  it("is deterministic and only writes cache when the explicit compiler is invoked",()=>{
    const f=fixture();
    const before=loadShadowRegistry(f.registryPath,"compact-cached",{cacheRoot:f.cacheRoot});
    expect(before.cacheStatus).toBe("miss_fallback_reference");
    expect(before.model).toBeInstanceOf(SenopatiV2Shadow);
    expect(fs.existsSync(f.cachePath)).toBe(false);
    const location=writeCompiledShadowCache(f.model,f.registry.model.sha256,f.registry.policy.sha256,f.cacheRoot);
    expect(location).toBe(f.cachePath);
    const contents=fs.readFileSync(location);
    expect(contents.equals(encodeCompiledShadowCache(f.model,f.registry.model.sha256,f.registry.policy.sha256))).toBe(true);
    const hit=loadShadowRegistry(f.registryPath,"compact-cached",{cacheRoot:f.cacheRoot});
    expect(hit.cacheStatus).toBe("hit");
    expect(hit.model).toBeInstanceOf(SenopatiV2CompactShadow);
    expect(hit.model.predictGuarded("iya","PLANNING_PENDING").authorizesExecution).toBe(false);
  });
  it("rejects tampered bytes and safely falls back to reference without rewriting cache",()=>{
    const f=fixture();
    writeCompiledShadowCache(f.model,f.registry.model.sha256,f.registry.policy.sha256,f.cacheRoot);
    const bytes=fs.readFileSync(f.cachePath);
    bytes[bytes.length-40]^=0x40;
    fs.writeFileSync(f.cachePath,bytes);
    const fallback=loadShadowRegistry(f.registryPath,"compact-cached",{cacheRoot:f.cacheRoot});
    expect(fallback.cacheStatus).toBe("invalid_fallback_reference");
    expect(fallback.model).toBeInstanceOf(SenopatiV2Shadow);
    expect(fs.readFileSync(f.cachePath).equals(bytes)).toBe(true);
    expect(fallback.model.predictGuarded("iya","PLANNING_PENDING").authorizesExecution).toBe(false);
  });
  it("rejects stale hashes, unknown version and spoofed cache section sizes",()=>{
    const f=fixture();
    const bytes=encodeCompiledShadowCache(f.model,f.registry.model.sha256,f.registry.policy.sha256);
    expect(()=>decodeCompiledShadowCache(bytes,"0".repeat(64),f.registry.policy.sha256)).toThrow(/mismatch/);
    const invalidMagic=Buffer.from(bytes);invalidMagic[0]=0;
    expect(()=>decodeCompiledShadowCache(invalidMagic,f.registry.model.sha256,f.registry.policy.sha256)).toThrow(/magic/);
    const invalidVersion=Buffer.from(bytes);
    const headerLen=invalidVersion.readUInt32LE(8);
    const header=JSON.parse(invalidVersion.toString("utf8",12,12+headerLen));
    // In-place replace 'version':1 with version:9 of the same length.
    const headerText=invalidVersion.toString("utf8",12,12+headerLen);
    const changed=headerText.replace('"version":1','"version":9');
    expect(changed.length).toBe(headerText.length);
    invalidVersion.write(changed,12,headerLen,"utf8");
    reseal(invalidVersion);
    expect(()=>decodeCompiledShadowCache(invalidVersion,f.registry.model.sha256,f.registry.policy.sha256)).toThrow(/version/);
    const malformed=Buffer.from(bytes);malformed.writeUInt32LE(0xffffffff,8);reseal(malformed);
    expect(()=>decodeCompiledShadowCache(malformed,f.registry.model.sha256,f.registry.policy.sha256)).toThrow(/header length/);
  });
  it("rejects internally inconsistent weights/norms even with a recomputed cache checksum",()=>{
    const f=fixture();
    const altered=encodeCompiledShadowCache(f.model,f.registry.model.sha256,f.registry.policy.sha256);
    const jsonLength=altered.readUInt32LE(8);
    const header=JSON.parse(altered.toString("utf8",12,12+jsonLength));
    const startNorm=12+jsonLength+(header.features.length+1)*4+
      header.postings*2+header.postings*8;
    altered.writeDoubleLE(9876,startNorm);
    reseal(altered);
    expect(()=>decodeCompiledShadowCache(altered,f.registry.model.sha256,f.registry.policy.sha256)).toThrow(/norm/);
  });
  it("invalidates the cache when a new valid candidate is registered",()=>{
    const f=fixture();
    const originalCache=writeCompiledShadowCache(f.model,f.registry.model.sha256,f.registry.policy.sha256,f.cacheRoot);
    const revised=payload();
    revised.records[0].features["w:another"]=1;
    fs.writeFileSync(f.modelPath,JSON.stringify(revised));
    const revisedRegistry=createShadowRegistry(f.modelPath,f.policyPath);
    fs.writeFileSync(f.registryPath,JSON.stringify(revisedRegistry));
    const loaded=loadShadowRegistry(f.registryPath,"compact-cached",{cacheRoot:f.cacheRoot});
    expect(revisedRegistry.model.sha256).not.toBe(f.registry.model.sha256);
    expect(loaded.cacheStatus).toBe("miss_fallback_reference");
    expect(loaded.model).toBeInstanceOf(SenopatiV2Shadow);
    expect(fs.existsSync(originalCache)).toBe(true); // no automatic deletion/rewrite
  });
  it("never uses cache after pinned model or policy file changes",()=>{
    const f=fixture();
    writeCompiledShadowCache(f.model,f.registry.model.sha256,f.registry.policy.sha256,f.cacheRoot);
    fs.appendFileSync(f.modelPath," ");
    expect(()=>loadShadowRegistry(f.registryPath,"compact-cached",{cacheRoot:f.cacheRoot})).toThrow(/hash mismatch/);
    // Restore model, alter policy; both are pinned and must fail before cache lookup.
    fs.writeFileSync(f.modelPath,JSON.stringify(payload()));
    fs.appendFileSync(f.policyPath," ");
    expect(()=>loadShadowRegistry(f.registryPath,"compact-cached",{cacheRoot:f.cacheRoot})).toThrow(/hash mismatch/);
  });
  it("prevents stale-lock takeover, then safely reuses an unchanged compiled cache",()=>{
    const f=fixture();
    fs.mkdirSync(f.cacheRoot,{recursive:true});
    const lock=f.cachePath+".compile.lock";
    fs.mkdirSync(lock);
    expect(()=>writeCompiledShadowCache(f.model,f.registry.model.sha256,
      f.registry.policy.sha256,f.cacheRoot)).toThrow(/lock/);
    expect(fs.existsSync(lock)).toBe(true); // do not remove another process lock
    fs.rmdirSync(lock);
    const cache=writeCompiledShadowCache(f.model,f.registry.model.sha256,
      f.registry.policy.sha256,f.cacheRoot);
    const before=fs.statSync(cache).mtimeMs;
    const repeated=writeCompiledShadowCache(f.model,f.registry.model.sha256,
      f.registry.policy.sha256,f.cacheRoot);
    expect(repeated).toBe(cache);
    expect(fs.statSync(cache).mtimeMs).toBe(before);
    expect(fs.existsSync(lock)).toBe(false);
  });
  it("refuses changed cache without explicit repair; repairs with atomic publication and no stray files",()=>{
    const f=fixture();
    const original=writeCompiledShadowCache(f.model,f.registry.model.sha256,
      f.registry.policy.sha256,f.cacheRoot);
    const corruption=fs.readFileSync(original);
    corruption[corruption.length-38]^=0x11;
    fs.writeFileSync(original,corruption);
    expect(()=>writeCompiledShadowCache(f.model,f.registry.model.sha256,
      f.registry.policy.sha256,f.cacheRoot)).toThrow(/--repair/);
    expect(fs.readFileSync(original)).toEqual(corruption);
    const status=loadShadowRegistry(f.registryPath,"compact-cached",{cacheRoot:f.cacheRoot});
    expect(status.cacheStatus).toBe("invalid_fallback_reference");
    const repaired=writeCompiledShadowCache(f.model,f.registry.model.sha256,
      f.registry.policy.sha256,f.cacheRoot,{repair:true});
    expect(repaired).toBe(original);
    expect(loadShadowRegistry(f.registryPath,"compact-cached",{cacheRoot:f.cacheRoot}).cacheStatus).toBe("hit");
    expect(fs.readdirSync(f.cacheRoot)).toEqual([path.basename(original)]);
  });
  it("multiple Bun processes compiling the same candidate never publish partial files",async()=>{
    const f=fixture();
    const helper=fileURLToPath(new URL("./senopati_v2/compile-cache-race-worker.ts",import.meta.url));
    const work=()=>new Promise<{code:number|null,stderr:string,stdout:string}>((resolve,reject)=>{
      const child=spawn(process.execPath,[helper,
        f.modelPath,f.registry.model.sha256,f.registry.policy.sha256,f.cacheRoot],{
        cwd:process.cwd(),windowsHide:true,stdio:["ignore","pipe","pipe"],
      });
      let stdout="",stderr="";
      child.stdout.on("data",chunk=>stdout+=chunk.toString());
      child.stderr.on("data",chunk=>stderr+=chunk.toString());
      child.on("error",reject);
      child.on("close",code=>resolve({code,stdout,stderr}));
    });
    const results=await Promise.all(Array.from({length:4},()=>work()));
    expect(results.some(r=>r.code===0)).toBe(true);
    for(const r of results){
      if(r.code!==0)expect(r.stderr).toMatch(/already running or stale lock/);
    }
    expect(fs.existsSync(f.cachePath)).toBe(true);
    expect(fs.readdirSync(f.cacheRoot)).toEqual([path.basename(f.cachePath)]);
    expect(loadShadowRegistry(f.registryPath,"compact-cached",{cacheRoot:f.cacheRoot}).cacheStatus).toBe("hit");
    const reference=loadShadowRegistry(f.registryPath,"reference").model;
    const model=loadShadowRegistry(f.registryPath,"compact-cached",{cacheRoot:f.cacheRoot}).model;
    expect(model.predictGuarded("iya","PLANNING_PENDING")).toEqual(reference.predictGuarded("iya","PLANNING_PENDING"));
  },20000);
  it("rejects forged production flags before looking at a cache",()=>{
    const f=fixture();
    writeCompiledShadowCache(f.model,f.registry.model.sha256,f.registry.policy.sha256,f.cacheRoot);
    fs.writeFileSync(f.registryPath,JSON.stringify({...f.registry,automaticRoutingEnabled:true}));
    expect(()=>loadShadowRegistry(f.registryPath,"compact-cached",{cacheRoot:f.cacheRoot})).toThrow(/shadow-only/);
  });
});
