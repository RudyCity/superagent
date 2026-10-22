/**
 * Explicit opt-in registry CLI.
 * bun scripts/register-senopati-v2-shadow.ts --model FILE --policy FILE --out build/...json
 * Writes a manifest only; does not copy a model or touch production.
 */
import fs from "node:fs";
import path from "node:path";
import { createShadowRegistry } from "../src/core/senopatiV2CandidateRegistry.js";
const args=process.argv.slice(2);
function arg(name: string):string {
  const i=args.indexOf(name);
  if (i<0 || !args[i+1])throw new Error("Expected argument "+name);
  return args[i+1];
}
const model=arg("--model"), policy=arg("--policy"),out=path.resolve(arg("--out"));
const safeRoot=path.resolve("build","superagent","registry")+path.sep;
if (!out.startsWith(safeRoot) || !out.endsWith(".json"))
  throw new Error("Registry may be written only under ignored build/superagent/registry/*.json");
const registry=createShadowRegistry(model,policy);
fs.mkdirSync(path.dirname(out),{recursive:true});
const contents=JSON.stringify(registry,null,2)+"\n";
if (fs.existsSync(out)) {
  if (fs.readFileSync(out,"utf8")!==contents)throw new Error("Existing registry differs; refusing overwrite");
  console.log("UNCHANGED hash-pinned shadow registry:",out);
} else {
  fs.writeFileSync(out,contents,{flag:"wx"});
  console.log("CREATED hash-pinned shadow registry:",out);
}
console.log("Read-only shadow; no automatic routing or tool authorization.");
