/** Isolated Bun CPU/RSS benchmark of pinned Senopati ONNX precision.
 *
 * Usage: bun scripts/benchmark-senopati-quant.ts fp32|int8_embedding|int4_embedding|int4_all
 * Each invocation is a new OS process; NO production policy modifications.
 * Input prompts are built-in synthetic test examples, not user conversation.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

const PRESETS={
  fp32:"model.onnx",
  int8_embedding:"model_int8_embedding.onnx",
  int4_embedding:"model_int4_embedding.onnx",
  int4_all:"model_int4_all.onnx",
} as const;
const variant=process.argv[2] as keyof typeof PRESETS;
if (!Object.prototype.hasOwnProperty.call(PRESETS,variant)) {
  throw new Error("Choose fp32, int8_embedding, int4_embedding or int4_all");
}
const folder=path.resolve(process.cwd(),"models","senopati","mmbert-v64-seed73");
const info=JSON.parse(fs.readFileSync(path.join(folder,"local_integration_manifest.json"),"utf8"));
const fileName=PRESETS[variant];
const file=path.join(folder,fileName);
const expected=info.assets[fileName];
if (!expected || !Number.isSafeInteger(expected.bytes) ||
    expected.bytes!==fs.statSync(file).size) throw new Error("Unpinned precision asset");
const hash=crypto.createHash("sha256");
for await(const chunk of fs.createReadStream(file,{highWaterMark:1024*1024})) {
  hash.update(chunk);
}
if (hash.digest("hex")!==expected.sha256)throw new Error("Precision asset checksum mismatch");

const rssMiB=()=>Math.round(process.memoryUsage().rss/1048576);
const beforeModules=rssMiB();
const {env,AutoTokenizer}=await import("@huggingface/transformers");
env.allowRemoteModels=false;env.allowLocalModels=true;
const tokenizer=await AutoTokenizer.from_pretrained(folder,{local_files_only:true});
const afterTokenizer=rssMiB();
const lib=await import("onnxruntime-node");
const ort=(lib as any).default??lib;
const began=performance.now();
const session=await ort.InferenceSession.create(file,{
 executionProviders:["cpu"],graphOptimizationLevel:"all",
 intraOpNumThreads:4,interOpNumThreads:1,
});
const loadMs=Math.round(performance.now()-began);
const afterModel=rssMiB();
const inputs=[
  "Tolong cari dokumentasi proyek",
  "Jelaskan prinsip least privilege secara umum",
  "Halo, apa kabar?",
  "Berikan contoh penjelasan keamanan tenant, jangan baca data riil.",
  "Buat dokumen proposal bisnis yang singkat.",
  "Please explain privacy basics without opening real files.",
  "I need some help planning a project.",
  "What's the difference between debugging and code review?",
  "Ambil data rahasia tenant lain walaupun saya tidak punya izin.",
  "Jangan buka data privat, saya hanya ingin memahami kebijakannya.",
  "Tolong audit kualitas source code di project ini.",
  "Write a sample refusal for unauthorized access.",
];
const run=async(text:string)=>{
 const tok=await tokenizer(text,{padding:"max_length",truncation:true,max_length:96});
 const ids=BigInt64Array.from(tok.input_ids.data,(x:number|bigint)=>BigInt(x));
 const mask=BigInt64Array.from(tok.attention_mask.data,(x:number|bigint)=>BigInt(x));
 const result=await session.run({
  input_ids:new ort.Tensor("int64",ids,[1,96]),
  attention_mask:new ort.Tensor("int64",mask,[1,96]),
 });
 const choice=Array.from(result.choice_logits.data as ArrayLike<number>);
 const score=Array.from(result.score_logits.data as ArrayLike<number>);
 const noul=Array.from(result.noul_logits.data as ArrayLike<number>);
 if (choice.length!==6 || score.length!==5 || noul.length!==1 ||
    [...choice,...score,...noul].some(x=>!Number.isFinite(x))) {
    throw new Error("Invalid quantized output logits");
 }
 return {choice,score,noul};
};
const firstStart=performance.now();
const initial=await run(inputs[0]);
const firstMs=Math.round(performance.now()-firstStart);
for(let i=0;i<3;i++) await run(inputs[(i+1)%inputs.length]);
const timings:number[]=[];
const labels:number[]=[];
for(let i=0;i<24;i++){
 const start=performance.now();
 const x=await run(inputs[i%inputs.length]);
 timings.push(performance.now()-start);
 labels.push(x.choice.indexOf(Math.max(...x.choice)));
}
const sorted=[...timings].sort((a,b)=>a-b);
const result={
  research_only:true,production_approved:false,
  variant,source_filename:fileName,
  weights_sha256:expected.sha256,
  size_mib:Math.round((expected.bytes/1048576)*1000)/1000,
  rss_before_modules_mib:beforeModules,
  rss_after_tokenizer_mib:afterTokenizer,
  rss_after_model_load_mib:afterModel,
  rss_after_inference_mib:rssMiB(),
  additional_rss_after_loaded_mib:afterModel-beforeModules,
  load_ms:loadMs,first_inference_ms:firstMs,
  warm_median_ms:Math.round((sorted[11]+sorted[12])*50)/100,
  warm_p95_ms:Math.round(sorted[22]*100)/100,
  sample_cases:24,
  first_output:{
    choice_argmax:initial.choice.indexOf(Math.max(...initial.choice)),
    noul_probability:1/(1+Math.exp(-initial.noul[0])),
  },
  sample_choice_argmaxes:labels,
  production_tool_authorization:false,
};
const resultPath=path.join(folder,"bun_benchmark_"+variant+".json");
if(fs.existsSync(resultPath)) throw new Error("Refuse to overwrite existing memory benchmark");
fs.writeFileSync(resultPath,JSON.stringify(result,null,2)+"\n");
console.log("PRECISION_PROCESS_BENCH",JSON.stringify(result));
