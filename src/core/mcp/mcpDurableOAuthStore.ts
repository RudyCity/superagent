/**
 * R2: crash-consistent (atomic-rename) HMAC-authenticated OAuth state for a
 * NEW, opt-in staging issuer. This is NOT a production OS-keystore or a way
 * to import legacy OAuth tokens. Same-user Windows ACL is not an isolation
 * guarantee. Raw codes, access and refresh tokens are never stored.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {McpOAuthStore,type OAuthStateSnapshot} from "./mcpOAuthStore.js";
interface Envelope {version:1;payload:OAuthStateSnapshot;mac:string}
function safeFile(file:string) {
  const s=fs.lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>12_000_000)
    throw new Error("Untrusted OAuth storage file");
}
export class McpDurableOAuthStore extends McpOAuthStore {
  private readonly key:Buffer;
  private readonly statePath:string;
  private unusable=false;
  constructor(profile:string,private readonly issuer:string) {
    super();
    if(!/^https:\/\/[^\s/#?]+/.test(issuer)&&
       !/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(issuer))
      throw new Error("Durable issuer must be explicit HTTPS or staging loopback");
    const dir=fs.realpathSync(profile);
    const stat=fs.lstatSync(dir);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error("Invalid OAuth profile");
    const keyPath=path.join(dir,"oauth-state.key"),statePath=path.join(dir,"oauth-state.json");
    this.statePath=statePath;
    const hasKey=fs.existsSync(keyPath),hasState=fs.existsSync(statePath);
    if(hasState&&!hasKey)throw new Error("OAuth issuer key missing; refusing state reset");
    if(!hasKey){
      fs.writeFileSync(keyPath,crypto.randomBytes(32),{mode:0o600,flag:"wx"});
    }
    safeFile(keyPath);
    const key=fs.readFileSync(keyPath);
    if(key.length!==32)throw new Error("Invalid OAuth state key");
    this.key=key;
    if(hasState){
      safeFile(statePath);
      const raw=fs.readFileSync(statePath,"utf8");
      let envelope:Envelope;
      try{envelope=JSON.parse(raw)}catch{throw new Error("Invalid OAuth snapshot JSON")}
      if(envelope.version!==1||!envelope.payload||typeof envelope.mac!=="string")
        throw new Error("Invalid OAuth snapshot envelope");
      const expected=this.sign(envelope.payload);
      if(!/^[a-f0-9]{64}$/.test(envelope.mac)||
         !crypto.timingSafeEqual(Buffer.from(expected,"hex"),Buffer.from(envelope.mac,"hex")))
         throw new Error("Tampered OAuth issuer state; refuse restart");
      this.restoreSnapshot(envelope.payload,issuer);
    }else this.flush();
  }
  private sign(payload:OAuthStateSnapshot):string {
    return crypto.createHmac("sha256",this.key).update(JSON.stringify(payload)).digest("hex");
  }
  private assertUsable() {
    if(this.unusable)throw new Error("OAuth owner persistence failed: issuer locked until operator review");
  }
  private flush(){
    this.assertUsable();
    const snapshot=this.exportSnapshot(this.issuer);
    const envelope:Envelope={version:1,payload:snapshot,mac:this.sign(snapshot)};
    const tmp=this.statePath+"."+process.pid+"."+crypto.randomUUID()+".tmp";
    try{
      // Never overwrite a symlink or unexpectedly shared state file.
      if(fs.existsSync(this.statePath))safeFile(this.statePath);
      fs.writeFileSync(tmp,JSON.stringify(envelope),{flag:"wx",mode:0o600});
      fs.renameSync(tmp,this.statePath);
    }catch(e){this.unusable=true;throw e}
    finally{try{fs.rmSync(tmp,{force:true})}catch{}}
  }
  override registerClient(...p:Parameters<McpOAuthStore["registerClient"]>){
    this.assertUsable();const r=super.registerClient(...p);this.flush();return r;
  }
  override createAuthorizationRequest(...p:Parameters<McpOAuthStore["createAuthorizationRequest"]>){
    this.assertUsable();const r=super.createAuthorizationRequest(...p);this.flush();return r;
  }
  override approveAuthorizationRequest(...p:Parameters<McpOAuthStore["approveAuthorizationRequest"]>){
    this.assertUsable();const r=super.approveAuthorizationRequest(...p);this.flush();return r;
  }
  override exchangeCode(...p:Parameters<McpOAuthStore["exchangeCode"]>){
    this.assertUsable();const r=super.exchangeCode(...p);this.flush();return r;
  }
  override rotateRefreshToken(...p:Parameters<McpOAuthStore["rotateRefreshToken"]>){
    this.assertUsable();const r=super.rotateRefreshToken(...p);this.flush();return r;
  }
  override revokeToken(...p:Parameters<McpOAuthStore["revokeToken"]>){
    this.assertUsable();const r=super.revokeToken(...p);if(r)this.flush();return r;
  }
  override cleanupExpired(){
    this.assertUsable();const n=super.cleanupExpired();if(n)this.flush();return n;
  }
  override verifyAccessToken(...p:Parameters<McpOAuthStore["verifyAccessToken"]>){
    this.assertUsable();return super.verifyAccessToken(...p);
  }
}
