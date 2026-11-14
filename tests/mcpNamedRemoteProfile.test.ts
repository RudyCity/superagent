import {describe,expect,it} from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readRemoteManagedNamedProfile,verifyRemoteManagedNamedProfile,
} from "../src/core/runtime/mcpNamedRemoteProfile.js";
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"mcp-remote-profile-"));
  const tokenPath=path.join(root,"private","cloudflare-named",
    "b2e8c6d9-9317-4d9e-b381-826af22e1778.token");
  fs.mkdirSync(path.dirname(tokenPath),{recursive:true});
  const binaryPath=path.join(root,process.platform==="win32"?"cloudflared.exe":"cloudflared");
  const id="b2e8c6d9-9317-4d9e-b381-826af22e1778";
  const payload=JSON.stringify({a:"test-account",t:id,s:"secret-from-test-01"});
  fs.writeFileSync(tokenPath,Buffer.from(payload).toString("base64url"));
  fs.writeFileSync(binaryPath,"isolated test fixture executable");
  const settings={
    version:1,connectorMode:"remote-managed",tunnelId:id,
    hostname:"mcp.rcity.web.id",anchorPort:19320,ownerPort:19321,
    tokenFilePath:tokenPath,credentialsFilePath:"",
    cloudflaredPath:binaryPath,
  };
  fs.writeFileSync(path.join(root,"mcp-named-tunnel-settings.json"),
    JSON.stringify(settings));
  return {root,id,settings,tokenPath,binaryPath};
}
describe("Remote-managed Cloudflare Named Tunnel profile bridge",()=>{
  it("verifies operator-owned UUID/token and never exposes tokens in plans",()=>{
    const f=fixture();
    try{
      expect(readRemoteManagedNamedProfile(f.root)).toEqual(f.settings);
      const plan=verifyRemoteManagedNamedProfile(f.root);
      expect(plan).toMatchObject({
        tunnelId:f.id,hostname:"mcp.rcity.web.id",
        anchorPort:19320,ownerPort:19321,
        publicUrl:"https://mcp.rcity.web.id/mcp",
        tokenFileVerified:true,connectorVerified:false,
        dnsVerified:false,clientCutoverApproved:false,
      });
      expect(JSON.stringify(plan)).not.toContain("secret-from-test-01");
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  });
  it("rejects another tunnel's token, credentials-mixing and quick hostname",()=>{
    const f=fixture();
    try{
      const file=path.join(f.root,"mcp-named-tunnel-settings.json");
      const other={...f.settings,tunnelId:crypto.randomUUID()};
      fs.writeFileSync(file,JSON.stringify(other));
      expect(()=>verifyRemoteManagedNamedProfile(f.root))
        .toThrow("NAMED_REMOTE_TOKEN_NOT_IN_PRIVATE_PROFILE");
      fs.writeFileSync(file,JSON.stringify(f.settings));
      fs.writeFileSync(f.tokenPath,Buffer.from(JSON.stringify({
        a:"test-account",t:other.tunnelId,s:"secret-from-test-01",
      })).toString("base64url"));
      expect(()=>verifyRemoteManagedNamedProfile(f.root))
        .toThrow("NAMED_REMOTE_TOKEN_IDENTITY_MISMATCH");
      fs.writeFileSync(file,JSON.stringify({...f.settings,credentialsFilePath:"C:/bad.json"}));
      expect(()=>readRemoteManagedNamedProfile(f.root)).toThrow("NAMED_REMOTE_PROFILE_INVALID");
      fs.writeFileSync(file,JSON.stringify({...f.settings,hostname:"rotated.trycloudflare.com"}));
      expect(()=>readRemoteManagedNamedProfile(f.root)).toThrow("MCP_NAMED_HOSTNAME_INVALID");
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  });
  it("fails closed for absent token, invalid file and protected owner ports",()=>{
    const f=fixture();
    try{
      fs.rmSync(f.tokenPath);
      expect(()=>verifyRemoteManagedNamedProfile(f.root)).toThrow();
      const file=path.join(f.root,"mcp-named-tunnel-settings.json");
      fs.writeFileSync(file,JSON.stringify({...f.settings,ownerPort:9227}));
      expect(()=>readRemoteManagedNamedProfile(f.root)).toThrow("NAMED_REMOTE_PROFILE_INVALID");
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  });
});
