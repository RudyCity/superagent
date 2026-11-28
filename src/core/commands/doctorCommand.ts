/**
 * Single `/doctor` entry point.
 *
 * The command used to be registered twice (MCP tool audit in `coreCommands`,
 * process supervisor in `processDoctorCommand`). Because the registry is a
 * last-write-wins Map, the help text and the real behaviour disagreed. This
 * dispatcher keeps one registration and routes to the three audits explicitly:
 *
 *   /doctor                     → usage
 *   /doctor processes           → process supervisor diagnostics
 *   /doctor terminal            → interactive stdin/TTY diagnostics
 *   /doctor tools [all|fast|<tool>] → MCP tool catalog audit
 *
 * Unrecognised input stays a refusal (usage) so `/doctor` never starts an
 * unrelated OS scan on a typo.
 */
import type { SlashCommand } from "./types.js";
import { registry } from "./registry.js";
import { formatProcessStatus } from "./processStatusViews.js";
import { formatTerminalDiagnosticsFromDisk } from "./terminalDoctorView.js";
import { runMcpToolDoctorAudit } from "./toolDoctorCommand.js";

export const DOCTOR_USAGE = "Usage: /doctor [processes|terminal|tools [all|fast|<tool_name>]]";

export type DoctorTarget =
  | { kind: "usage" }
  | { kind: "processes" }
  | { kind: "terminal" }
  | { kind: "tools"; args: string };

/** Map raw slash-command arguments to a doctor target without side effects. */
export function resolveDoctorTarget(rawArgs: string): DoctorTarget {
  const parts = (typeof rawArgs === "string" ? rawArgs : "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: "usage" };

  const [head, ...rest] = parts;
  if (head === "processes" && rest.length === 0) return { kind: "processes" };
  if (head === "terminal" && rest.length === 0) return { kind: "terminal" };
  if (head === "tools") return { kind: "tools", args: rest.join(" ") };

  return { kind: "usage" };
}

export const doctorCommand: SlashCommand = {
  name: "doctor",
  description: "Read-only diagnostics: process supervisor, terminal input and MCP tool catalog (/doctor processes|terminal|tools)",
  async execute(args, ctx) {
    const target = resolveDoctorTarget(args);

    if (target.kind === "usage") {
      ctx.addLine({ type: "system", content: DOCTOR_USAGE, timestamp: Date.now() });
      return;
    }

    if (target.kind === "terminal") {
      ctx.addLine({ type: "system", content: formatTerminalDiagnosticsFromDisk(), timestamp: Date.now() });
      return;
    }

    if (target.kind === "tools") {
      await runMcpToolDoctorAudit(ctx, target.args);
      return;
    }

    try {
      const content = await formatProcessStatus(ctx.agent?.workingDirectory ?? process.cwd(), true);
      ctx.addLine({ type: "system", content, timestamp: Date.now() });
    } catch {
      ctx.addLine({
        type: "error",
        content: "Process diagnostics unavailable; registry ownership remains unverified.",
        timestamp: Date.now(),
      });
    }
  },
};

registry.register(doctorCommand);
