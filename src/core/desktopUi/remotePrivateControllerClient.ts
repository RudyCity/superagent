/**
 * Node-only attended Desktop Live controller client. Uses its own pinned mTLS
 * 1.3 socket, never a browser, HTTP bearer, tunnel URL or preview token.
 * The viewer's initial authentication authorizes NO input; the OS host must
 * independently approve each mouse/keyboard scope.
 */
import { createHash, timingSafeEqual, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import {
  computeRemotePrivateControllerProof,
  REMOTE_PRIVATE_CONTROLLER_ALPN,
  REMOTE_PRIVATE_CONTROLLER_MAX_WIRE,
} from "./remotePrivateControllerTls.js";
import type { RemotePrivateViewerCredential } from "./remotePrivateTransport.js";
import type { NativeInputFamily } from "./attendedNativeControllerSession.js";
import type { RemoteNativeInputResult } from "./remoteNativeInputDispatch.js";

const HEX64=/^[a-f0-9]{64}$/;
const HEX48=/^[a-f0-9]{48}$/;
const CID=/^ctl-[a-f0-9]{40}$/;
function deny():never {throw Error("PRIVATE_CONTROLLER_CLIENT_DENIED");}
function privateIp(s:string):boolean {
  if(isIP(s)!==4)return false;
  const p=s.split(".").map(Number);
  return p[0]===127&&p[1]===0&&p[2]===0&&p[3]===1||
    p[0]===10||(p[0]===172&&p[1]>=16&&p[1]<=31)||
    p[0]===192&&p[1]===168;
}
function exact(x:unknown,fields:readonly string[]):x is Record<string,unknown> {
  return !!x&&typeof x==="object"&&!Array.isArray(x)&&
    Object.keys(x).length===fields.length&&fields.every(k=>Object.hasOwn(x,k));
}
function same(a:string,b:string):boolean {
  return HEX64.test(a)&&HEX64.test(b)&&
    timingSafeEqual(Buffer.from(a,"hex"),Buffer.from(b,"hex"));
}
export interface RemotePrivateControllerClientOptions {
  privateAddress:string;
  port:number;
  credential:RemotePrivateViewerCredential;
  pinnedServerCertSha256:string;
  clientCert:Buffer|string;
  clientKey:Buffer|string;
  trustedCa:Buffer|string;
  now?:()=>number;
}
interface Pending {
  readonly kind:"scope"|"input"|"revoke";
  readonly family?:NativeInputFamily;
  readonly resolve:(result:unknown)=>void;
  readonly reject:(error:Error)=>void;
  readonly timer:ReturnType<typeof setTimeout>;
}

export class RemotePrivateControllerClient {
  private phase:"tls"|"hello"|"awaiting-auth"|"authenticated"|"closed"="tls";
  private inbound=Buffer.alloc(0);
  private pending:Pending|null=null;
  private connectResolve:((c:RemotePrivateControllerClient)=>void)|null=null;
  private connectReject:((reason:Error)=>void)|null=null;
  private leaseTimer:ReturnType<typeof setTimeout>|null=null;
  private handshakeTimer:ReturnType<typeof setTimeout>|null=null;
  private readonly now:()=>number;
  private readonly hostname:string;
  /** The independently approved scope is never valid past the host-reported
   * expiry, even if the private viewer certificate remains connected.
   */
  private readonly granted=new Map<NativeInputFamily,number>();

  private constructor(
    private readonly socket:TLSSocket,
    private readonly options:RemotePrivateControllerClientOptions,
    hostname:string,
  ){
    this.now=options.now||Date.now;
    this.hostname=hostname;
    socket.on("secureConnect",()=>this.onSecure());
    socket.on("data",chunk=>this.onData(Buffer.from(chunk)));
    socket.once("close",()=>this.close());
    socket.once("error",()=>this.close());
    this.handshakeTimer=setTimeout(()=>this.close(),5000);
    this.handshakeTimer.unref?.();
    this.leaseTimer=setTimeout(()=>this.close(),Math.max(1,options.credential.expiresAt-this.now()));
    this.leaseTimer.unref?.();
  }

  static async connect(options:RemotePrivateControllerClientOptions):Promise<RemotePrivateControllerClient>{
    const c=options?.credential;
    if(!options||!c||!privateIp(options.privateAddress)||
       !Number.isSafeInteger(options.port)||options.port<1||options.port>65535||
       !HEX64.test(options.pinnedServerCertSha256)||!HEX64.test(c.viewerKey)||
       !HEX64.test(c.sessionId)||!HEX64.test(c.viewerChallenge)||
       !HEX64.test(c.pinnedViewerCertSha256)||
       !Number.isSafeInteger(c.expiresAt)||c.expiresAt<=(options.now||Date.now)()||
       c.expiresAt>(options.now||Date.now)()+120_000||
       !options.clientCert||!options.clientKey||!options.trustedCa)deny();
    let hostname:string;
    try{
      const origin=new URL(c.expectedOrigin);
      if(origin.origin!==c.expectedOrigin||origin.protocol!=="https:"||
         isIP(origin.hostname)!==0||!origin.hostname)deny();
      hostname=origin.hostname;
      const clientFingerprint=createHash("sha256")
        .update(new X509Certificate(options.clientCert).raw).digest("hex");
      if(!same(clientFingerprint,c.pinnedViewerCertSha256))deny();
    }catch{deny();}
    const socket=tlsConnect({
      host:options.privateAddress,port:options.port,servername:hostname,
      cert:options.clientCert,key:options.clientKey,ca:options.trustedCa,
      rejectUnauthorized:true,minVersion:"TLSv1.3",maxVersion:"TLSv1.3",
      ALPNProtocols:[REMOTE_PRIVATE_CONTROLLER_ALPN],
    });
    const client=new RemotePrivateControllerClient(socket,options,hostname);
    return new Promise((resolve,reject)=>{
      client.connectResolve=resolve;
      client.connectReject=reject;
    });
  }

  private onSecure():void {
    try{
      const cert=this.socket.getPeerCertificate(true)?.raw;
      if(this.phase!=="tls"||!this.socket.authorized||
         this.socket.getProtocol()!=="TLSv1.3"||
         this.socket.alpnProtocol!==REMOTE_PRIVATE_CONTROLLER_ALPN||
         this.socket.servername!==this.hostname||
         !privateIp(this.socket.remoteAddress||"")||
         !privateIp(this.socket.localAddress||"")||!cert||
         !same(createHash("sha256").update(cert).digest("hex"),this.options.pinnedServerCertSha256)){
        this.close();return;
      }
      this.phase="hello";
    }catch{this.close();}
  }

  private send(msg:Record<string,unknown>):void {
    if(this.phase==="closed"||!this.socket.writable||this.socket.writableLength!==0)deny();
    const data=Buffer.from(JSON.stringify(msg),"utf8");
    if(data.length<2||data.length>REMOTE_PRIVATE_CONTROLLER_MAX_WIRE)deny();
    const wire=Buffer.allocUnsafe(data.length+4);
    wire.writeUInt32BE(data.length,0);data.copy(wire,4);
    if(!this.socket.write(wire))deny();
  }

  private onData(chunk:Buffer):void {
    if(this.phase==="closed"||this.phase==="tls"||
       chunk.length>REMOTE_PRIVATE_CONTROLLER_MAX_WIRE+4||
       this.inbound.length+chunk.length>REMOTE_PRIVATE_CONTROLLER_MAX_WIRE+4){
      this.close();return;
    }
    this.inbound=Buffer.concat([this.inbound,chunk]);
    if(this.inbound.length<4)return;
    const size=this.inbound.readUInt32BE(0);
    if(size<2||size>REMOTE_PRIVATE_CONTROLLER_MAX_WIRE||this.inbound.length>size+4){
      this.close();return;
    }
    if(this.inbound.length<size+4)return;
    let msg:unknown;
    try{msg=JSON.parse(this.inbound.subarray(4).toString("utf8"));}
    catch{this.close();return;}
    this.inbound.fill(0);this.inbound=Buffer.alloc(0);
    try{
      if(this.phase==="hello"){
        if(!exact(msg,["v","type","nonce","connectionId"])||
           msg.v!==1||msg.type!=="hello"||
           typeof msg.nonce!=="string"||!HEX48.test(msg.nonce)||
           typeof msg.connectionId!=="string"||!CID.test(msg.connectionId))deny();
        const proof=computeRemotePrivateControllerProof(
          this.options.credential,msg.nonce,msg.connectionId);
        this.send({v:1,type:"authenticate",nonce:msg.nonce,proof});
        this.phase="awaiting-auth";
        return;
      }
      if(this.phase==="awaiting-auth"){
        if(!exact(msg,["v","type"])||msg.v!==1||msg.type!=="authenticated")deny();
        this.phase="authenticated";
        if(this.handshakeTimer)clearTimeout(this.handshakeTimer);
        this.handshakeTimer=null;
        this.connectResolve?.(this);
        this.connectResolve=null;this.connectReject=null;
        return;
      }
      this.receiveResult(msg);
    }catch{this.close();}
  }

  private receiveResult(msg:unknown):void {
    const p=this.pending;
    if(!p)deny();
    let outcome:unknown;
    if(p.kind==="scope"){
      if(exact(msg,["v","type","family","expiresAt"])&&msg.v===1&&
         msg.type==="scope-granted"&&msg.family===p.family&&
         Number.isSafeInteger(msg.expiresAt)&&
         Number(msg.expiresAt)>this.now()&&
         Number(msg.expiresAt)<=this.options.credential.expiresAt){
        this.granted.set(p.family!,Number(msg.expiresAt));outcome=true;
      }else if(exact(msg,["v","type","family"])&&msg.v===1&&
         msg.type==="scope-denied"&&msg.family===p.family){outcome=false;}
      else deny();
    }else if(p.kind==="revoke"){
      if(!exact(msg,["v","type","family"])||msg.v!==1||
         msg.type!=="scope-revoked"||msg.family!==p.family)deny();
      this.granted.delete(p.family!);outcome=true;
    }else{
      if(!exact(msg,["v","type","status","reason"])||msg.v!==1||
         msg.type!=="input-result"||
         !["dispatched","blocked","uncertain"].includes(String(msg.status)))deny();
      const status=msg.status as "dispatched"|"blocked"|"uncertain";
      if(status==="dispatched"&&msg.reason!==null)deny();
      if(status!=="dispatched"&&typeof msg.reason!=="string")deny();
      outcome=status==="dispatched"?{status}:
        {status,reason:msg.reason};
    }
    this.pending=null;clearTimeout(p.timer);p.resolve(outcome);
  }

  private action(kind:Pending["kind"],message:Record<string,unknown>,
    family?:NativeInputFamily,timeoutMs=4000):Promise<unknown>{
    if(this.phase!=="authenticated"||this.pending||this.now()>=this.options.credential.expiresAt)
      return Promise.reject(Error("PRIVATE_CONTROLLER_CLIENT_BUSY_OR_DENIED"));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.close();},timeoutMs);
      timer.unref?.();
      this.pending={kind,family,resolve,reject,timer};
      try{this.send(message);}catch{this.close();}
    });
  }

  async requestScope(family:NativeInputFamily):Promise<boolean>{
    if(family!=="mouse"&&family!=="keyboard")deny();
    if(this.granted.has(family))deny();
    return this.action("scope",{v:1,type:"request-scope",family},family,30000) as Promise<boolean>;
  }
  async revokeScope(family:NativeInputFamily):Promise<boolean>{
    if(family!=="mouse"&&family!=="keyboard")deny();
    return this.action("revoke",{v:1,type:"revoke-scope",family},family) as Promise<boolean>;
  }
  async sendInput(request:unknown):Promise<RemoteNativeInputResult>{
    if(!request||typeof request!=="object"||Array.isArray(request))deny();
    const kind=(request as {kind?:unknown}).kind;
    const family=kind==="click"||kind==="scroll"?"mouse":
      kind==="type"||kind==="key"?"keyboard":null;
    if(!family)deny();
    const scopeExpiresAt=this.granted.get(family);
    if(!scopeExpiresAt||this.now()>=scopeExpiresAt){
      this.granted.delete(family);
      deny(); // Do not submit input with expired native approval.
    }
    return this.action("input",{v:1,type:"input",request}) as Promise<RemoteNativeInputResult>;
  }

  close():void {
    if(this.phase==="closed")return;
    this.phase="closed";
    if(this.handshakeTimer)clearTimeout(this.handshakeTimer);
    if(this.leaseTimer)clearTimeout(this.leaseTimer);
    this.inbound.fill(0);this.inbound=Buffer.alloc(0);
    this.granted.clear();
    const err=Error("PRIVATE_CONTROLLER_CLIENT_CLOSED");
    if(this.pending){
      clearTimeout(this.pending.timer);
      this.pending.reject(err);this.pending=null;
    }
    this.connectReject?.(err);
    this.connectResolve=null;this.connectReject=null;
    this.socket.destroy();
  }
  get isConnected():boolean{return this.phase==="authenticated";}
}
