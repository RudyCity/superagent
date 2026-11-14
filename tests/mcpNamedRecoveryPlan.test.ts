import {describe,expect,it} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  renderMcpNamedRecoveryPreview,planMcpNamedRecovery,
  type NamedRecoveryPlatform,type NamedRecoveryPreviewInput,
} from "../src/core/runtime/mcpNamedRecoveryPlan.js";

const id="b2e8c6d9-9317-4d9e-b381-826af22e1778";
function spec(platform:NamedRecoveryPlatform):NamedRecoveryPreviewInput{
  const root=platform==="win32"?"C:\\Users\\Example\\.superagent-r"
    :platform==="darwin"?"/Users/example/.superagent-r":"/home/example/.superagent-r";
  const join=platform==="win32"?path.win32.join:path.posix.join;
  return {
    platform,tunnelId:id,hostname:"mcp.rcity.web.id",
    anchorPort:19320,ownerPort:19321,
    cloudflaredPath:platform==="win32"?"C:\\Program Files\\Cloudflare\\cloudflared.exe"
      :platform==="darwin"?"/opt/homebrew/bin/cloudflared":"/usr/local/bin/cloudflared",
    tokenFilePath:join(root,"private","cloudflare-named",id+".token"),
  };
}
describe("named tunnel dry-run recovery templates",()=>{
  it("generates disabled Windows logon task with least-privilege and token-file argv",()=>{
    const plan=renderMcpNamedRecoveryPreview(spec("win32"));
    expect(plan.artifactType).toBe("windows-task-xml");
    expect(plan.artifact).toContain("<Enabled>false</Enabled>");
    expect(plan.artifact).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(plan.artifact).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(plan.artifact).toContain("--token-file &quot;C:");
    expect(plan.artifact).not.toContain("<Enabled>true</Enabled>");
    expect(plan.automaticActivation).toBe(false);
  });
  it("generates disabled macOS launchd agent with discrete XML program args",()=>{
    const plan=renderMcpNamedRecoveryPreview(spec("darwin"));
    expect(plan.artifactType).toBe("macos-launch-agent-plist");
    expect(plan.artifact).toContain("<key>ProgramArguments</key><array>");
    expect(plan.artifact).toContain("<key>Disabled</key><true/>");
    expect(plan.artifact).toContain("<key>RunAtLoad</key><false/>");
    expect(plan.artifact).toContain("<string>--token-file</string>");
    expect(plan.artifact).not.toContain("/bin/sh");
  });
  it("generates uninstalled Linux systemd user unit ordered behind anchor/owner",()=>{
    const plan=renderMcpNamedRecoveryPreview(spec("linux"));
    expect(plan.artifactType).toBe("linux-systemd-user-unit");
    expect(plan.artifact).toContain("Requires=superagent-mcp-owner.service superagent-mcp-anchor.service");
    expect(plan.artifact).toContain("After=network-online.target superagent-mcp-owner.service superagent-mcp-anchor.service");
    expect(plan.artifact).toContain("Restart=on-failure");
    expect(plan.artifact).toContain("StartLimitBurst=3");
    expect(plan.artifact).toContain("UnsetEnvironment=TUNNEL_TOKEN TUNNEL_CRED_CONTENTS TUNNEL_TOKEN_FILE");
    expect(plan.artifact).not.toContain("[Install]");
    expect(plan.artifact).not.toContain("Restart=always");
  });
  it("XML-escapes ampersands as data, not executable shell commands",()=>{
    const mac={...spec("darwin"),cloudflaredPath:"/Applications/Cloudflare & Sons/cloudflared"};
    const win={...spec("win32"),cloudflaredPath:"C:\\Tools & Labs\\cloudflared.exe"};
    expect(renderMcpNamedRecoveryPreview(mac).artifact).toContain("Cloudflare &amp; Sons");
    expect(renderMcpNamedRecoveryPreview(win).artifact).toContain("Tools &amp; Labs");
    expect(renderMcpNamedRecoveryPreview(mac).argv)
      .toEqual(["tunnel","run","--token-file",mac.tokenFilePath]);
  });
  it("does not include a credential value or a token command-line argument",()=>{
    for(const platform of ["win32","darwin","linux"] as const){
      const plan=renderMcpNamedRecoveryPreview(spec(platform));
      expect(JSON.stringify(plan)).not.toContain("secret-from-test");
      expect(plan.argv).not.toContain("--token");
      expect(plan.argv).not.toContain("service");
      expect(plan.argv[3]).toMatch(/\.token$/);
      expect(plan.publicUrl).toBe("https://mcp.rcity.web.id/mcp");
      expect(plan.verifiedLocalProfile).toBe(false);
      expect(plan.productionAuthorized).toBe(false);
    }
  });
  it("denies protected production ports and same-port overlap",()=>{
    expect(()=>renderMcpNamedRecoveryPreview({...spec("linux"),anchorPort:7888}))
      .toThrow("NAMED_RECOVERY_PROTECTED_PORT");
    expect(()=>renderMcpNamedRecoveryPreview({...spec("linux"),ownerPort:9877}))
      .toThrow("NAMED_RECOVERY_PROTECTED_PORT");
    expect(()=>renderMcpNamedRecoveryPreview({...spec("linux"),ownerPort:19320}))
      .toThrow("NAMED_RECOVERY_PORT_COLLISION");
  });
  it("rejects spoofed public hostnames and tunnel UUID",()=>{
    expect(()=>renderMcpNamedRecoveryPreview({...spec("linux"),hostname:"evil.trycloudflare.com"}))
      .toThrow();
    expect(()=>renderMcpNamedRecoveryPreview({...spec("win32"),tunnelId:"not-a-uuid"}))
      .toThrow("NAMED_RECOVERY_UUID_INVALID");
  });
  it("rejects traversals, UNC paths, and Windows device names",()=>{
    expect(()=>renderMcpNamedRecoveryPreview({...spec("linux"),cloudflaredPath:"/usr/../bin/cloudflared"}))
      .toThrow("NAMED_RECOVERY_PATH_UNSAFE");
    expect(()=>renderMcpNamedRecoveryPreview({...spec("win32"),cloudflaredPath:"\\\\server\\share\\cloudflared.exe"}))
      .toThrow();
    expect(()=>renderMcpNamedRecoveryPreview({...spec("win32"),cloudflaredPath:"C:\\CON\\cloudflared.exe"}))
      .toThrow();
  });
  it("rejects shell metacharacters and substituted executable path placeholders",()=>{
    expect(()=>renderMcpNamedRecoveryPreview({...spec("linux"),cloudflaredPath:"/opt/$(whoami)/cloudflared"}))
      .toThrow("NAMED_RECOVERY_PATH_UNSAFE");
    expect(()=>renderMcpNamedRecoveryPreview({...spec("linux"),cloudflaredPath:"/usr/bin/cloudflared;curl"}))
      .toThrow("NAMED_RECOVERY_PATH_UNSAFE");
    expect(()=>renderMcpNamedRecoveryPreview({...spec("darwin"),cloudflaredPath:"/opt/${BINARY}/cloudflared"}))
      .toThrow("NAMED_RECOVERY_PATH_UNSAFE");
  });
  it("rejects token files outside the private owner profile or in shared folders",()=>{
    expect(()=>renderMcpNamedRecoveryPreview({...spec("linux"),tokenFilePath:"/home/example/Downloads/"+id+".token"}))
      .toThrow("NAMED_RECOVERY_TOKEN_OUTSIDE_PRIVATE_PROFILE");
    expect(()=>renderMcpNamedRecoveryPreview({...spec("linux"),
      tokenFilePath:"/tmp/private/cloudflare-named/"+id+".token"}))
      .toThrow("NAMED_RECOVERY_TOKEN_SHARED_LOCATION");
    expect(()=>renderMcpNamedRecoveryPreview({...spec("linux"),
      tokenFilePath:"/home/example/private/cloudflare-named/not-ours.token"}))
      .toThrow("NAMED_RECOVERY_TOKEN_OUTSIDE_PRIVATE_PROFILE");
  });
  it("fails closed on unsupported OS and native cross-platform attestation",()=>{
    expect(()=>renderMcpNamedRecoveryPreview({...spec("linux"),platform:"freebsd" as NamedRecoveryPlatform}))
      .toThrow("NAMED_RECOVERY_OS_UNSUPPORTED");
    const other=process.platform==="win32"?"linux":"win32";
    expect(()=>planMcpNamedRecovery({expectedTunnelId:id,
      expectedHostname:"mcp.rcity.web.id",platform:other}))
      .toThrow("NAMED_RECOVERY_NATIVE_HOST_REQUIRED");
  });
  it("guards rollback: no service activation, endpoint migration, or quick-tunnel mutation",()=>{
    const p=renderMcpNamedRecoveryPreview(spec("linux"));
    expect(p.bootOrder).toEqual(["mcp-owner","mcp-anchor","named-connector"]);
    expect(p.rollbackOrder).toEqual([
      "quarantine-named-connector","retain-current-quick-tunnel","reconcile-owner-and-anchor",
    ]);
    expect(p.quickTunnelUnchanged).toBe(true);
    expect(p.requiresOperatorReview).toBe(true);
    expect(p.nativeDependencyVerified).toBe(false);
    expect(p.blockers).toContain("NAMED_RECOVERY_R0_R7_OPERATOR_APPROVAL_REQUIRED");
  });
  it("refuses a mismatched expected native profile without reading credentials",()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),"named-recovery-negative-"));
    try{
      const record={
        version:1,connectorMode:"remote-managed",tunnelId:id,hostname:"mcp.rcity.web.id",
        anchorPort:19320,ownerPort:19321,
        tokenFilePath:path.join(root,"private","cloudflare-named",id+".token"),
        credentialsFilePath:"",
        cloudflaredPath:path.join(root,process.platform==="win32"?"cloudflared.exe":"cloudflared"),
      };
      fs.writeFileSync(path.join(root,"mcp-named-tunnel-settings.json"),JSON.stringify(record));
      expect(()=>planMcpNamedRecovery({root,expectedTunnelId:id,
        expectedHostname:"other.rcity.web.id"}))
        .toThrow("NAMED_RECOVERY_EXPECTED_IDENTITY_MISMATCH");
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  });
});
