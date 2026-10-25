/** Private single-owner ONNX inference named-pipe server; no tool execution. */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import {sharedEndpoint,sharedRegistry,readSharedCredentials,sharedSenopatiStatus,
        validSharedPrediction} from "./senopatiSharedClient.js";
import type {ModernPrecision,ModernPrediction} from "./senopatiModernBert.js";
import {SenopatiBoundedQueue} from "./senopatiSharedQueue.js";
import {acquireSenopatiModelStartLease} from "./senopatiStartLease.js";

export type SharedServer={
 pid:number;endpoint:string;stop:()=>Promise<void>;
};
export async function serveSenopatiShared(
 infer:(text:string,precision:ModernPrecision)=>Promise<ModernPrediction|null>,
 getDetails:()=>{precision:ModernPrecision;tokenizerEngine:string},
):Promise<SharedServer>{
 if(await sharedSenopatiStatus())throw new Error("Senopati shared server already online");
 if(process.platform!=="win32" && fs.existsSync(sharedEndpoint)){
  throw new Error("Existing Unix socket requires manual cleanup");
 }
 const token=crypto.randomBytes(32).toString("base64url");
 let accepted=0,rejected=0,stopping=false;
 const openSockets=new Set<net.Socket>();
 // One ORT model instance, at most four active inferences and 64 waiting.
 // Busy clients never spawn another 500+ MiB model.
 const queue=new SenopatiBoundedQueue<ModernPrediction>(4,64,7000);
 let server:net.Server;
 const stop=async()=>{
  if(stopping)return;
  // Fence model replacement before changing the IPC registry or accepting
  // shutdown. A watchdog must never allocate another large ONNX session
  // while this owner is draining outstanding inference requests.
  const shutdownLease=acquireSenopatiModelStartLease();
  stopping=true;
  queue.close();
  try {
   await new Promise<void>(resolve=>{
    let finished=false;
    const complete=()=>{
     if(finished)return;
     finished=true;
     clearTimeout(deadline);
     resolve();
    };
    const deadline=setTimeout(()=>{
     for(const socket of openSockets)socket.destroy();
     complete();
    },15_000);
    server.close(()=>complete());
   });
   // Remove the bearer registry only after service requests have drained.
   const current=readSharedCredentials();
   if(current?.secret===token && current.pid===process.pid){
    try{fs.rmSync(sharedRegistry,{force:true});}catch{}
   }
   if(process.platform!=="win32"){
    try{fs.rmSync(sharedEndpoint,{force:true});}catch{}
   }
  } finally {
   shutdownLease.release();
  }
 };
 server=net.createServer(socket=>{
  openSockets.add(socket);
  socket.once("close",()=>openSockets.delete(socket));
  if(stopping){socket.destroy();return;}
  // Longer than the 7s queue wait, but still bounded.
  socket.setTimeout(10500);
  const requestAborted = new AbortController();
  socket.once("close", () => requestAborted.abort());
  let buffer="",seen=false;
  const send=(p:Record<string,unknown>)=>{
   const response=JSON.stringify(p)+"\n";
   if(Buffer.byteLength(response)>8192){socket.destroy();return;}
   socket.end(response);
  };
  socket.once("timeout",()=>{rejected++;socket.destroy();});
  socket.once("error",()=>socket.destroy());
  socket.on("data",chunk=>{
   if(seen){rejected++;socket.destroy();return;}
   buffer+=chunk.toString("utf8");
   if(Buffer.byteLength(buffer)>16384){rejected++;socket.destroy();return;}
   const end=buffer.indexOf("\n");if(end===-1)return;
   seen=true;
   void(async()=>{
    let p:any;
    try{p=JSON.parse(buffer.slice(0,end));}
    catch{rejected++;send({ok:false,error:"invalid-json"});return;}
    const supplied=typeof p?.secret==="string"?Buffer.from(p.secret):Buffer.alloc(0);
    const expected=Buffer.from(token);
    if(p?.version!==1 || supplied.length!==expected.length ||
       !crypto.timingSafeEqual(supplied,expected)){
      rejected++;send({ok:false,error:"unauthorized"});return;
    }
    if(stopping && p.type!=="stop"){
     rejected++;send({ok:false,error:"draining"});return;
    }
    if(p.type==="health"){
     const state=getDetails();
     send({ok:true,status:{
       pid:process.pid,precision:state.precision,
       tokenizerEngine:state.tokenizerEngine,
       rssMiB:Math.round(process.memoryUsage().rss/1048576),
       // "rejected" is the total failed responses; queue counters below
       // are breakdowns, not values to add a second time.
       accepted,rejected,
       active:queue.stats().active,
       queued:queue.stats().queued,
       overloaded:queue.stats().rejected,
       queueTimedOut:queue.stats().timedOut,
       queueCanceled:queue.stats().canceled,
     }});
     return;
    }
    if(p.type==="stop"){
     send({ok:true});
     setImmediate(()=>{void stop();});
     return;
    }
    if(p.type!=="infer" || typeof p.text!=="string" ||
       !p.text.trim() || p.text.length>6000 ||
       p.precision!==getDetails().precision){
      rejected++;send({ok:false,error:"invalid-request"});return;
    }
    // Full queue responds with a bounded denial; queued tasks expire
    // without running when overloaded for too long.
    try{
     const prediction=await queue.run(()=>infer(p.text,p.precision),requestAborted.signal);
     if(!validSharedPrediction(prediction)){
      rejected++;
      send({ok:false,error:"model-busy-or-unavailable"});
      return;
     }
     accepted++;
     send({ok:true,precision:p.precision,prediction});
    }catch{
     rejected++;send({ok:false,error:"inference-failed"});
    }
   })();
  });
 });
 await new Promise<void>((resolve,reject)=>{
  server.once("error",reject);
  server.listen(sharedEndpoint,()=>{server.off("error",reject);resolve();});
 });
 try{
  fs.mkdirSync(path.dirname(sharedRegistry),{recursive:true,mode:0o700});
  const temp=sharedRegistry+"."+process.pid+".tmp";
  fs.writeFileSync(temp,JSON.stringify({
    version:1,secret:token,pid:process.pid,endpoint:sharedEndpoint,
  }),{encoding:"utf8",mode:0o600,flag:"wx"});
  try{fs.chmodSync(temp,0o600);}catch{}
  fs.renameSync(temp,sharedRegistry);
 }catch(e){await stop();throw e;}
 process.once("exit",()=>{
  const current=readSharedCredentials();
  if(current?.pid===process.pid && current.secret===token){
   try{fs.rmSync(sharedRegistry,{force:true});}catch{}
  }
 });
 return {pid:process.pid,endpoint:sharedEndpoint,stop};
}
