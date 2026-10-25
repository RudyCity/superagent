/** Multi-process Senopati load test: 4 independent Bun clients, shared model.
 *
 * Usage: bun scripts/senopati-multiprocess-bench.ts [workers=4] [requestsEach=48]
 * No customer data, no tool execution, no new ONNX sessions in clients.
 */
import {spawn} from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import {sharedSenopatiStatus} from "../src/core/senopatiSharedClient.js";
const root=process.cwd();
const workers=Math.max(1,Math.min(6,Number(process.argv[2]??4)));
const count=Math.max(1,Math.min(128,Number(process.argv[3]??48)));
const workerFile=path.join(root,"scripts","senopati-burst-probe.ts");
const before=await sharedSenopatiStatus();
if(!before)throw new Error("Shared Senopati unavailable: no load test");
const started=performance.now();
const results=await Promise.all(Array.from({length:workers},async (_,i)=>{
  return await new Promise<any>((resolve)=>{
    const proc=spawn(process.execPath,[workerFile,String(count),"12","worker-"+i+"-v4-profile"],{
      cwd:root,windowsHide:true,env:process.env,stdio:["ignore","pipe","pipe"],
    });
    let text="",finished=false;
    const complete=(value:any)=>{
      if(finished)return;
      finished=true;
      clearTimeout(deadline);
      resolve(value);
    };
    const deadline=setTimeout(()=>{proc.kill();complete({worker:i,error:"timeout"});},45000);
    proc.stdout.on("data",buffer=>{text+=buffer.toString("utf8").slice(0,3000);});
    proc.stderr.on("data",buffer=>{text+=buffer.toString("utf8").slice(0,3000);});
    proc.once("error",e=>complete({worker:i,error:e.message}));
    proc.once("close",code=>{
      const marker=text.split("\n").find(x=>x.includes("SENOPATI_BURST "));
      try{
        if(code!==0 || !marker)throw Error("worker returned code "+code);
        const data=JSON.parse(marker.slice(marker.indexOf("SENOPATI_BURST ")+15));
        complete({worker:i,exit:code,requested:data.requested,success:data.success,
          failure:data.failure,elapsedMs:data.elapsedMs,latencyP95Ms:data.latencyP95Ms});
      }catch(error){complete({worker:i,error:String(error).slice(0,250)});}
    });
  });
}));
const after=await sharedSenopatiStatus();
const summary={
  researchOnly:true,
  workers,requestsEach:count,totalRequests:workers*count,
  succeeded:results.reduce((s,x)=>s+(x.success||0),0),
  failed:results.reduce((s,x)=>s+(x.failure||0),0),
  totalElapsedMs:Math.round(performance.now()-started),
  usedOneModelPid:results.every(x=>!x.error) && before.pid===after?.pid,
  modelPid:after?.pid||null,
  serverRssMiB:after?.rssMiB||null,
  noToolExecution:true,
  workerResults:results,
};
console.log("SENOPATI_MULTIPROCESS",JSON.stringify(summary));
const dir=path.join(root,"models","senopati","mmbert-v64-seed73");
const report=path.join(dir,"multiprocess_load_report_v4_profile_isolated.json");
if(fs.existsSync(report))throw new Error("Refuse overwrite existing multiprocess benchmark");
fs.writeFileSync(report,JSON.stringify(summary,null,2)+"\n");
if(summary.failed || summary.succeeded!==summary.totalRequests || !summary.usedOneModelPid)
  process.exitCode=1;
