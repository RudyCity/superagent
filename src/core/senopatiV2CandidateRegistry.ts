/**
 * Explicit opt-in, hash-pinned registry for Senopati experimental candidates.
 * Never updates production model files, routing, or ToolExecutor approval.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SenopatiV2Shadow } from "./senopatiV2Shadow.js";
import { SenopatiV2IndexedShadow } from "./senopatiV2IndexedShadow.js";
import { SenopatiV2CompactShadow } from "./senopatiV2CompactShadow.js";
import { compiledCachePath, decodeCompiledShadowCache } from "./senopatiV2CompactCache.js";
import { validateSelectiveProfile, type SelectivePolicyProfile } from "./senopatiV2SelectiveDecision.js";

export interface SenopatiV2CandidateRegistry {
  schema: 1;
  status: "SHADOW_ONLY";
  automaticRoutingEnabled: false;
  authorizesExecution: false;
  model: { path: string; sha256: string };
  policy: { path: string; sha256: string };
}
function digest(data: Buffer): string { return crypto.createHash("sha256").update(data).digest("hex"); }
function readBounded(filename: string, limit: number): Buffer {
  const info = fs.statSync(filename);
  if (!info.isFile() || info.size < 4 || info.size > limit)
    throw new Error("Candidate file is not a bounded regular file: " + filename);
  return fs.readFileSync(filename);
}
export function createShadowRegistry(modelPath: string, policyPath: string): SenopatiV2CandidateRegistry {
  const modelBuffer = readBounded(modelPath,20*1024*1024);
  const policyBuffer = readBounded(policyPath,5*1024*1024);
  const payload = JSON.parse(modelBuffer.toString("utf8"));
  new SenopatiV2Shadow(payload);
  validateSelectiveProfile(JSON.parse(policyBuffer.toString("utf8")));
  return {
    schema:1,status:"SHADOW_ONLY",automaticRoutingEnabled:false,authorizesExecution:false,
    model:{path:path.resolve(modelPath),sha256:digest(modelBuffer)},
    policy:{path:path.resolve(policyPath),sha256:digest(policyBuffer)},
  };
}
export function loadShadowRegistry(
  filename: string,
  engine: "reference" | "indexed" | "compact" | "compact-cached" = "reference",
  options?: { cacheRoot?: string },
): {
  registry: SenopatiV2CandidateRegistry;
  model: SenopatiV2Shadow | SenopatiV2IndexedShadow | SenopatiV2CompactShadow;
  policy: SelectivePolicyProfile;
  cacheStatus: "not_requested" | "hit" | "miss_fallback_reference" | "invalid_fallback_reference";
} {
  const raw = JSON.parse(readBounded(filename,1*1024*1024).toString("utf8")) as SenopatiV2CandidateRegistry;
  if (raw.schema !== 1 || raw.status !== "SHADOW_ONLY" ||
      raw.automaticRoutingEnabled !== false || raw.authorizesExecution !== false)
    throw new Error("Registry must be explicitly shadow-only");
  for (const entry of [raw.model,raw.policy]) {
    if (!entry || typeof entry.path !== "string" || !path.isAbsolute(entry.path) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Unpinned registry entry");
  }
  const m=readBounded(raw.model.path,20*1024*1024);
  const p=readBounded(raw.policy.path,5*1024*1024);
  if (digest(m)!==raw.model.sha256 || digest(p)!==raw.policy.sha256)
    throw new Error("Candidate registry hash mismatch: do not use altered artifact");
  if (!["reference","indexed","compact","compact-cached"].includes(engine))
    throw new Error("Unknown shadow inference engine");
  // Parse and validate the original registry-bound policy on every load.
  // Compiled caches are not authoritative; file and policy digests were verified above.
  const policy = JSON.parse(p.toString("utf8")) as SelectivePolicyProfile;
  validateSelectiveProfile(policy);
  if(engine==="compact-cached"){
    const cache=compiledCachePath(raw.model.sha256,raw.policy.sha256,options?.cacheRoot);
    if(!fs.existsSync(cache)){
      return {
        registry:raw,model:new SenopatiV2Shadow(JSON.parse(m.toString("utf8"))),
        policy,cacheStatus:"miss_fallback_reference",
      };
    }
    try{
      const content=readBounded(cache,32*1024*1024);
      const model=decodeCompiledShadowCache(content,raw.model.sha256,raw.policy.sha256);
      return {registry:raw,model,policy,cacheStatus:"hit"};
    }catch{
      // Reject invalid cache completely. Do not repair/write automatically.
      // Fall back to independently validated reference model from original JSON.
      return {
        registry:raw,model:new SenopatiV2Shadow(JSON.parse(m.toString("utf8"))),
        policy,cacheStatus:"invalid_fallback_reference",
      };
    }
  }
  const modelPayload = JSON.parse(m.toString("utf8"));
  const model = engine === "compact"
    ? new SenopatiV2CompactShadow(modelPayload)
    : engine === "indexed"
      ? new SenopatiV2IndexedShadow(modelPayload)
      : new SenopatiV2Shadow(modelPayload);
  return {registry:raw,model,policy,cacheStatus:"not_requested"};
}
