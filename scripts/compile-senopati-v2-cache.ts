/**
 * Explicitly compile a SHA-256-bound, versioned Senopati V2 compact cache.
 * Run from SuperAgent root:
 * bun scripts/compile-senopati-v2-cache.ts --registry build/superagent/registry/...json
 *
 * Writes ONLY an ignored cache file under build/superagent/cache/.
 * Does not change production model, routing, registry, or policy.
 */
import { loadShadowRegistry } from "../src/core/senopatiV2CandidateRegistry.js";
import { SenopatiV2CompactShadow } from "../src/core/senopatiV2CompactShadow.js";
import { writeCompiledShadowCache, decodeCompiledShadowCache } from "../src/core/senopatiV2CompactCache.js";
import fs from "node:fs";
const idx=process.argv.indexOf("--registry");
if(idx<0 || !process.argv[idx+1])throw new Error("Usage: bun scripts/compile-senopati-v2-cache.ts --registry FILE");
const filename=process.argv[idx+1];
// An explicit trusted source is mandatory; never compile from existing cache.
const {model,registry}=loadShadowRegistry(filename,"compact");
if(!(model instanceof SenopatiV2CompactShadow))throw new Error("Registry did not load a compact candidate");
const cache=writeCompiledShadowCache(model,registry.model.sha256,registry.policy.sha256);
const roundTrip=decodeCompiledShadowCache(fs.readFileSync(cache),registry.model.sha256,registry.policy.sha256);
if(roundTrip.stats.records!==model.stats.records ||
   roundTrip.stats.postings!==model.stats.postings)throw new Error("Round-trip compiled cache mismatch");
console.log(JSON.stringify({
  status:"COMPILED_SHADOW_ONLY",file:cache,
  records:roundTrip.stats.records,features:roundTrip.stats.features,
  postings:roundTrip.stats.postings,
  bytes:fs.statSync(cache).size,authorizesExecution:false,
  productionChanged:false
},null,2));
