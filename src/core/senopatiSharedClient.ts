/** Local authenticated Senopati IPC client; never used for tool permission. */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import {getRootConfigDir,getPackageRootDir} from "./config/paths.js";
import type {ModernPrediction,ModernPrecision} from "./senopatiModernBert.js";
/** IPC identity is scoped to BOTH this installation and config profile.
 * Workspaces sharing the same profile reuse one model; isolated test/staging
 * profiles cannot collide on a single OS named pipe.
 */
export function senopatiIpcNamespace(packageRoot:string,configRoot:string):string{
  return crypto.createHash("sha256")
    .update(path.resolve(packageRoot).toLowerCase())
    .update(String.fromCharCode(0))
    .update(path.resolve(configRoot).toLowerCase())
    .digest("hex").slice(0,20);
}
const label=senopatiIpcNamespace(getPackageRootDir(),getRootConfigDir());
export const sharedEndpoint=process.platform==="win32" ?
  "\\\\.\\pipe\\superagent-senopati-"+label:
  path.join(getRootConfigDir(),"ipc","senopati-"+label+".sock");
export const sharedRegistry=path.join(getRootConfigDir(),"ipc","senopati-"+label+".json");
export type SharedHealth={
  pid:number;precision:ModernPrecision;tokenizerEngine:string;
  rssMiB:number;active:number;accepted:number;rejected:number;
  queued?:number;overloaded?:number;queueTimedOut?:number;queueCanceled?:number;
};
export type SharedPacket={
  ok:boolean;precision?:ModernPrecision;prediction?:ModernPrediction;
  status?:SharedHealth;error?:string;
};
export function readSharedCredentials():{secret:string;endpoint:string;pid:number}|null{
  try{
    const st=fs.lstatSync(sharedRegistry);
    if(!st.isFile() || st.size<40 || st.size>2048)return null;
    const r=JSON.parse(fs.readFileSync(sharedRegistry,"utf8"));
    if(r.version!==1 || r.endpoint!==sharedEndpoint ||
       typeof r.secret!=="string" || !/^[A-Za-z0-9_-]{43}$/.test(r.secret) ||
       !Number.isInteger(r.pid) || r.pid<1)return null;
    return {secret:r.secret,endpoint:sharedEndpoint,pid:r.pid};
  }catch{return null;}
}
export function validSharedPrediction(x:unknown):x is ModernPrediction{
  if(!x || typeof x!=="object" || Array.isArray(x))return false;
  const p=x as Partial<ModernPrediction>;
  const permitted=new Set(["intent","confidence","riskProbability","score","modelName"]);
  if(Object.keys(x).some(key=>!permitted.has(key)))return false;
  return p.modelName==="mmbert-v64-seed73-hard" &&
   ["answer","artifact","delegate","none","retrieve","tools"].includes(String(p.intent)) &&
   typeof p.confidence==="number" && p.confidence>=0 && p.confidence<=1 &&
   typeof p.riskProbability==="number" && p.riskProbability>=0 && p.riskProbability<=1 &&
   typeof p.score==="number" && p.score>=1 && p.score<=5;
}
export async function queryShared(
 type:"health"|"infer"|"stop", precision?:ModernPrecision,text?:string,
):Promise<SharedPacket|null>{
 const identity=readSharedCredentials();
 if(!identity)return null;
 const payload=JSON.stringify({version:1,type,secret:identity.secret,precision,text})+"\n";
 if(Buffer.byteLength(payload)>16384)return null;
 return new Promise(resolve=>{
  const sock=net.createConnection(identity.endpoint);
  let settled=false,raw="";
  const finish=(value:SharedPacket|null)=>{
   if(settled)return;
   settled=true;
   clearTimeout(deadline);
   sock.destroy();
   resolve(value);
  };
  // Absolute deadline also protects against a peer trickling partial data.
  const deadline=setTimeout(()=>finish(null),12000);
  deadline.unref?.();
  // Bounded server queue may require a few seconds during short bursts.
  // Fail back to legacy after the deadline; never start another local model.
  sock.setTimeout(11500);
  sock.once("connect",()=>sock.write(payload));
  sock.on("data",(chunk:Buffer)=>{
   raw+=chunk.toString("utf8");
   if(Buffer.byteLength(raw)>8192){finish(null);return;}
   const i=raw.indexOf("\n");if(i<0)return;
   try{
    const out=JSON.parse(raw.slice(0,i));
    finish(out && typeof out.ok==="boolean"?out:null);
   }catch{finish(null);}
  });
  sock.once("timeout",()=>finish(null));
  sock.once("error",()=>finish(null));
  sock.once("end",()=>finish(null));
 });
}
export async function sharedSenopatiStatus():Promise<SharedHealth|null>{
 const p=await queryShared("health");
 return p?.ok && p.status && Number.isInteger(p.status.pid)?p.status:null;
}
export async function requestSharedSenopatiPrediction(text:string,precision:ModernPrecision):
  Promise<ModernPrediction|null>{
 if(typeof text!=="string" || !text.trim() || text.length>6000)return null;
 const p=await queryShared("infer",precision,text);
 return p?.ok && p.precision===precision && validSharedPrediction(p.prediction)
  ? p.prediction : null;
}
export async function stopSharedSenopati():Promise<boolean>{
 return (await queryShared("stop"))?.ok===true;
}
