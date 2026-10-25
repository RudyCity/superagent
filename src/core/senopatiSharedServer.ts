/** Private single-owner ONNX inference named-pipe server; no tool execution. */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import {sharedEndpoint,sharedRegistry,readSharedCredentials,sharedSenopatiStatus,
        validSharedPrediction} from "./senopatiSharedClient.js";
import type {ModernPrecision,ModernPrediction} from "./senopatiModernBert.js";

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
 let running=0,accepted=0,rejected=0,stopping=false;
 let server:net.Server;
 const stop=async()=>{
  if(stopping)return;
  stopping=true;
  const now=readSharedCredentials();
  if(now?.secret===token && now.pid===process.pid){
   try{fs.rmSync(sharedRegistry,{force:true});}catch{}
  }
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  if(process.platform!=="win32"){
   try{fs.rmSync(sharedEndpoint,{force:true});}catch{}
  }
 };
 server=net.createServer(socket=>{
  socket.setTimeout(4500);
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
    if(p.type==="health"){
     const state=getDetails();
     send({ok:true,status:{
       pid:process.pid,precision:state.precision,
       tokenizerEngine:state.tokenizerEngine,
       rssMiB:Math.round(process.memoryUsage().rss/1048576),
       accepted,rejected,active:running,
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
    if(running>=8){rejected++;send({ok:false,error:"busy"});return;}
    running++;
    try{
     const prediction=await infer(p.text,p.precision);
     if(!validSharedPrediction(prediction)){
      rejected++;send({ok:false,error:"model-unavailable"});return;
     }
     accepted++;
     send({ok:true,precision:p.precision,prediction});
    }catch{
     rejected++;send({ok:false,error:"inference-failed"});
    }finally{running--;}
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
