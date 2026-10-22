/** Exhaustive guarded AND raw decision parity for a verified hash-pinned shadow candidate. */
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
const indexed=loadShadowRegistry(registry,"indexed").model;
const heads=["domain","intent","action","risk","approval"] as const;
let rows=0,comparisons=0,largestDifference=0;
for(const filename of sets){
  const items=fs.readFileSync(filename,"utf8").split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));
  for(const sample of items){
    if(typeof sample.text!=="string")throw new Error("Invalid JSONL input text");
    const context=typeof sample.context==="string"?sample.context:"";
    for(const guarded of [false,true]){
      const r=guarded?reference.predictGuarded(sample.text,context):reference.predict(sample.text,context);
      const i=guarded?indexed.predictGuarded(sample.text,context):indexed.predict(sample.text,context);
      if(r.authorizesExecution!==false||i.authorizesExecution!==false)throw new Error("Unexpected execution authority");
      for(const head of heads){
        comparisons++;
        if(r.labels[head]!==i.labels[head])throw new Error(`Indexed label parity failed for row ${sample.id}, head ${head}`);
        const diff=Math.abs(r.relativeScores[head]-i.relativeScores[head]);
        if(diff>largestDifference)largestDifference=diff;
        if(!Number.isFinite(diff)||diff>1e-9)throw new Error(`Indexed score parity failed for row ${sample.id}, head ${head}`);
      }
    }
    rows++;
  }
  console.log(`PARITY DATASET ${filename}: ${items.length} cases`);
}
console.log(`PASS: indexed/ref ${comparisons}/${comparisons} raw+guarded head decisions across ${rows} cases; max absolute relative score delta ${largestDifference}`);
console.log("Indexed is research-only and never authorizes tools.");
