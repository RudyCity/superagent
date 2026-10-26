import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {McpDurableOAuthStore} from "../src/core/mcp/mcpDurableOAuthStore.js";
import {describe,it,expect} from "vitest";
import {
  createNewIssuerDpapiKey,protectNewIssuerKey,unprotectNewIssuerKey
} from "../src/core/mcp/mcpWindowsDpapiKey.js";
describe("R2 independent OAuth Windows CurrentUser DPAPI key wrapper",()=>{
  it("never accepts unprotected or malformed key envelopes",()=>{
    expect(()=>protectNewIssuerKey(Buffer.from("plaintext"))).toThrow();
    expect(()=>unprotectNewIssuerKey({version:1,scope:"WindowsCurrentUser",
      scheme:"DPAPI-SHA256-v1",data:"not_base64!"})).toThrow(/Untrusted/);
    expect(()=>unprotectNewIssuerKey({version:1,scope:"WindowsCurrentUser",
      scheme:"DPAPI-SHA256-v1",data:"a".repeat(35000)})).toThrow();
  });
  it("encrypts a fresh 256-bit key without including plaintext in ciphertext or JSON",()=>{
    if(process.platform!=="win32"){
      expect(()=>createNewIssuerDpapiKey()).toThrow(/Windows/);
      return;
    }
    const key=crypto.randomBytes(32);
    const encrypted=protectNewIssuerKey(key);
    expect(encrypted.scheme).toBe("DPAPI-SHA256-v1");
    expect(encrypted.scope).toBe("WindowsCurrentUser");
    expect(encrypted.data).not.toEqual(key.toString("base64"));
    expect(JSON.stringify(encrypted)).not.toContain(key.toString("hex"));
    const decrypted=unprotectNewIssuerKey(encrypted);
    expect(decrypted.equals(key)).toBe(true);
    const damaged={...encrypted,data:Buffer.from(encrypted.data,"base64").subarray(1).toString("base64")};
    expect(()=>unprotectNewIssuerKey(damaged)).toThrow(/DPAPI/);
    key.fill(0);
    decrypted.fill(0);
  },20000);
  it("protects a NEW issuer signing key across restart, rejects missing key and downgrade",()=>{
    if(process.platform!=="win32")return;
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"r2-dpapi-oauth-"));
    const issuer="https://r2-canary.example";
    try{
      const first=new McpDurableOAuthStore(root,issuer,{keyMode:"windows-dpapi"});
      first.registerClient("canary",["https://consumer.example/callback"]);
      const stored=fs.readFileSync(path.join(root,"oauth-state.key.dpapi"),"utf8");
      expect(stored).toContain("WindowsCurrentUser");
      expect(fs.existsSync(path.join(root,"oauth-state.key"))).toBe(false);
      const restored=new McpDurableOAuthStore(root,issuer,{keyMode:"windows-dpapi"});
      expect(restored.getClient("canary")).toBeDefined();
      expect(()=>new McpDurableOAuthStore(root,issuer,{keyMode:"raw-test"})).toThrow(/mismatch/);
      fs.unlinkSync(path.join(root,"oauth-state.key.dpapi"));
      expect(()=>new McpDurableOAuthStore(root,issuer,{keyMode:"windows-dpapi"})).toThrow(/key missing/);
    }finally{
      fs.rmSync(root,{recursive:true,force:true});
    }
  },30000);
});
