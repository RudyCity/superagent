/**
 * Safe CI/operator report. Does not inspect or change any running MCP service.
 * Usage: bun scripts/report-mcp-policy-readiness.ts
 */
import { buildMcpPolicyReadinessReport } from "../src/core/mcp/mcpPolicyReadinessReport.js";

if (import.meta.main) {
  const report = buildMcpPolicyReadinessReport();
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n",
      error => error ? reject(error) : resolve());
  });
  // Catalog imports also start runtime timers; only this completed report exits.
  process.exit(report.classificationComplete ? 0 : 2);
}
