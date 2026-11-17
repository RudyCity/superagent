/** Read public HTTP(S) tab metadata through loopback without launching Chrome or calling CDP scripts. */
import http from "node:http";
const MAX_BYTES=256*1024;
function probe(port:number):Promise<unknown>{
 return new Promise((resolve,reject)=>{
   const req=http.get({hostname:"127.0.0.1",port,path:"/json/list",timeout:2500,
     headers:{Accept:"application/json"}},res=>{
     if(res.statusCode!==200){res.resume();reject(Error("Chrome CDP metadata unavailable"));return;}
     const parts:Buffer[]=[];let used=0;
     res.on("data",(chunk:Buffer)=>{
       used+=chunk.length;
       if(used>MAX_BYTES){req.destroy(Error("Chrome metadata exceeds 256 KiB"));return;}
       parts.push(chunk);
     });
     res.on("end",()=>{
       try{resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));}
       catch{reject(Error("Invalid Chrome metadata JSON"));}
     });
     res.on("error",reject);
   });
   req.on("timeout",()=>req.destroy(Error("Chrome metadata timed out")));
   req.on("error",reject);
 });
}
export async function safeManagedChromeObservation(args:Record<string,unknown>):Promise<string>{
 if(args.command!=="list_targets"&&args.command!=="transport_status")
   throw Error("Uncertified Chrome CDP action");
 if(args.transport!==undefined&&args.transport!=="managed")
   throw Error("Only managed transport is certified");
 const host=process.env.SUPERAGENT_CDP_HOST||"127.0.0.1";
 if(!["127.0.0.1","localhost","::1","[::1]"].includes(host))
   throw Error("Remote Chrome CDP host is not certified");
 const port=args.debug_port??(Number(process.env.SUPERAGENT_CDP_PORT)||9222);
 if(!Number.isSafeInteger(port)||Number(port)<1024||Number(port)>65535)
   throw Error("Invalid local CDP port");
 const data=await probe(Number(port));
 if(!Array.isArray(data))throw Error("Unexpected CDP metadata shape");
 const targets:Array<{id:string;title:string;url:string}>=[];
 for(const item of data.slice(0,100)){
   if(!item||typeof item!=="object"||item.type!=="page"||
     typeof item.id!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(item.id)||
     typeof item.url!=="string")continue;
   let url:URL;
   try{url=new URL(item.url);}catch{continue;}
   if(url.protocol!=="http:"&&url.protocol!=="https:")continue;
   url.username="";url.password="";
   const title=typeof item.title==="string"?
     item.title.replace(/[\r\n\t\u0000-\u001f]/g," ").slice(0,160):"";
   targets.push({id:item.id,title,url:url.toString()});
 }
 if(args.command==="transport_status")return JSON.stringify({
   transport:"managed",host:"127.0.0.1",port,
   reachable:true,certifiedHttpTargets:targets.length,
   browserLaunch:false,localFileTabsExcluded:true});
 return targets.length?targets.map(t=>
   `- id: ${t.id}\n  title: ${t.title}\n  url: ${t.url}`).join("\n"):
   "Chrome CDP reachable; no certified HTTP(S) page targets.";
}
