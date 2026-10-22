import { describe, expect, it } from "vitest";
import { SenopatiV2CompactShadow } from "../src/core/senopatiV2CompactShadow.js";
import { SenopatiV2IndexedShadow } from "../src/core/senopatiV2IndexedShadow.js";
import { SenopatiV2Shadow, SENOPATI_V2_HEADS, extractSenopatiV2SparseFeatures } from "../src/core/senopatiV2Shadow.js";

function fixture(){
  const text=[
    "message tulis email kepada klien","message rm -rf hapus backup",
    "context PLANNING_PENDING message saya setuju",
    "message cek status pembayaran","message riset AI terbaru",
    "message buat ilustrasi lucu","message tulis email untuk klien",
    "message jangan hapus backup"
  ];
  const label=[
    ["writing","draft","answer","safe","none"],
    ["engineering","execute","tools","destructive","none"],
    ["conversation","approve","none","safe","affirm"],
    ["operations","ask","retrieve","sensitive","none"],
    ["research","research","retrieve","safe","none"],
    ["creative","create","artifact","safe","none"],
    ["writing","draft","answer","safe","none"],
    ["engineering","ask","answer","safe","none"],
  ];
  return {
    format:"senopati-v2-sparse-baseline" as const,
    deployment:"candidate-only" as const,
    heads:Object.fromEntries(Object.entries(SENOPATI_V2_HEADS).map(([head,names])=>[head,[...names]])) as any,
    records:text.map((row,i)=>{
      const [domain,intent,action,risk,approval]=label[i];
      return {features:extractSenopatiV2SparseFeatures(row),domain,intent,action,risk,approval};
    }),
  };
}
const cases=[
  ["tulis email kepada klien",""],
  ["rm -rf hapus backup",""],
  ["saya setuju","PLANNING_PENDING"],
  ["jangan hapus backup",""],
  ["cek status pembayaran",""],
  ["buat ilustrasi",""],
  ["what is happening",""],
  ["??!😺",""],
  ["",""],
  ["ß ñ chữ 汉字",""],
  ["hal yang benar benar baru",""],
  ["hApUs --  bAcKuP",""],
  ["⚡⚡⚡","PLANNING_PENDING"],
  ["   ",""],
  ["message",""],
  ["","PLANNING_PENDING"],
] as const;

describe("Senopati V2 compact inverted index",()=>{
  it("matches reference and indexed heads + relative shares, raw and guarded",()=>{
    const data=fixture();
    const compact=new SenopatiV2CompactShadow(data as any);
    const reference=new SenopatiV2Shadow(data as any);
    const indexed=new SenopatiV2IndexedShadow(data as any);
    for(const [text,context] of cases){
      for(const guarded of [false,true]){
        const expected=guarded?reference.predictGuarded(text,context):reference.predict(text,context);
        const got=guarded?compact.predictGuarded(text,context):compact.predict(text,context);
        const prior=guarded?indexed.predictGuarded(text,context):indexed.predict(text,context);
        expect(got.labels).toEqual(expected.labels);
        expect(got.labels).toEqual(prior.labels);
        expect(got.authorizesExecution).toBe(false);
        for(const head of Object.keys(expected.relativeScores) as Array<keyof typeof expected.relativeScores>){
          expect(got.relativeScores[head]).toBe(expected.relativeScores[head]);
          expect(got.relativeScores[head]).toBe(prior.relativeScores[head]);
        }
      }
    }
    expect(compact.stats.records).toBe(8);
    expect(compact.stats.postings).toBeGreaterThan(0);
    expect(compact.stats.numericBytes).toBeGreaterThan(0);
  });
  it("rejects malicious or malformed payloads using the shared reference validator",()=>{
    const data=fixture();
    expect(()=>new SenopatiV2CompactShadow({...data,deployment:"production"} as any)).toThrow();
    data.records[0].features["w:attack"]=Infinity;
    expect(()=>new SenopatiV2CompactShadow(data as any)).toThrow(/weight/);
  });
  it("defends against source-payload mutation after indexing",()=>{
    const data=fixture();
    const compact=new SenopatiV2CompactShadow(data as any);
    const before=compact.predict("tulis email kepada klien");
    data.records[0].features["w:tulis"]=999999;
    data.records[0].domain="operations";
    expect(compact.predict("tulis email kepada klien")).toEqual(before);
  });
  it("bounds text and untrusted context",()=>{
    const compact=new SenopatiV2CompactShadow(fixture() as any);
    expect(()=>compact.predict("x".repeat(8193))).toThrow(/bounded size/);
    expect(()=>compact.predict("ok","A".repeat(513))).toThrow(/bounded size/);
    expect(()=>compact.predict(null as any)).toThrow(/bounded size/);
  });
  it("enforces reference model record limits",()=>{
    const data=fixture();
    data.records=[];
    expect(()=>new SenopatiV2CompactShadow(data as any)).toThrow();
  });
});
