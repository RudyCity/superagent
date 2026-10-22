/** Exhaustive guarded AND raw decision parity for a hash-pinned shadow candidate.
 * Add --compact to test memory-optimized typed-array postings instead of the original index.
 */
import fs from "node:fs";
import { loadShadowRegistry } from "../src/core/senopatiV2CandidateRegistry.js";
const argv=process.argv.slice(2);
const position=argv.indexOf("--registry");
if(position<0||!argv[position+1])throw new Error("Usage: bun scripts/check-senopati-v2-indexed-parity.ts --registry MANIFEST.json --dataset SET.jsonl [--dataset SET.jsonl ...]");
const registry=argv[position+1];
const sets:string[]=[];
for(let i=0;i<argv.length;i++)if(argv[i]==="--dataset"&&argv[i+1])sets.push(argv[i+1]);
if(!sets.length)throw new Error("At least one explicit JSONL dataset required");
const reference=loadShadowRegistry(registry,"reference").model;
const engines: Array<"indexed"|"compact"|"compact-cached"> = argv.includes("--all")
  ? ["indexed","compact"] : [argv.includes("--compact") ? "compact" : "indexed"];
if (argv.includes("--cached")) engines.push("compact-cached");
const optimizedEngines=engines.map(name=>{
  const loaded=loadShadowRegistry(registry,name);
  if(name==="compact-cached" && loaded.cacheStatus!=="hit")
    throw new Error("Cached parity requires a real compiled-cache hit, not a reference fallback");
  return {name,model:loaded.model};
});
const heads=["domain","intent","action","risk","approval"] as const;
let rows=0,comparisons=0,largestDifference=0;
for(const filename of sets){
  const items=fs.readFileSync(filename,"utf8").split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));
  for(const sample of items){
    if(typeof sample.text!=="string")throw new Error("Invalid JSONL input text");
    const context=typeof sample.context==="string"?sample.context:"";
    for(const guarded of [false,true]){
      const r=guarded?reference.predictGuarded(sample.text,context):reference.predict(sample.text,context);
      const optimized=optimizedEngines.map(({name,model})=>[
        name, guarded?model.predictGuarded(sample.text,context):model.predict(sample.text,context)
      ] as const);
      if(r.authorizesExecution!==false)throw new Error("Unexpected reference execution authority");
      for(const [engineName,result] of optimized){
        if(result.authorizesExecution!==false)throw new Error("Unexpected execution authority");
        for(const head of heads){
          comparisons++;
          if(r.labels[head]!==result.labels[head])throw new Error(`${engineName} label parity failed for row ${sample.id}, head ${head}`);
          const diff=Math.abs(r.relativeScores[head]-result.relativeScores[head]);
          if(diff>largestDifference)largestDifference=diff;
          if(!Number.isFinite(diff)||diff>1e-9)throw new Error(`${engineName} score parity failed for row ${sample.id}, head ${head}`);
        }
      }
    }
    rows++;
  }
  console.log(`PARITY DATASET ${filename}: ${items.length} cases`);
}
console.log(`PASS: ${engines.join("+")}/reference ${comparisons}/${comparisons} raw+guarded head decisions across ${rows} cases; max absolute relative score delta ${largestDifference}`);
console.log(engines.join("+")+" is research-only and never authorizes tools.");
