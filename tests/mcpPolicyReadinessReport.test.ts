import {describe,expect,it} from "vitest";
import {buildMcpPolicyReadinessReport} from "../src/core/mcp/mcpPolicyReadinessReport.js";
import {MCP_TOOL_DEFINITIONS} from "../src/core/mcp/superagentMcpServer.js";
import {DISABLED_MCP_TOOLS} from "../src/core/mcp/mcpToolPolicy.js";

describe("source-only MCP policy release readiness report",()=>{
  it("accounts for every registered active tool exactly once, including aliases",()=>{
    const report=buildMcpPolicyReadinessReport();
    const active=MCP_TOOL_DEFINITIONS.filter(t=>!DISABLED_MCP_TOOLS.has(t.name));
    expect(report.registeredTools).toBe(active.length);
    expect(report.registeredTools).toBeGreaterThan(150);
    expect(report.classificationComplete).toBe(true);
    const count=Object.values(report.effectCounts).reduce((a,b)=>a+b,0);
    expect(count).toBe(active.length);
    expect(report.effectCounts.uncertified).toBeGreaterThan(0);
    expect(report.unsafeToolNames.length).toBe(report.effectCounts.uncertified);
    expect(new Set(report.unsafeToolNames).size).toBe(report.unsafeToolNames.length);
  });

  it("never implies unverified native runtime or release is certified",()=>{
    const report=buildMcpPolicyReadinessReport();
    expect(report).toMatchObject({
      version:1,scope:"source_catalog_only",codeTested:false,
      runtimeVerified:false,releaseReady:false,
    });
    expect(report.limitations.join(" ")).toMatch(/R0-R7/);
    expect(report.limitations.join(" ")).toMatch(/OAuth/);
    expect(report.unsafeToolNames).toContain("superagent_exec_command");
    expect(report.unsafeToolNames).toContain("superagent_pdf_edit");
    expect(report.unsafeToolNames).not.toContain("superagent_read_files");
  });
});
