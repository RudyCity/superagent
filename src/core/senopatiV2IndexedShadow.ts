/**
 * Indexed, observational Senopati V2 sparse classifier.
 * Inverted postings avoid comparing every model record against unrelated text.
 * Preserves Rudy's two-best similarities/class and original corpus order.
 * Never changes the existing production path or grants tool authority.
 */
import { extractSenopatiV2SparseFeatures, SENOPATI_V2_HEADS, SenopatiV2Shadow, type SenopatiV2SparsePayload, type SenopatiV2ShadowPrediction, type SenopatiV2ShadowLabels } from "./senopatiV2Shadow.js";
import { guardSenopatiV2Shadow } from "./senopatiV2Safety.js";

type Head = keyof typeof SENOPATI_V2_HEADS;
const HEADS: Head[]=["domain","intent","action","risk","approval"];
type IndexedRow={features:Record<string,number>;norm:number;labels:Record<Head,string>};

export class SenopatiV2IndexedShadow {
  private readonly vectors: IndexedRow[];
  private readonly posting: Map<string,number[]>;
  constructor(payload:SenopatiV2SparsePayload){
    // Reuse the reference loader's complete candidate/schema/weight validation.
    new SenopatiV2Shadow(payload);
    this.posting=new Map<string,number[]>();
    let featureEdges=0;
    this.vectors=payload.records.map((row,id)=>{
      let sq=0;
      for(const [feature,value] of Object.entries(row.features)){
        featureEdges++;
        if(featureEdges>1_000_000)
          throw new Error("Indexed shadow feature budget exceeded");
        sq+=value*value;
        const ids=this.posting.get(feature);
        if(ids)ids.push(id);
        else this.posting.set(feature,[id]);
      }
      return {
        // Defensive copy prevents mutation of the caller's payload post-validation.
        features:Object.assign(Object.create(null),row.features) as Record<string,number>,
        norm:Math.sqrt(sq),
        labels:Object.fromEntries(HEADS.map(h=>[h,row[h]])) as Record<Head,string>,
      };
    });
  }

  predict(text:string,context=""):SenopatiV2ShadowPrediction {
    if(typeof text!=="string" || typeof context!=="string" ||
       text.length>8192 || context.length>512)
      throw new Error("Indexed shadow input exceeds bounded size");
    const input=context?`context ${context} message ${text}`:`message ${text}`;
    const query=extractSenopatiV2SparseFeatures(input);
    const terms=Object.entries(query);
    let querySum=0;
    const touched=new Set<number>();
    for(const [feature,value] of terms){
      querySum+=value*value;
      const matches=this.posting.get(feature);
      if(matches)for(const id of matches)touched.add(id);
    }
    const qNorm=Math.sqrt(querySum);
    const ordered=[...touched].sort((a,b)=>a-b);
    const top=Object.fromEntries(HEADS.map(head=>[
      head,Object.fromEntries(SENOPATI_V2_HEADS[head].map(label=>[label,[0,0]]))
    ])) as Record<Head,Record<string,number[]>>;
    for(const index of ordered){
      const row=this.vectors[index];
      let dot=0;
      // Preserve the reference per-query-feature summation order exactly.
      for(const [feature,value] of terms)dot+=value*(row.features[feature]||0);
      const similarity=dot/Math.max(0.00001,qNorm*row.norm);
      if(similarity<=0)continue;
      for(const head of HEADS){
        const maxima=top[head][row.labels[head]];
        if(similarity>maxima[0]){
          maxima[1]=maxima[0];
          maxima[0]=similarity;
        }else if(similarity>maxima[1])maxima[1]=similarity;
      }
    }
    const labels={} as SenopatiV2ShadowLabels;
    const relativeScores={} as Record<Head,number>;
    for(const head of HEADS){
      let bestLabel:string=SENOPATI_V2_HEADS[head][0];
      let bestScore=-1;
      let total=0;
      for(const label of SENOPATI_V2_HEADS[head]){
        const pair=top[head][label];
        const score=pair[0]+pair[1]*0.25;
        total+=Math.max(0,score);
        if(score>bestScore){
          bestScore=score;
          bestLabel=label;
        }
      }
      (labels as Record<string,string>)[head]=bestLabel;
      relativeScores[head]=total>0?Math.max(0,bestScore)/total:1/SENOPATI_V2_HEADS[head].length;
    }
    return {labels,relativeScores,source:"senopati-v2-sparse-shadow",authorizesExecution:false};
  }
  predictGuarded(text:string,context=""):SenopatiV2ShadowPrediction{
    return guardSenopatiV2Shadow(this.predict(text,context),text,context);
  }
  get stats(){
    let edges=0;
    for(const ids of this.posting.values())edges+=ids.length;
    return {records:this.vectors.length,features:this.posting.size,postings:edges};
  }
}
