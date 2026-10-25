/** Guarded CPU ONNX semantic intent backend for Senopati V6.4 seed73.
 * Does not authorize tools. Legacy destructive-command guard stays separate.
 * A local policy file enables this backend. Malformed policy -> legacy.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ClassificationResult, RequestCategory } from "./requestClassifier.js";
import { loadSenopatiTokenizer, type SenopatiLoadedTokenizer } from "./senopatiTokenizer.js";
import { requestSharedSenopatiPrediction } from "./senopatiSharedClient.js";

export const MODERN_MODEL = "mmbert-v64-seed73-hard";
export const MODERN_CHOICES = ["answer", "artifact", "delegate", "none", "retrieve", "tools"] as const;
export type ModernChoice = typeof MODERN_CHOICES[number];

export type ModernPrecision = "fp32" | "int8_embedding" | "int4_embedding";
export type ModernPolicy = {
  backend: "legacy" | "mmbert-v64-seed73";
  precision: ModernPrecision;
  inferenceMode: "local" | "shared_only";
  enabled: boolean;
  minConfidence: number;
  preserveLegacySafety: true;
  noAuthorizationFromModel: true;
};
export type ModernPrediction = {
  intent: ModernChoice;
  confidence: number;
  riskProbability: number;
  score: number;
  modelName: string;
};
export const LEGACY_POLICY: ModernPolicy = {
  backend: "legacy", enabled: false, minConfidence: .85,
  precision: "fp32", inferenceMode: "local",
  preserveLegacySafety: true, noAuthorizationFromModel: true,
};
export const GUARDED_POLICY: ModernPolicy = {
  backend: "mmbert-v64-seed73", enabled: true, minConfidence: .85,
  precision: "int8_embedding", inferenceMode: "local",
  preserveLegacySafety: true, noAuthorizationFromModel: true,
};
const POLICY_FILE = "active_backend.json";
const MODEL_FOLDER = "mmbert-v64-seed73";
export const MODERN_PRECISION_FILES: Readonly<Record<ModernPrecision,string>> = Object.freeze({
  fp32: "model.onnx",
  int8_embedding: "model_int8_embedding.onnx",
  int4_embedding: "model_int4_embedding.onnx",
});
const MAX_ASSET_BYTES = 570 * 1024 * 1024;
type Bundle = { session: any; tokenizer: SenopatiLoadedTokenizer; precision: ModernPrecision };
let bundle: Bundle | null = null;
let inFlight=0;
let pending: Promise<Bundle | null> | null = null;
let failures = 0;
let lastFailure = "";
const lru = new Map<string, ModernPrediction>();

function roots(): string[] {
  return [
    path.resolve(process.cwd(), "models", "senopati"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "models", "senopati"),
  ];
}
export function modernPolicyFile(): string {
  const folder = roots().find((root) => fs.existsSync(path.join(root, POLICY_FILE)));
  return path.join(folder || roots()[0], POLICY_FILE);
}
export function validateModernPolicy(input: unknown): ModernPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid modern routing policy");
  }
  const p = input as Partial<ModernPolicy>;
  if ((p.backend !== "legacy" && p.backend !== "mmbert-v64-seed73") ||
      typeof p.enabled !== "boolean" ||
      (p.precision!==undefined &&
       !Object.prototype.hasOwnProperty.call(MODERN_PRECISION_FILES,p.precision)) ||
      (p.inferenceMode!==undefined && p.inferenceMode!=="local" &&
       p.inferenceMode!=="shared_only") ||
      typeof p.minConfidence !== "number" || !Number.isFinite(p.minConfidence) ||
      p.minConfidence < .5 || p.minConfidence > 1 ||
      p.preserveLegacySafety !== true || p.noAuthorizationFromModel !== true ||
      (p.enabled && p.backend !== "mmbert-v64-seed73")) {
    throw new Error("Unsafe modern routing policy");
  }
  return {
    backend:p.backend, enabled:p.enabled, minConfidence:p.minConfidence,
    precision: p.precision ?? "fp32",
    inferenceMode: p.inferenceMode ?? "local",
    preserveLegacySafety:true, noAuthorizationFromModel:true,
  };
}
export function getModernPolicy(): ModernPolicy {
  const file=modernPolicyFile();
  if (!fs.existsSync(file)) return {...LEGACY_POLICY};
  try {
    if (fs.statSync(file).size > 8192) return {...LEGACY_POLICY};
    return validateModernPolicy(JSON.parse(fs.readFileSync(file,"utf8")));
  } catch { return {...LEGACY_POLICY}; }
}
export function setModernPolicy(input: ModernPolicy): ModernPolicy {
  const p=validateModernPolicy(input);
  const file=modernPolicyFile();
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=file+"."+process.pid+"."+crypto.randomUUID()+".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(p,null,2)+"\n",
      {encoding:"utf8",mode:0o600,flag:"wx"});
    fs.renameSync(tmp,file);
  } catch (error) {
    try {fs.rmSync(tmp,{force:true});} catch {}
    throw error;
  }
  lru.clear();
  return p;
}
async function checksum(file:string):Promise<string> {
  const hash=crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file,{highWaterMark:1<<20})) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
function assetRoot(): string | null {
  for (const dir of roots()) {
    const folder=path.join(dir,MODEL_FOLDER);
    if (fs.existsSync(path.join(folder,"model.onnx")) &&
        fs.existsSync(path.join(folder,"local_integration_manifest.json"))) return folder;
  }
  return null;
}
async function loadBundle(precision:ModernPrecision):Promise<Bundle|null> {
  if (bundle?.precision === precision) return bundle;
  if (pending) {
    const loaded=await pending;
    return loaded?.precision === precision ? loaded : null;
  }
  if (bundle && bundle.precision !== precision) {
    // Don't release an ONNX session while another classification is using it.
    // Requests temporarily fall back to legacy until the old run finishes.
    if (inFlight>0) return null;
    const previous=bundle;
    bundle=null;
    lru.clear();
    try {await previous.session.release?.();} catch {}
  }
  pending=(async()=>{
    const folder=assetRoot();
    if (!folder) {failures++;lastFailure="Model assets missing";return null;}
    try {
      const manifest=JSON.parse(fs.readFileSync(
          path.join(folder,"local_integration_manifest.json"),"utf8"));
      if (manifest.model!==MODERN_MODEL ||
          manifest.max_seq_len!==96 ||
          manifest.automatic_tool_authorization!==false ||
          manifest.role!=="new_intent_backend_only_original_destructive_guardrail_kept") {
        throw new Error("Incompatible model provenance");
      }
      const assetFile=MODERN_PRECISION_FILES[precision];
      for (const name of [assetFile,"tokenizer.json","tokenizer_config.json",
                          "special_tokens_map.json","config.json"]) {
        const file=path.join(folder,name);
        const expected=manifest.assets?.[name];
        if (typeof expected?.sha256!=="string" ||
            !/^[a-f0-9]{64}$/.test(expected.sha256) ||
            !fs.existsSync(file) ||
            fs.statSync(file).size!==expected.bytes ||
            expected.bytes>MAX_ASSET_BYTES ||
            (await checksum(file))!==expected.sha256) {
          throw new Error("Model/tokenizer checksum mismatch: "+name);
        }
      }
      const tokenizer=await loadSenopatiTokenizer(folder);
      const module=await import("onnxruntime-node");
      const ort=(module as any).default || module;
      const session=await ort.InferenceSession.create(path.join(folder,assetFile),{
        executionProviders:["cpu"],
        graphOptimizationLevel:"all",
        intraOpNumThreads:4,
        interOpNumThreads:1,
      });
      for (const name of ["input_ids","attention_mask"]) {
        if (!session.inputNames.includes(name)) throw new Error("ONNX missing input "+name);
      }
      for (const name of ["choice_logits","score_logits","noul_logits"]) {
        if (!session.outputNames.includes(name)) throw new Error("ONNX missing output "+name);
      }
      // No mixed-session routing after a policy change while loading.
      const policyAtEnd=getModernPolicy();
      if ((policyAtEnd.precision ?? "fp32") !== precision) {
        try {await session.release?.();} catch {}
        return null;
      }
      bundle={session,tokenizer,precision};
      failures=0;lastFailure="";
      return bundle;
    } catch (error) {
      failures++;
      lastFailure=error instanceof Error?error.message:String(error);
      return null;
    }
  })();
  try {return await pending;} finally {pending=null;}
}
function softmax(array:number[]):number[] {
  const max=Math.max(...array);
  const exponential=array.map((x)=>Math.exp(x-max));
  const total=exponential.reduce((a,b)=>a+b,0);
  return exponential.map((x)=>x/total);
}
export function decodeModernPrediction(
  choice:ArrayLike<number>,score:ArrayLike<number>,risk:ArrayLike<number>,
):ModernPrediction {
  const c=Array.from(choice),s=Array.from(score),n=Array.from(risk);
  if (c.length!==6 || s.length!==5 || n.length!==1 ||
      [...c,...s,...n].some((v)=>!Number.isFinite(v))) {
    throw new Error("ModernBert ONNX output shape mismatch");
  }
  const pc=softmax(c),ps=softmax(s);
  const best=pc.indexOf(Math.max(...pc));
  return {
    intent:MODERN_CHOICES[best],
    confidence:pc[best],
    riskProbability:1/(1+Math.exp(-n[0])),
    score:ps.reduce((value,p,i)=>value+(i+1)*p,0),
    modelName:MODERN_MODEL,
  };
}
export async function inferModernPrediction(text:string):Promise<ModernPrediction|null> {
  if(!text.trim() || text.length>6000)return null;
  const policy=getModernPolicy();
  if(policy.inferenceMode==="shared_only"){
    // Never allocate a second mmBERT if shared service is unavailable.
    // The guarded caller will fall back to original tiny Senopati ONNX.
    return requestSharedSenopatiPrediction(text,policy.precision);
  }
  return inferModernPredictionLocal(text);
}
export async function inferModernPredictionLocal(text:string):Promise<ModernPrediction|null> {
  if (!text.trim() || text.length>6000) return null;
  const precision=getModernPolicy().precision ?? "fp32";
  const key=precision+"|"+text.trim();
  const old=lru.get(key);
  if (old) return {...old};
  const active=await loadBundle(precision);
  if (!active || active.precision!==precision) return null;
  inFlight++;
  try {
    const item=await active.tokenizer.encode(text);
    const ids=item.inputIds;
    const mask=item.attentionMask;
    const module=await import("onnxruntime-node");
    const ort=(module as any).default || module;
    const output=await active.session.run({
      input_ids:new ort.Tensor("int64",ids,[1,96]),
      attention_mask:new ort.Tensor("int64",mask,[1,96]),
    });
    const result=decodeModernPrediction(
      output.choice_logits.data,output.score_logits.data,output.noul_logits.data);
    if (lru.size>=128) {
      const oldest=lru.keys().next().value;
      if (oldest) lru.delete(oldest);
    }
    lru.set(key,result);
    return result;
  } catch (error) {
    failures++;
    lastFailure=error instanceof Error?error.message:String(error);
    return null;
  } finally {
    inFlight--;
  }
}
/** Never broaden a legacy restricted question into an unrestricted command. */
export function mergeModernIntent(
  legacy:ClassificationResult,prediction:ModernPrediction|null,minConfidence=.85,
):ClassificationResult {
  if (!prediction || prediction.modelName!==MODERN_MODEL ||
      !Number.isFinite(prediction.confidence) ||
      prediction.confidence<minConfidence ||
      !Number.isFinite(prediction.riskProbability)) return legacy;
  const previous=legacy.category;
  let category:RequestCategory=previous;
  if (prediction.intent==="retrieve" &&
      ["question","research"].includes(previous)) {
    category="research";
  } else if (prediction.intent==="answer" &&
             ["question","research"].includes(previous)) {
    category="question";
  }
  // Action intents (tools/delegate/artifact) MUST NOT broaden toolset.
  // Score is NOT legacy urgency. Noul is UNAUTHORIZED ACCESS risk,
  // not legacy DESTRUCTIVE SHELL risk.
  return {
    ...legacy,
    category,
    secondaryCategory:category!==previous?previous:legacy.secondaryCategory,
    confidence:prediction.confidence>=.95?"high":"medium",
    isDestructive:legacy.isDestructive,
    reason:legacy.reason+"; mmBERT "+prediction.intent+" "+
       (prediction.confidence*100).toFixed(1)+"% [intent-only; legacy safety unchanged]",
  };
}
export function modernRuntimeStatus() {
  const policy=getModernPolicy();
  return {candidate:MODERN_MODEL,initialized:Boolean(bundle),failures,lastFailure,
          enabled:policy.enabled,
          configuredPrecision:policy.precision,
          loadedPrecision:bundle?.precision ?? null,
          tokenizerEngine:bundle?.tokenizer.engine ?? null,
          inferenceMode:policy.inferenceMode};
}
export function clearModernPredictionCache():void {
  lru.clear();
}
