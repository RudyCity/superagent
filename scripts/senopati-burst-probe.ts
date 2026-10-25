/** Read-only burst load probe; measures IPC availability without storing prompt text. */
import {requestSharedSenopatiPrediction,sharedSenopatiStatus} from "../src/core/senopatiSharedClient.js";
const count=Math.min(128,Math.max(1,Number(process.argv[2]??32)));
const parallel=Math.min(48,Math.max(1,Number(process.argv[3]??16)));
const workerTag=String(process.argv[4]??"single").replace(/[^a-z0-9-]/gi,"").slice(0,32);
const texts=[
  "Tolong cari dokumentasi proyek",
  "Jelaskan prinsip least privilege secara umum",
  "Help me research the public API documentation",
  "Tolong ringkas struktur kode program ini",
  "What does thread synchronization mean?",
  "Jelaskan kenapa privasi penting pada aplikasi",
  "Halo, apa kabar?",
  "Please summarize the architecture",
];
let next=0,success=0,failure=0;
const latencies:number[]=[];
const began=performance.now();
await Promise.all(Array.from({length:parallel},async ()=>{
  for(;;){
    const i=next++;
    if(i>=count)return;
    const start=performance.now();
    const x=await requestSharedSenopatiPrediction(texts[i%texts.length]+" ("+workerTag+"-"+i+")","int8_embedding");
    latencies.push(performance.now()-start);
    if(x && Number.isFinite(x.confidence))success++;
    else failure++;
  }
}));
latencies.sort((a,b)=>a-b);
const p=(n:number)=>latencies[Math.min(latencies.length-1,Math.round((latencies.length-1)*n))];
console.log("SENOPATI_BURST",JSON.stringify({
  requested:count,parallel,success,failure,successPct:Math.round(100*success/count),
  elapsedMs:Math.round(performance.now()-began),
  latencyMedianMs:Math.round(p(.5)),latencyP95Ms:Math.round(p(.95)),
  health:await sharedSenopatiStatus(),
}));
