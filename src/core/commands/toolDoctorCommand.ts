/**
 * MCP tool-catalog audit, shared by `/doctor tools` and the legacy
 * `/tool-doctor`, `/diagnose` and `/mcp-doctor` aliases.
 */
import type { SlashCommand, SlashCommandContext } from "./types.js";
import { registry } from "./registry.js";

/** Run the MCP tool doctor audit and print the report into the chat log. */
export async function runMcpToolDoctorAudit(ctx: SlashCommandContext, rawArgs: string): Promise<void> {
  const rawTrimmed = (typeof rawArgs === "string" ? rawArgs : "").trim();
  const now = Date.now();
  ctx.addLine({
    type: "system",
    content: "Running SuperAgent MCP Tool Doctor audit...",
    timestamp: now,
  });

  try {
    const { runToolDoctor } = await import("../mcp/mcpToolDoctor.js");
    const { checkDependencies } = await import("../mcp/mcpDependencyManager.js");
    const isFast = rawTrimmed.toLowerCase() === "fast";
    const isAll = rawTrimmed.toLowerCase() === "all" || !rawTrimmed;
    const filter = (!isFast && !isAll && rawTrimmed) ? rawTrimmed : undefined;

    const report = await runToolDoctor({
      filter,
      runSmokeTests: !isFast,
    });

    const depReport = await checkDependencies([
      "sharp", "python", "pillow", "pymupdf", "libreoffice",
      "rembg", "vision", "muse_ws", "telegram", "chrome"
    ]);

    const counts = report.summary.countsByStatus;
    const lines: string[] = [
      `\x1b[1m=== SUPERAGENT MCP TOOL DOCTOR AUDIT REPORT ===\x1b[0m`,
      `Timestamp:             ${new Date(now).toISOString()}`,
      `Total Audited Tools:   ${report.summary.totalTools} (${report.summary.activeTools} active, ${report.summary.disabledTools} disabled)`,
      `Total Audited Actions: ${report.summary.totalActions}`,
      `Host File Policy:      ${report.summary.hostPolicyActive ? "\x1b[33mACTIVE (Permanent Gate)\x1b[0m" : "\x1b[32mUNRESTRICTED\x1b[0m"}`,
      ``,
      `\x1b[36m--- STATUS TIERS ---\x1b[0m`,
      `  • Discovered:            ${counts.discovered}`,
      `  • Schema Valid:          ${counts.schema_valid}`,
      `  • Policy Classified:     ${counts.policy_classified}`,
      `  • Authorized:            ${counts.authorized}`,
      `  • Dependency Ready:      ${counts.dependency_ready}`,
      `  • Runtime Reachable:     ${counts.runtime_reachable}`,
      `  • Smoke Tested (Safe):   ${counts.smoke_tested}`,
      `  • End-to-End Verified:   ${counts.end_to_end_verified}`,
      `  • Not Tested (by design): ${counts.not_tested_by_design}`,
      ``,
      `\x1b[33m--- RUNTIME DEPENDENCIES ---\x1b[0m`,
      ...depReport.missing.map(m => `  • \x1b[31m[MISSING]\x1b[0m ${m.name}: ${m.remediation || "Not installed"}`),
      ...depReport.available.map(name => `  • \x1b[32m[READY]\x1b[0m ${name}`),
    ];

    const blockedActions = report.actions.filter(a => a.reasons.length > 0 && a.status !== "not_tested_by_design");
    if (blockedActions.length > 0) {
      lines.push(``, `\x1b[31m--- DETECTED ACTION BLOCKERS (${blockedActions.length}) ---\x1b[0m`);
      for (const action of blockedActions.slice(0, 10)) {
        lines.push(`  • ${action.toolName} -> ${action.action}: ${action.reasons.join("; ")}`);
      }
      if (blockedActions.length > 10) {
        lines.push(`  ... and ${blockedActions.length - 10} more action blockers.`);
      }
    }

    ctx.addLine({
      type: "system",
      content: lines.join("\n"),
      timestamp: Date.now(),
    });
  } catch (err: any) {
    ctx.addLine({
      type: "error",
      content: `Tool Doctor failed to execute: ${err?.message || err}`,
      timestamp: Date.now(),
    });
  }
}

export const toolDoctorCommand: SlashCommand = {
  name: "tool-doctor",
  aliases: ["diagnose", "mcp-doctor"],
  description: "Audit MCP tool catalog reliability, schema, dependencies, and readiness (/tool-doctor [all|fast|<tool_name>])",
  async execute(args, ctx) {
    await runMcpToolDoctorAudit(ctx, typeof args === "string" ? args : "");
  },
};

registry.register(toolDoctorCommand);
