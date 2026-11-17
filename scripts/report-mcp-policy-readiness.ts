/**
 * Safe CI/operator report. Does not inspect or change any running MCP service.
 * Usage: bun scripts/report-mcp-policy-readiness.ts
 */
import { buildMcpPolicyReadinessReport } from "../src/core/mcp/mcpPolicyReadinessReport.js";

const report = buildMcpPolicyReadinessReport();
console.log(JSON.stringify({
  ...report,
  unsafeToolNames: report.unsafeToolNames,
}, null, 2));
if (!report.classificationComplete) process.exitCode = 2;
