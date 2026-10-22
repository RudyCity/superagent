/**
 * Child-process helper for testing races between two explicit Senopati
 * research-only cache compilers; never used by app runtime or production.
 */
import fs from "node:fs";
import { SenopatiV2CompactShadow } from "../../src/core/senopatiV2CompactShadow.js";
import { writeCompiledShadowCache } from "../../src/core/senopatiV2CompactCache.js";
const [modelPath,modelHash,policyHash,root]=process.argv.slice(2);
if(!modelPath||!modelHash||!policyHash||!root)throw new Error("Missing race fixture arguments");
try {
  const model=new SenopatiV2CompactShadow(JSON.parse(fs.readFileSync(modelPath,"utf8")));
  writeCompiledShadowCache(model,modelHash,policyHash,root);
  console.log("COMPILED_OR_REUSED");
}catch(e){
  console.error(String(e));
  process.exitCode=19;
}
