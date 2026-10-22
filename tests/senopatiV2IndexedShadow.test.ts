import { describe, expect, it } from "vitest";
import { SenopatiV2IndexedShadow } from "../src/core/senopatiV2IndexedShadow.js";
import { SenopatiV2Shadow, SENOPATI_V2_HEADS, extractSenopatiV2SparseFeatures } from "../src/core/senopatiV2Shadow.js";

function fixture(){
  const texts=[
    "message tulis email untuk rekan", "message perbaiki API backend NestJS",
    "message apa itu fotosintesis", "context PLANNING_PENDING message saya setuju",
    "message rm -rf hapus data", "message Tolong riset harga terbaru",
    "message buat poster seminar", "message setel pengingat besok",
    "message selamat pagi","message open google and browse",
  ];
  const categories=[
    ["writing","draft","answer","safe","none"],
    ["engineering","modify","tools","safe","none"],
    ["knowledge","ask","answer","safe","none"],
    ["conversation","approve","none","safe","affirm"],
    ["engineering","execute","tools","destructive","none"],
    ["research","research","retrieve","safe","none"],
    ["creative","create","artifact","safe","none"],
    ["productivity","execute","tools","safe","none"],
    ["conversation","chat","answer","safe","none"],
    ["research","research","retrieve","safe","none"],
  ];
  const records=texts.map((text,i)=>{
    const [domain,intent,action,risk,approval]=categories[i];
    return {features:extractSenopatiV2SparseFeatures(text),domain,intent,action,risk,approval};
  });
  return {
    format:"senopati-v2-sparse-baseline" as const,
    deployment:"candidate-only" as const,
    heads:Object.fromEntries(Object.entries(SENOPATI_V2_HEADS).map(([h,labels])=>[h,[...labels]])) as any,
    records,
  };
}
const queries=[
 ["tulis email untuk rekan",""],["perbaiki API backend NestJS",""],
 ["jelaskan fotosintesis",""],["saya setuju","PLANNING_PENDING"],
 ["rm -rf hapus data",""],["buat poster seminar",""],
 ["setel pengingat besok",""],["some completely unknown words!!!!!",""],
 ["",""],["???!!!",""],["message context",""],["hello there",""],
 ["tUlIs, EMAIL???",""],["  pesan   berulang   ",""],
 ["aproval","PLANNING_PENDING"],["hapus folder",""],
 ["👋✨ ß ñ sáng",""],["hello","PLANNING_PENDING"],["i need an agent to code",""],
] as const;

describe("Senopati V2 indexed shadow",()=>{
  it("keeps exact head parity and floating-score near-parity for all queries",()=>{
    const payload=fixture();
    const reference=new SenopatiV2Shadow(payload as any);
    const indexed=new SenopatiV2IndexedShadow(payload as any);
    for(const [text,context] of queries){
      for(const guarded of [false,true]){
        const expected=guarded?reference.predictGuarded(text,context):reference.predict(text,context);
        const actual=guarded?indexed.predictGuarded(text,context):indexed.predict(text,context);
        expect(actual.labels).toEqual(expected.labels);
        expect(actual.authorizesExecution).toBe(false);
        expect(actual.relativeScores.domain).toBeCloseTo(expected.relativeScores.domain,10);
        for(const head of Object.keys(expected.relativeScores) as Array<keyof typeof expected.relativeScores>){
          expect(actual.relativeScores[head]).toBeCloseTo(expected.relativeScores[head],10);
        }
      }
    }
    expect(indexed.stats.records).toBe(10);
    expect(indexed.stats.features).toBeGreaterThan(10);
  });
  it("copies validated payload rather than trusting caller mutations",()=>{
    const payload=fixture();
    const indexed=new SenopatiV2IndexedShadow(payload as any);
    const first=indexed.predict("tulis email untuk rekan");
    payload.records[0].features["w:tulis"]=999999;
    payload.records[0].domain="operations";
    expect(indexed.predict("tulis email untuk rekan")).toEqual(first);
  });
  it("rejects oversized user text and untrusted context before allocating feature vectors",()=>{
    const classifier=new SenopatiV2IndexedShadow(fixture() as any);
    expect(()=>classifier.predict("x".repeat(8193))).toThrow(/bounded size/);
    expect(()=>classifier.predict("yes","P".repeat(513))).toThrow(/bounded size/);
  });
  it("preserves negative behavior for malformed candidate and unsafe vectors",()=>{
    const payload=fixture();
    expect(()=>new SenopatiV2IndexedShadow({...payload,deployment:"production"} as any)).toThrow();
    payload.records[0].features["w:bad"]=Infinity;
    expect(()=>new SenopatiV2IndexedShadow(payload as any)).toThrow();
  });
});
