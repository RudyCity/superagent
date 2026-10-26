import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach,describe,expect,it} from "vitest";
import {McpDurableOAuthStore} from "../src/core/mcp/mcpDurableOAuthStore.js";
const roots:string[]=[];
function profile(){
 const p=fs.mkdtempSync(path.join(os.tmpdir(),"r2-new-oauth-owner-"));
 roots.push(p);return p;
}
afterEach(()=>{for(const p of roots.splice(0))fs.rmSync(p,{recursive:true,force:true})});
const issuer="https://new-issuer.example";
const uri="https://client.example/cb";
describe("R2 durable new-only OAuth issuer",()=>{
 it("persists client, authorization, token hashes and refresh rotation across restart",()=>{
  const p=profile(),s=new McpDurableOAuthStore(p,issuer,{keyMode:"raw-test"});
  s.registerClient("client-1",[uri]);
  const verifier=crypto.randomBytes(32).toString("base64url");
  const challenge=crypto.createHash("sha256").update(verifier).digest("base64url");
  const r=s.createAuthorizationRequest({clientId:"client-1",redirectUri:uri,
    codeChallenge:challenge,codeChallengeMethod:"S256",scope:["mcp:tools"],
    state:"state",resource:issuer+"/mcp"});
  const one=s.approveAuthorizationRequest(r.requestId,true);
  expect(one.ok).toBe(true);
  if(!one.ok)throw Error("No code");
  const restarted=new McpDurableOAuthStore(p,issuer,{keyMode:"raw-test"});
  const exchanged=restarted.exchangeCode({
    code:one.code,clientId:"client-1",redirectUri:uri,
    codeVerifier:verifier,resource:issuer+"/mcp"});
  expect(exchanged.ok).toBe(true);
  if(!exchanged.ok)throw Error("No tokens");
  const content=fs.readFileSync(path.join(p,"oauth-state.json"),"utf8");
  expect(content).not.toContain(exchanged.accessToken);
  expect(content).not.toContain(exchanged.refreshToken);
  expect(content).not.toContain(one.code);
  const after=new McpDurableOAuthStore(p,issuer,{keyMode:"raw-test"});
  expect(after.verifyAccessToken(exchanged.accessToken,issuer+"/mcp")).not.toBeNull();
  expect(after.exchangeCode({code:one.code,clientId:"client-1",redirectUri:uri,
    codeVerifier:verifier}).ok).toBe(false);
  const rotated=after.rotateRefreshToken(exchanged.refreshToken,issuer+"/mcp");
  expect(rotated.ok).toBe(true);
  const post=new McpDurableOAuthStore(p,issuer,{keyMode:"raw-test"});
  expect(post.rotateRefreshToken(exchanged.refreshToken).ok).toBe(false);
  if(!rotated.ok)throw Error("No rotation");
  expect(post.verifyAccessToken(rotated.accessToken)).not.toBeNull();
  expect(post.revokeToken(rotated.accessToken)).toBe(true);
  expect(new McpDurableOAuthStore(p,issuer,{keyMode:"raw-test"}).verifyAccessToken(rotated.accessToken)).toBeNull();
 });
 it("fails closed on modified snapshot, deleted key or foreign issuer",()=>{
  const p=profile();
  const s=new McpDurableOAuthStore(p,issuer,{keyMode:"raw-test"});
  s.registerClient("client-2",[uri]);
  expect(()=>new McpDurableOAuthStore(p,"https://foreign.example")).toThrow();
  const file=path.join(p,"oauth-state.json");
  const txt=fs.readFileSync(file,"utf8").replace("client-2","attacker");
  fs.writeFileSync(file,txt);
  expect(()=>new McpDurableOAuthStore(p,issuer,{keyMode:"raw-test"})).toThrow(/Tampered/);
  fs.unlinkSync(path.join(p,"oauth-state.key"));
  expect(()=>new McpDurableOAuthStore(p,issuer,{keyMode:"raw-test"})).toThrow(/key missing/);
 });
});
