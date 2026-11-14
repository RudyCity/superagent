import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {describe,expect,it} from "vitest";
import {
  validateMcpNamedTunnelSpec,validateMcpNamedTunnelCredentials,
  readMcpNamedTunnelSpec,renderMcpNamedTunnelIngress,inspectMcpNamedIngress,
  planMcpNamedTunnel,stageMcpNamedTunnelConfig,verifyStagedMcpNamedTunnel,
} from "../src/core/runtime/mcpNamedTunnelConfig.js";

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"named-mcp-plan-"));
  const credential=path.join(root,"credentials.json");
  const binary=path.join(root,process.platform==="win32"?"cloudflared.exe":"cloudflared");
  const uuid=crypto.randomUUID();
  const secret="PRIVATE_TEST_SECRET_NEVER_OUTPUT";
  const spec={
    schemaVersion:1 as const,tunnelId:uuid,hostname:"mcp.example.org",
    credentialsFile:credential,cloudflaredPath:binary,
  };
  fs.writeFileSync(credential,JSON.stringify({TunnelID:uuid,AccountTag:"test-account",
    TunnelSecret:secret}));
  fs.writeFileSync(binary,"test binary fixture");
  const specPath=path.join(root,"operator-spec.json");
  fs.writeFileSync(specPath,JSON.stringify(spec));
  const profile=path.join(root,"isolated-profile");
  return {root,credential,binary,uuid,secret,spec,specPath,profile};
}
describe("Named Cloudflare Tunnel preflight and isolated config staging",()=>{
  it("builds strict loopback-only ingress, exact hostname and 404 catch-all without mutation",()=>{
    const f=fixture();
    try{
      const spec=readMcpNamedTunnelSpec(f.specPath);
      expect(spec).toEqual(f.spec);
      const plan=planMcpNamedTunnel(spec,19320,f.profile);
      expect(plan).toMatchObject({
        mode:"named-external",hostname:"mcp.example.org",
        publicUrl:"https://mcp.example.org/mcp",port:19320,
        dnsConfigured:false,externalConnectorVerified:false,
        currentQuickTunnelUnchanged:true,
      });
      expect(fs.existsSync(f.profile)).toBe(false);
      const yaml=renderMcpNamedTunnelIngress(spec,19320);
      const parsed=YAML.parse(yaml);
      expect(parsed.ingress).toEqual([
        {hostname:"mcp.example.org",service:"http://127.0.0.1:19320"},
        {service:"http_status:404"},
      ]);
      expect(parsed.tunnel).toBe(f.uuid);
      expect(parsed["credentials-file"]).toBe(f.credential);
      inspectMcpNamedIngress(yaml,spec,19320);
      expect(JSON.stringify(plan)).not.toContain(f.secret);
      expect(yaml).not.toContain(f.secret);
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  });
  it("stages once, rechecks exact bytes, never overwrites changed configs",()=>{
    const f=fixture();
    try{
      const stage=stageMcpNamedTunnelConfig(f.spec,19320,f.profile);
      expect(fs.existsSync(stage.configFile)).toBe(true);
      expect(verifyStagedMcpNamedTunnel(f.spec,19320,f.profile)).toEqual(stage);
      expect(stageMcpNamedTunnelConfig(f.spec,19320,f.profile)).toEqual(stage);
      fs.appendFileSync(stage.configFile,"\n# modified externally");
      expect(()=>verifyStagedMcpNamedTunnel(f.spec,19320,f.profile))
        .toThrow("MCP_NAMED_CONFIG_CHANGED");
      expect(()=>stageMcpNamedTunnelConfig(f.spec,19320,f.profile))
        .toThrow("MCP_NAMED_REFUSE_OVERWRITE_DIFFERENT_CONFIG");
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  });
  it("refuses mismatched Cloudflare credentials or wrong executable",()=>{
    const f=fixture();
    try{
      fs.writeFileSync(f.credential,JSON.stringify({
        TunnelID:crypto.randomUUID(),AccountTag:"account",TunnelSecret:f.secret,
      }));
      expect(()=>validateMcpNamedTunnelCredentials(f.spec))
        .toThrow("MCP_NAMED_CREDENTIALS_MISMATCH");
      fs.writeFileSync(f.credential,JSON.stringify({
        TunnelID:f.uuid,AccountTag:"account",TunnelSecret:f.secret,
      }));
      expect(()=>validateMcpNamedTunnelCredentials({...f.spec,
        cloudflaredPath:f.credential})).toThrow("MCP_NAMED_BINARY_INVALID");
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  });
  it("rejects hostname injection, Quick Tunnel and inconsistent spec",()=>{
    const f=fixture();
    try{
      for(const hostname of [
        "MCP.example.org","mcp.example.org/extra","localhost",
        "myquick.trycloudflare.com","abc.cfargotunnel.com",
        "bad_host.example.org","mcp.example.org:443","-mcp.example.org",
      ])expect(()=>validateMcpNamedTunnelSpec({...f.spec,hostname})).toThrow();
      for(const data of [
        {...f.spec,tunnelId:"../../etc/passwd"},
        {...f.spec,extra:"token"},
        {...f.spec,credentialsFile:"relative.json"},
      ])expect(()=>validateMcpNamedTunnelSpec(data)).toThrow();
      expect(()=>renderMcpNamedTunnelIngress(f.spec,9227)).toThrow("MCP_NAMED_PORT_INVALID");
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  });
  it("rejects unsafe ingress overrides or missing catch-all",()=>{
    const f=fixture();
    try{
      const yaml=renderMcpNamedTunnelIngress(f.spec,19320);
      expect(()=>inspectMcpNamedIngress(yaml.replace("http_status:404","http://localhost:9090"),
        f.spec,19320)).toThrow("MCP_NAMED_INGRESS_MISMATCH");
      expect(()=>inspectMcpNamedIngress(yaml.replace("127.0.0.1:19320","127.0.0.1:9227"),
        f.spec,19320)).toThrow("MCP_NAMED_INGRESS_MISMATCH");
    }finally{fs.rmSync(f.root,{recursive:true,force:true});}
  });
});
