/**
 * Dedicated SuperAgent Tray management origin (NO video, screenshots or Tauri IPC).
 * Cloudflare Named Tunnel may forward HTTPS traffic to this loopback listener.
 * Only a fresh password-authenticated session can read or revoke host handles.
 * Does not proxy arbitrary Core routes or expose agent capabilities.
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { listDesktopLiveInventory, stopDesktopLiveHandle } from "./desktopLiveInventory.js";
import { trayManagementPassword, type TrayManagementPassword } from "./trayManagementPassword.js";
import { REMOTE_TRAY_LOCK_HTML, REMOTE_TRAY_MANAGER_HTML, REMOTE_TRAY_CSS, REMOTE_TRAY_JS } from "./remoteTrayGatewayHtml.js";

export interface RemoteTrayGatewayOptions {
  publicOrigin: string;
  originPort: number;
  mode?: "named" | "quick";
  passwordStore?: TrayManagementPassword;
  now?: () => number;
  inventory?: typeof listDesktopLiveInventory;
  stop?: typeof stopDesktopLiveHandle;
}
export interface RemoteTrayGateway {
  publicUrl: string;
  originPort: number;
  server: Server;
  activateQuickOrigin(url: string): void;
  close(): Promise<void>;
}
const LOOPBACK = "127.0.0.1";
const MAX_SESSIONS = 4;
const SESSION_MS = 5*60_000;
const RAY = /^[0-9a-f]{8,32}-[A-Z]{3}$/i;
const TOKEN = /^[a-f0-9]{64}$/;
type Session = { digest: Buffer; csrf: string; expiresAt: number };
function json(res:ServerResponse,status:number,data:unknown){
  res.statusCode=status;res.setHeader("Content-Type","application/json; charset=utf-8");res.end(JSON.stringify(data));
}
function page(res:ServerResponse,status:number,data:string,type="text/html; charset=utf-8"){
  res.statusCode=status;res.setHeader("Content-Type",type);res.end(data);
}
function countHeader(req:IncomingMessage,name:string):number {
  let count=0;
  for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()===name)count++;
  return count;
}
function validProxy(req:IncomingMessage,origin:string):boolean{
  const url=new URL(origin);
  return ["127.0.0.1","::1","::ffff:127.0.0.1"].includes(req.socket.remoteAddress||"") &&
    req.headers.host===url.host &&
    req.headers["x-forwarded-proto"]==="https" &&
    typeof req.headers["cf-ray"]==="string" && RAY.test(req.headers["cf-ray"]) &&
    ["host","cf-ray","x-forwarded-proto","origin","referer","cookie"]
      .every(h=>countHeader(req,h)<=1) &&
    (req.headers.origin===undefined||req.headers.origin===origin) &&
    (req.method!=="POST"||req.headers.origin===origin) &&
    (req.headers["sec-fetch-site"]===undefined||["none","same-origin"].includes(String(req.headers["sec-fetch-site"]))) &&
    (req.headers.referer===undefined||(()=>{
      try {const ref=new URL(req.headers.referer);return ref.origin===origin&&!ref.username&&!ref.password;}
      catch{return false;}
    })());
}
async function readBody(req:IncomingMessage,maxBytes:number):Promise<string>{
  let size=0;const parts:Buffer[]=[];
  for await(const chunk of req){
    size+=chunk.length;if(size>maxBytes)throw Error("BODY_TOO_LARGE");
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts).toString("utf8");
}
function digest(token:string):Buffer{return createHash("sha256").update(token).digest();}
export async function startRemoteTrayGateway(options:RemoteTrayGatewayOptions):Promise<RemoteTrayGateway>{
  if(!options||!Number.isSafeInteger(options.originPort)||options.originPort<0||options.originPort>65535)
    throw Error("INVALID_TRAY_ORIGIN_PORT");
  const quick = options.mode === "quick";
  if(options.mode && !["named","quick"].includes(options.mode))
    throw Error("INVALID_TRAY_MODE");
  let publicOrigin = "";
  if(quick){
    if(options.publicOrigin !== "") throw Error("QUICK_ORIGIN_MUST_BE_GENERATED");
  }else{
    let url:URL;
    try{url=new URL(options.publicOrigin);}catch{throw Error("INVALID_TRAY_HTTPS_ORIGIN");}
    if(url.origin!==options.publicOrigin||url.protocol!=="https:"||
       url.username||url.password||url.port||url.hostname==="localhost"||
       !/^[a-z0-9.-]{4,253}$/i.test(url.hostname)||!url.hostname.includes(".")||
       url.hostname.endsWith(".trycloudflare.com"))
      throw Error("INVALID_TRAY_HTTPS_ORIGIN");
    publicOrigin=options.publicOrigin;
  }
  const store=options.passwordStore??trayManagementPassword;
  if(!store.status().configured)throw Error("TRAY_PASSWORD_REQUIRED_BEFORE_REMOTE_EXPOSURE");
  const now=options.now??Date.now;
  const sessions=new Map<string,Session>();
  const inventory=options.inventory??listDesktopLiveInventory;
  const stop=options.stop??stopDesktopLiveHandle;
  function authorize(req:IncomingMessage):{id:string;session:Session}|null {
    const cookie=req.headers.cookie;
    if(typeof cookie!=="string"||cookie.length>1024)return null;
    const matches=cookie.split(";").map(s=>s.trim()).filter(s=>s.startsWith("sa_tray="));
    if(matches.length!==1)return null;
    const token=matches[0].slice("sa_tray=".length);
    if(!TOKEN.test(token))return null;
    const sample=digest(token);
    for(const [key,session] of sessions){
      if(session.expiresAt<=now()){sessions.delete(key);continue;}
      if(timingSafeEqual(sample,session.digest))return {id:key,session};
    }
    return null;
  }
  const server=createServer((req,res)=>{
    res.setHeader("Cache-Control","no-store, max-age=0");
    res.setHeader("Pragma","no-cache");
    res.setHeader("X-Content-Type-Options","nosniff");
    res.setHeader("Referrer-Policy","no-referrer");
    res.setHeader("X-Frame-Options","DENY");
    res.setHeader("Cross-Origin-Resource-Policy","same-origin");
    res.setHeader("Permissions-Policy","camera=(), microphone=(), geolocation=(), display-capture=()");
    res.setHeader("Content-Security-Policy","default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if(!publicOrigin||!validProxy(req,publicOrigin)||!req.url||req.url.length>128||
       !req.url.startsWith("/")||req.url.startsWith("//")||req.url.includes("?")){
      page(res,403,"Forbidden");return;
    }
    const route=req.url;
    if(req.method==="GET" && route==="/view.css"){
      page(res,200,REMOTE_TRAY_CSS,"text/css; charset=utf-8");return;
    }
    const user=authorize(req);
    if(req.method==="GET" && route==="/"){
      page(res,200,user?REMOTE_TRAY_MANAGER_HTML:REMOTE_TRAY_LOCK_HTML);return;
    }
    if(req.method==="GET" && route==="/view.js"){
      if(!user){page(res,401,"Unauthorized");return;}
      page(res,200,REMOTE_TRAY_JS,"text/javascript; charset=utf-8");return;
    }
    if(req.method==="POST" && route==="/login"){
      void(async()=>{
        try{
          if(req.headers["content-type"]!=="application/x-www-form-urlencoded"||countHeader(req,"content-type")!==1)
            throw Error("BAD_LOGIN");
          const body=await readBody(req,512);
          const values=new URLSearchParams(body);
          if([...values.keys()].length!==1||!values.has("password"))throw Error("BAD_LOGIN");
          if(!store.verify(values.get("password"),"remote-tray-gateway")){page(res,403,REMOTE_TRAY_LOCK_HTML);return;}
          for(const [id,lease] of sessions) if(lease.expiresAt<=now()) sessions.delete(id);
          if(sessions.size>=MAX_SESSIONS){page(res,429,"Maximum remote sessions reached");return;}
          const token=randomBytes(32).toString("hex");
          const id=randomBytes(16).toString("hex");
          sessions.set(id,{digest:digest(token),csrf:randomBytes(32).toString("hex"),expiresAt:now()+SESSION_MS});
          res.statusCode=303;
          res.setHeader("Set-Cookie",`sa_tray=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=300`);
          res.setHeader("Location","/");
          res.end();
        }catch{page(res,403,"Login rejected");}
      })();return;
    }
    if(!user){page(res,401,"Unauthorized");return;}
    if(req.method==="GET" && route==="/api/session"){
      json(res,200,{csrf:user.session.csrf,expiresAt:user.session.expiresAt});return;
    }
    if(req.method==="GET" && route==="/api/inventory"){
      void inventory().then(value=>json(res,200,value))
        .catch(()=>json(res,503,{error:"INVENTORY_UNAVAILABLE"}));
      return;
    }
    if(req.method==="POST" && (route==="/api/stop"||route==="/logout")){
      const csrf=req.headers["x-tray-csrf"];
      if(typeof csrf!=="string"||!TOKEN.test(csrf)||
         !timingSafeEqual(Buffer.from(csrf,"hex"),Buffer.from(user.session.csrf,"hex"))){
        page(res,403,"Invalid CSRF proof");return;
      }
      if(route==="/logout"){
        sessions.delete(user.id);
        res.setHeader("Set-Cookie","sa_tray=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
        json(res,200,{stopped:true});return;
      }
      void(async()=>{
        try{
          if(req.headers["content-type"]!=="application/json")throw Error("BAD_TYPE");
          const raw=await readBody(req,512);
          const body=JSON.parse(raw);
          if(!body||typeof body!=="object"||Array.isArray(body)||
             Object.keys(body).some(k=>!["id","expectedRevision","confirmProfile"].includes(k)))
            throw Error("BAD_REQUEST");
          const result=await stop(body,"human");
          json(res,200,result);
        }catch{json(res,409,{error:"SESSION_STOP_DENIED_OR_STALE"});}
      })();return;
    }
    page(res,404,"Not Found");
  });
  server.maxConnections=12;
  server.maxHeadersCount=28;
  server.headersTimeout=5000;
  server.requestTimeout=8000;
  await new Promise<void>((resolve,reject)=>{
    server.once("error",reject);
    server.listen(options.originPort,LOOPBACK,()=>{
      server.off("error",reject);resolve();
    });
  });
  const address=server.address();
  if(!address||typeof address==="string"||address.address!==LOOPBACK) {
    server.close();throw Error("TRAY_GATEWAY_REFUSED_NON_LOOPBACK_BIND");
  }
  return {get publicUrl(){return publicOrigin;},originPort:address.port,server,
    activateQuickOrigin(url:string){
      let accepted=false;
      try {
        const parsed=new URL(url);
        accepted=parsed.origin===url && parsed.protocol==="https:" &&
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parsed.hostname.split(".")[0]) &&
          parsed.hostname.split(".").slice(1).join(".")==="trycloudflare.com";
      } catch {}
      if(!quick||publicOrigin||!accepted)
        throw Error("TRAY_QUICK_ORIGIN_INVALID_OR_ALREADY_BOUND");
      publicOrigin=url;
    },
    close:async()=>{
    publicOrigin="";
    sessions.clear();
    await new Promise<void>(resolve=>{
      server.close(()=>resolve());
      server.closeAllConnections();
    });
  }};
}
