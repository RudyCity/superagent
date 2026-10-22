/**
 * Senopati V2 compact inverted index (experiment, not production).
 * Stores feature postings in contiguous typed arrays and labels in 5 Uint8 arrays.
 * No duplicated per-record JS feature objects remain after initialization.
 * Feature-order dot accumulation + corpus-order tie breaking preserve Rudy parity.
 */
import { extractSenopatiV2SparseFeatures, SENOPATI_V2_HEADS, SenopatiV2Shadow,
  type SenopatiV2SparsePayload, type SenopatiV2ShadowPrediction, type SenopatiV2ShadowLabels } from "./senopatiV2Shadow.js";
import { guardSenopatiV2Shadow } from "./senopatiV2Safety.js";

type Head=keyof typeof SENOPATI_V2_HEADS;
const HEADS:Head[]=["domain","intent","action","risk","approval"];
type PostingSpan={start:number;end:number};

export class SenopatiV2CompactShadow {
  private readonly spans: Map<string,PostingSpan>;
  private readonly ids:Uint16Array;
  private readonly weights:Float64Array;
  private readonly norms:Float64Array;
  private readonly labelIds:Record<Head,Uint8Array>;
  private readonly count:number;

  constructor(payload:SenopatiV2SparsePayload){
    // Enforce the same candidate-only schema, feature and label bounds as reference.
    new SenopatiV2Shadow(payload);
    this.count=payload.records.length;
    this.norms=new Float64Array(this.count);
    this.labelIds={} as Record<Head,Uint8Array>;
    for(const head of HEADS)this.labelIds[head]=new Uint8Array(this.count);

    const counts=new Map<string,number>();
    let edges=0;
    for(const row of payload.records){
      for(const feature of Object.keys(row.features)){
        edges++;
        if(edges>1_000_000)throw new Error("Compact index feature budget exceeded");
        counts.set(feature,(counts.get(feature)??0)+1);
      }
    }

    this.spans=new Map();
    let start=0;
    for(const [feature,count] of counts){
      this.spans.set(feature,{start,end:start+count});
      start+=count;
    }
    this.ids=new Uint16Array(edges);
    this.weights=new Float64Array(edges);
    // Fill pointers are temporary; not held by the completed model.
    const offsets=new Map<string,number>();
    for(const [feature,span] of this.spans)offsets.set(feature,span.start);
    for(let rowId=0;rowId<this.count;rowId++){
      const row=payload.records[rowId];
      let squared=0;
      for(const [feature,value] of Object.entries(row.features)){
        squared+=value*value;
        const offset=offsets.get(feature);
        if(offset===undefined)throw new Error("Compact feature unexpectedly missing");
        this.ids[offset]=rowId;
        this.weights[offset]=value;
        offsets.set(feature,offset+1);
      }
      this.norms[rowId]=Math.sqrt(squared);
      for(const head of HEADS){
        const label=(SENOPATI_V2_HEADS[head] as readonly string[]).indexOf(row[head]);
        if(label<0)throw new Error("Unrecognized compact head label "+head);
        this.labelIds[head][rowId]=label;
      }
    }
    // Incoming payload and temporary offsets/maps can be GC'd by caller.
  }

  predict(text:string,context=""):SenopatiV2ShadowPrediction{
    if(typeof text!=="string"||typeof context!=="string"||
       text.length>8192||context.length>512)
      throw new Error("Compact shadow input exceeds bounded size");
    const input=context?`context ${context} message ${text}`:`message ${text}`;
    const features=extractSenopatiV2SparseFeatures(input);
    const terms=Object.entries(features);
    let querySquared=0;
    // Typed arrays are per-call: safe for overlapping async/worker usage.
    const dots=new Float64Array(this.count);
    const visited=new Uint8Array(this.count);
    const touched:number[]=[];
    // Iterate query features in their original Rudy insertion order.
    for(const [feature,weight] of terms){
      querySquared+=weight*weight;
      const span=this.spans.get(feature);
      if(!span)continue;
      for(let offset=span.start;offset<span.end;offset++){
        const id=this.ids[offset];
        if(visited[id]===0){visited[id]=1;touched.push(id);}
        dots[id]+=weight*this.weights[offset];
      }
    }
    touched.sort((a,b)=>a-b);
    const queryNorm=Math.sqrt(querySquared);
    const top=Object.fromEntries(HEADS.map(head=>[
      head,Object.fromEntries(SENOPATI_V2_HEADS[head].map(label=>[label,[0,0]]))
    ])) as Record<Head,Record<string,number[]>>;
    for(const id of touched){
      const similarity=dots[id]/Math.max(0.00001,queryNorm*this.norms[id]);
      if(similarity<=0)continue;
      for(const head of HEADS){
        const label=SENOPATI_V2_HEADS[head][this.labelIds[head][id]];
        const maxima=top[head][label];
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
      let bestScore=-1,total=0;
      for(const label of SENOPATI_V2_HEADS[head]){
        const pair=top[head][label];
        const score=pair[0]+pair[1]*0.25;
        total+=Math.max(0,score);
        if(score>bestScore){bestScore=score;bestLabel=label;}
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
    return {
      records:this.count,features:this.spans.size,postings:this.ids.length,
      numericBytes:this.ids.byteLength+this.weights.byteLength+this.norms.byteLength+
        HEADS.reduce((sum,head)=>sum+this.labelIds[head].byteLength,0),
    };
  }
}
