import {describe,it,expect} from "vitest";
import {evaluateCoreMcpCutover} from "../scripts/audit-core-mcp-dev-readiness.js";
describe("production MCP/Cloudflare rollout cannot silently invalidate client URL",()=>{
  it("fails closed for legacy Quick Tunnel even with a healthy Core",()=>{
    const result=evaluateCoreMcpCutover({
      publicUrl:"https://example.trycloudflare.com/mcp",
      legacy:true,coreSupervised:true,kernelMcpOwnerVerified:true,
    });
    expect(result.publicUrlKind).toBe("cloudflare_quick_tunnel");
    expect(result.safeToAutoMigrate).toBe(false);
    expect(result.guaranteedSameUrlAcrossLegacyMigration).toBe(false);
    expect(result.canUseBackendOnlyReload).toBe(false);
    expect(result.recommendation).toContain("named Cloudflare Tunnel");
  });
  it("reports same-owner reload candidacy only, never approves automatic migration",()=>{
    const result=evaluateCoreMcpCutover({
      publicUrl:"https://mcp.example.com/mcp",
      legacy:false,coreSupervised:true,kernelMcpOwnerVerified:true,
    });
    expect(result.canUseBackendOnlyReload).toBe(true);
    expect(result.safeToAutoMigrate).toBe(false);
    expect(result.coreReadyForMcpRestart).toBe(true);
  });
});
