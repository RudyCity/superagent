/** Read public HTTP(S) tab metadata through loopback without launching Chrome or calling CDP scripts. */
import http from "node:http";
const MAX_BYTES=256*1024;
function probe(port:number):Promise<unknown>{
 return new Promise((resolve,reject)=>{
   const req=http.get({hostname:"127.0.0.1",port,path:"/json/list",timeout:2500,
     headers:{Accept:"application/json"}},res=>{
     if(res.statusCode!==200){res.resume();reject(Error("CDP_HTTP_UNEXPECTED_RESPONSE"));return;}
     const parts:Buffer[]=[];let used=0;
     res.on("data",(chunk:Buffer)=>{
       used+=chunk.length;
       if(used>MAX_BYTES){req.destroy(Error("CDP_METADATA_TOO_LARGE"));return;}
       parts.push(chunk);
     });
     res.on("end",()=>{
       try{resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));}
       catch{reject(Error("CDP_INVALID_METADATA_JSON"));}
     });
     res.on("error",reject);
   });
   req.on("timeout",()=>req.destroy(Error("CDP_METADATA_TIMEOUT")));
   req.on("error",reject);
 });
}
/** Report only bounded codes, never raw OS errors that may include paths or data. */
function probeFailureCode(error:unknown):string{
 const code=(error && typeof error==="object" && "code" in error)
   ? String((error as {code:unknown}).code):"";
 if(code==="ECONNREFUSED")return "CDP_ENDPOINT_REFUSED";
 if(code==="ETIMEDOUT" || (error instanceof Error && error.message==="CDP_METADATA_TIMEOUT"))
   return "CDP_ENDPOINT_TIMEOUT";
 if(code==="ECONNRESET" || code==="EPIPE")return "CDP_ENDPOINT_CLOSED";
 if(error instanceof Error && /^CDP_[A-Z_]+$/.test(error.message))return error.message;
 return "CDP_ENDPOINT_UNAVAILABLE";
}
function endpointHint(port:number):string{
 return "No usable Chrome CDP metadata endpoint at 127.0.0.1:"+port+
   ". Select the actual loopback debugging port with debug_port, or use an approved"+
   " Chrome Delegate transport. MCP approval does not start a Chrome CDP listener.";
}
export async function safeManagedChromeObservation(args:Record<string,unknown>):Promise<string>{
 if(args.command!=="list_targets"&&args.command!=="transport_status")
   throw Error("Uncertified Chrome CDP action");
 if(args.transport!==undefined&&args.transport!=="managed")
   throw Error("Only managed transport is certified");
 const host=process.env.SUPERAGENT_CDP_HOST||"127.0.0.1";
 if(!["127.0.0.1","localhost","::1","[::1]"].includes(host))
   throw Error("Remote Chrome CDP host is not certified");
 const configured=Number(process.env.SUPERAGENT_CDP_PORT);
 const port=args.debug_port??(configured||9222);
 if(!Number.isSafeInteger(port)||Number(port)<1024||Number(port)>65535)
   throw Error("Invalid local CDP port");
 const portSource=args.debug_port!==undefined?"explicit":configured?"environment":"default";
 let data:unknown;
 try{
   data=await probe(Number(port));
 }catch(error){
   const failureCode=probeFailureCode(error);
   if(args.command==="transport_status")return JSON.stringify({
     transport:"managed",host:"127.0.0.1",port,portSource,reachable:false,
     failureCode,diagnostic:endpointHint(Number(port)),
     browserLaunch:false,localFileTabsExcluded:true,
   });
   throw Error(failureCode+": "+endpointHint(Number(port)));
 }
 if(!Array.isArray(data))throw Error("Unexpected CDP metadata shape");
 const targets:Array<{id:string;title:string;url:string}>=[];
 for(const item of data.slice(0,100)){
   if(!item||typeof item!=="object"||item.type!=="page"||
     typeof item.id!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(item.id)||
     typeof item.url!=="string")continue;
   let url:URL;
   try{url=new URL(item.url);}catch{continue;}
   if(url.protocol!=="http:"&&url.protocol!=="https:")continue;
   // Page queries/fragments may contain credentials; inventory is not content access.
   url.username="";url.password="";url.search="";url.hash="";
   const title=typeof item.title==="string"?
     item.title.replace(/[\\r\\n\\t\\u0000-\\u001f]/g," ").slice(0,160):"";
   targets.push({id:item.id,title,url:url.toString()});
 }
 if(args.command==="transport_status")return JSON.stringify({
   transport:"managed",host:"127.0.0.1",port,portSource,
   reachable:true,certifiedHttpTargets:targets.length,
   browserLaunch:false,localFileTabsExcluded:true});
 return targets.length?targets.map(t=>
   `- id: ${t.id}\\n  title: ${t.title}\\n  url: ${t.url}`).join("\\n"):
   "Chrome CDP reachable; no certified HTTP(S) page targets.";
}
