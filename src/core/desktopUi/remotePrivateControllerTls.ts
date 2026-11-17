/**
 * Attended, opt-in, OS-host-only private Desktop Live controller transport.
 *
 * A separate TLS 1.3, mutual-certificate, numeric-private-address socket.
 * There is NO HTTP, MCP, browser WebView, public tunnel, subprocess, screen
 * capture, automatic listener or generic OS keyboard/mouse injector.
 *
 * The host MUST supply a separate native approval callback that physically
 * prompts the logged-in OS user and returns a signed, challenge-bound proof.
 * The host's AttendedNativeControllerSession verifies that proof, the pinned
 * exact window, controller identity and action kinds before every semantic
 * nativeRef-only OS action. No proof or input token is issued on the wire.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { createServer, type Server, type TLSSocket } from "node:tls";
import { isIP } from "node:net";
import { once } from "node:events";
import {
  type PrivateHostTlsCertificateMaterial,
} from "./remotePrivateHostTlsListener.js";
import type { RemotePrivateViewerCredential } from "./remotePrivateTransport.js";
import type {
  RemoteControlChallenge, RemotePrincipal,
} from "./remoteControlAuthority.js";
import {
  type NativeInputFamily, AttendedNativeControllerSession,
} from "./attendedNativeControllerSession.js";

export const REMOTE_PRIVATE_CONTROLLER_ALPN = "superagent-desktop-control/1";
export const REMOTE_PRIVATE_CONTROLLER_MAX_WIRE = 2048;
const TTL_ALLOWANCE_MS=120_000;
const NATIVE_PROMPT_TIMEOUT_MS=25_000;
const HEX64=/^[a-f0-9]{64}$/;
const HEX48=/^[a-f0-9]{48}$/;
const CID=/^ctl-[a-f0-9]{40}$/;

function deny():never { throw Error("PRIVATE_CONTROLLER_TRANSPORT_DENIED"); }
function privateIp(s:string):boolean {
  if(isIP(s)!==4)return false;
  const p=s.split(".").map(Number);
  return p[0]===127&&p[1]===0&&p[2]===0&&p[3]===1||
    p[0]===10||(p[0]===172&&p[1]>=16&&p[1]<=31)||
    p[0]===192&&p[1]===168;
}
function exact(obj:unknown,keys:readonly string[]):obj is Record<string,unknown> {
  return !!obj&&typeof obj==="object"&&!Array.isArray(obj)&&
    Object.keys(obj).length===keys.length&&keys.every(k=>Object.hasOwn(obj,k));
}
function sameDigest(a:string,b:string):boolean {
  return HEX64.test(a)&&HEX64.test(b)&&
    timingSafeEqual(Buffer.from(a,"hex"),Buffer.from(b,"hex"));
}
function verifiedOptions(
  material:PrivateHostTlsCertificateMaterial,viewer:RemotePrivateViewerCredential,now:number,
):string {
  if(!material||!viewer||!privateIp(material.privateAddress)||
     !Number.isSafeInteger(material.port)||material.port<0||material.port>65535||
     !Buffer.isBuffer(material.serverCertificate)||
     !Buffer.isBuffer(material.serverKey)||!Buffer.isBuffer(material.viewerCa)||
     material.serverCertificate.length<128||material.serverCertificate.length>32768||
     material.serverKey.length<128||material.serverKey.length>32768||
     material.viewerCa.length<128||material.viewerCa.length>32768||
     !HEX64.test(viewer.sessionId)||!HEX64.test(viewer.viewerKey)||
     !HEX64.test(viewer.viewerChallenge)||!HEX64.test(viewer.pinnedViewerCertSha256)||
     !Number.isSafeInteger(viewer.expiresAt)||
     viewer.expiresAt<=now||viewer.expiresAt>now+TTL_ALLOWANCE_MS||
     typeof viewer.hostId!=="string"||viewer.hostId.length<8||viewer.hostId.length>128||
     typeof viewer.viewerId!=="string"||viewer.viewerId.length<8||viewer.viewerId.length>128)deny();
  try {
    const origin=new URL(viewer.expectedOrigin);
    if(origin.origin!==viewer.expectedOrigin||origin.protocol!=="https:"||
       !origin.hostname||isIP(origin.hostname)!==0||
       new X509Certificate(material.serverCertificate).checkHost(origin.hostname)!==origin.hostname)deny();
    return origin.hostname;
  }catch{deny();}
}

/** Domain-separated from viewer frame authentication; never sign native
 * approval with this HMAC. It proves *only* the pinned private viewer.
 */
export function computeRemotePrivateControllerProof(
  viewer:RemotePrivateViewerCredential,nonce:string,connectionId:string,
):string {
  if(!viewer||!HEX64.test(viewer.viewerKey)||!HEX64.test(viewer.sessionId)||
     !HEX64.test(viewer.viewerChallenge)||!HEX48.test(nonce)||!CID.test(connectionId))deny();
  return createHmac("sha256",Buffer.from(viewer.viewerKey,"hex")).update(JSON.stringify([
    "superagent-native-private-controller-transport-v1",
    viewer.sessionId,viewer.viewerChallenge,viewer.hostId,viewer.viewerId,
    viewer.expectedOrigin,viewer.pinnedViewerCertSha256,nonce,connectionId,
  ])).digest("hex");
}

export interface RemotePrivateControllerTlsHostOptions {
  readonly material:PrivateHostTlsCertificateMaterial;
  /** Delivered to viewer only via trusted out-of-band native UI. */
  readonly credential:RemotePrivateViewerCredential;
  readonly controller:AttendedNativeControllerSession;
  /** OS-only attended prompt; must return a fresh host-signed challenge proof. */
  readonly approveNative:(challenge:Readonly<RemoteControlChallenge>)=>Promise<unknown>;
  readonly now?:()=>number;
}
type Phase="auth"|"ready";
interface BoundControl {
  socket:TLSSocket;
  phase:Phase;
  connectionId:string;
  principal:RemotePrincipal;
  nonce:string;
  incoming:Buffer;
  busy:boolean;
  attempts:Set<NativeInputFamily>;
  grants:Partial<Record<NativeInputFamily,{token:string;expiresAt:number}>>;
}

export class RemotePrivateControllerTlsHost {
  private server:Server|null=null;
  private bound:BoundControl|null=null;
  private starting=false;
  private stopped=false;
  private readonly now:()=>number;
  private readonly serverName:string;
  private readonly key:Buffer;
  private expiryTimer:ReturnType<typeof setTimeout>|null=null;

  constructor(private readonly options:Readonly<RemotePrivateControllerTlsHostOptions>) {
    if(!options||typeof options.approveNative!=="function"||
       !options.controller||options.controller.isClosed)deny();
    this.now=options.now||Date.now;
    this.serverName=verifiedOptions(options.material,options.credential,this.now());
    this.key=Buffer.from(options.credential.viewerKey,"hex");
  }

  /** Does not start at application boot. Requires explicit native provisioning. */
  async start():Promise<{address:string;port:number;expiresAt:number}> {
    if(this.stopped||this.starting||this.server||this.options.controller.isClosed)deny();
    this.starting=true;
    try{
      const material=this.options.material;
      const server=createServer({
        key:material.serverKey,cert:material.serverCertificate,ca:material.viewerCa,
        requestCert:true,rejectUnauthorized:true,
        minVersion:"TLSv1.3",maxVersion:"TLSv1.3",
        ALPNProtocols:[REMOTE_PRIVATE_CONTROLLER_ALPN],handshakeTimeout:5000,
      });
      this.server=server;
      server.on("secureConnection",socket=>this.accept(socket));
      server.on("tlsClientError",()=>{});
      server.on("error",()=>this.stop());
      server.listen(material.port,material.privateAddress);
      await once(server,"listening");
      const at=server.address();
      if(this.stopped||!at||typeof at==="string"||
         at.address!==material.privateAddress||!Number.isSafeInteger(at.port)||at.port<1)deny();
      this.expiryTimer=setTimeout(()=>this.stop(),Math.max(1,this.options.credential.expiresAt-this.now()));
      this.expiryTimer.unref?.();
      return {address:at.address,port:at.port,expiresAt:this.options.credential.expiresAt};
    }catch{
      this.stop();
      deny();
    }finally{this.starting=false;}
  }

  private accept(socket:TLSSocket):void {
    const v=this.options.credential;
    const peer=socket.getPeerCertificate(true)?.raw;
    if(this.stopped||this.bound||this.options.controller.isClosed||
       !socket.encrypted||!socket.authorized||socket.getProtocol()!=="TLSv1.3"||
       socket.alpnProtocol!==REMOTE_PRIVATE_CONTROLLER_ALPN||
       socket.servername?.toLowerCase()!==this.serverName.toLowerCase()||
       !privateIp(socket.localAddress||"")||!privateIp(socket.remoteAddress||"")||
       !peer||!sameDigest(createHash("sha256").update(peer).digest("hex"),v.pinnedViewerCertSha256)||
       this.now()>=v.expiresAt){socket.destroy();return;}
    const connectionId="ctl-"+randomBytes(20).toString("hex");
    const nonce=randomBytes(24).toString("hex");
    const principal:RemotePrincipal={
      principalId:v.viewerId,connectionId,viewSessionId:v.sessionId,
    };
    const bound:BoundControl={
      socket,phase:"auth",connectionId,principal,nonce,
      incoming:Buffer.alloc(0),busy:false,attempts:new Set(),grants:{},
    };
    this.bound=bound;
    socket.setNoDelay(true);
    socket.setTimeout(5000,()=>this.disconnect(bound));
    socket.on("data",raw=>this.receive(bound,Buffer.from(raw)));
    socket.once("close",()=>this.disconnect(bound));
    socket.once("error",()=>this.disconnect(bound));
    if(!this.write(bound,{v:1,type:"hello",nonce,connectionId}))this.disconnect(bound);
  }

  private write(c:BoundControl,message:Record<string,unknown>):boolean {
    if(this.stopped||this.bound!==c||c.socket.destroyed||
       !c.socket.writable||c.socket.writableLength!==0)return false;
    const bytes=Buffer.from(JSON.stringify(message),"utf8");
    if(bytes.length<1||bytes.length>REMOTE_PRIVATE_CONTROLLER_MAX_WIRE)return false;
    const wire=Buffer.allocUnsafe(4+bytes.length);
    wire.writeUInt32BE(bytes.length,0);bytes.copy(wire,4);
    try{return c.socket.write(wire);}catch{return false;}
  }

  private receive(c:BoundControl,raw:Buffer):void {
    if(this.stopped||this.bound!==c||c.socket.destroyed||
       c.busy||this.options.controller.isClosed||
       this.now()>=this.options.credential.expiresAt||
       raw.length>REMOTE_PRIVATE_CONTROLLER_MAX_WIRE+4||
       c.incoming.length+raw.length>REMOTE_PRIVATE_CONTROLLER_MAX_WIRE+4){
      this.disconnect(c);return;
    }
    c.incoming=Buffer.concat([c.incoming,raw]);
    if(c.incoming.length<4)return;
    const n=c.incoming.readUInt32BE(0);
    if(n<2||n>REMOTE_PRIVATE_CONTROLLER_MAX_WIRE||c.incoming.length>n+4){
      this.disconnect(c);return;
    }
    if(c.incoming.length<n+4)return;
    let message:unknown;
    try{message=JSON.parse(c.incoming.subarray(4).toString("utf8"));}
    catch{this.disconnect(c);return;}
    c.incoming.fill(0);c.incoming=Buffer.alloc(0);
    c.busy=true;
    c.socket.pause();
    void this.process(c,message).then(()=>{
      if(this.bound===c&&!this.stopped&&!c.socket.destroyed){
        c.busy=false;c.socket.resume();
      }
    }).catch(()=>this.disconnect(c));
  }

  private async process(c:BoundControl,message:unknown):Promise<void> {
    if(c.phase==="auth"){
      if(!exact(message,["v","type","nonce","proof"])||
         message.v!==1||message.type!=="authenticate"||
         message.nonce!==c.nonce||typeof message.proof!=="string"||
         !HEX64.test(message.proof))deny();
      const expected=computeRemotePrivateControllerProof(
        this.options.credential,c.nonce,c.connectionId);
      if(!sameDigest(expected,message.proof))deny();
      c.phase="ready";
      c.socket.setTimeout(0);
      if(!this.write(c,{v:1,type:"authenticated"}))deny();
      return;
    }
    if(!message||typeof message!=="object"||Array.isArray(message))deny();
    const obj=message as Record<string,unknown>;
    if(exact(obj,["v","type","family"])&&obj.v===1&&obj.type==="request-scope"){
      const family=obj.family;
      if((family!=="mouse"&&family!=="keyboard")||
         c.attempts.has(family)||c.grants[family])deny();
      c.attempts.add(family);
      const challenge=this.options.controller.requestScope(c.principal,family);
      let proof:unknown=null;
      try{
        proof=await Promise.race([
          this.options.approveNative(challenge),
          new Promise((_,reject)=>setTimeout(()=>reject(Error("NATIVE_APPROVAL_TIMEOUT")),
            NATIVE_PROMPT_TIMEOUT_MS)),
        ]);
        if(this.stopped||this.bound!==c||c.socket.destroyed||
           this.now()>=this.options.credential.expiresAt)deny();
        const result=this.options.controller.confirmScope(challenge.nonce,proof);
        c.grants[family]={token:result.token,expiresAt:result.expiresAt};
        if(!this.write(c,{v:1,type:"scope-granted",family,
          expiresAt:Math.min(result.expiresAt,this.options.credential.expiresAt)}))deny();
      }catch{
        this.options.controller.revokeScope(family);
        if(!this.write(c,{v:1,type:"scope-denied",family}))deny();
      }
      return;
    }
    if(exact(obj,["v","type","family"])&&obj.v===1&&obj.type==="revoke-scope"){
      const family=obj.family;
      if(family!=="mouse"&&family!=="keyboard")deny();
      this.options.controller.revokeScope(family);
      delete c.grants[family];
      if(!this.write(c,{v:1,type:"scope-revoked",family}))deny();
      return;
    }
    if(exact(obj,["v","type","request"])&&obj.v===1&&obj.type==="input"){
      const request=obj.request;
      if(!request||typeof request!=="object"||Array.isArray(request))deny();
      const k=(request as Record<string,unknown>).kind;
      const family=k==="click"||k==="scroll"?"mouse":
        k==="key"||k==="type"?"keyboard":null;
      if(!family)deny();
      const grant=c.grants[family];
      if(!grant||grant.expiresAt<=this.now())deny();
      const result=await this.options.controller.input(c.principal,grant.token,request);
      if(this.stopped||this.bound!==c||c.socket.destroyed)deny();
      // Only a non-sensitive disposition; never send target labels, OS errors,
      // screenshots, native references or the host-held input capability.
      if(!this.write(c,{v:1,type:"input-result",status:result.status,
         reason:result.status==="dispatched"?null:result.reason||"INPUT_DENIED"}))deny();
      return;
    }
    deny();
  }

  /** Revoke both scopes when this authenticated controller socket disconnects.
   * The independently approved view-only mTLS session can remain open.
   */
  private disconnect(c:BoundControl):void {
    if(this.bound!==c)return;
    this.bound=null;
    c.incoming.fill(0);c.incoming=Buffer.alloc(0);
    c.socket.destroy();
    this.options.controller.controllerDisconnected(c.connectionId);
  }

  stop():void {
    if(this.stopped)return;
    this.stopped=true;
    if(this.expiryTimer)clearTimeout(this.expiryTimer);
    this.expiryTimer=null;
    if(this.bound)this.disconnect(this.bound);
    this.key.fill(0);
    try{this.server?.close();}catch{}
    this.server=null;
  }
  get isStopped():boolean{return this.stopped;}
}
