import { describe, expect, it } from "vitest";
import { DOCTOR_USAGE, doctorCommand, resolveDoctorTarget } from "../src/core/commands/doctorCommand.js";
import { DOCTOR_SUGGESTIONS } from "../src/core/commands/commandCatalog.js";

describe("unified /doctor routing", () => {
  it("maps every supported subcommand", () => {
    expect(resolveDoctorTarget("")).toEqual({ kind: "usage" });
    expect(resolveDoctorTarget("   ")).toEqual({ kind: "usage" });
    expect(resolveDoctorTarget("processes")).toEqual({ kind: "processes" });
    expect(resolveDoctorTarget("  TERMINAL ")).toEqual({ kind: "terminal" });
    expect(resolveDoctorTarget("tools")).toEqual({ kind: "tools", args: "" });
    expect(resolveDoctorTarget("tools all")).toEqual({ kind: "tools", args: "all" });
    expect(resolveDoctorTarget("tools fast")).toEqual({ kind: "tools", args: "fast" });
    expect(resolveDoctorTarget("tools superagent_run_command")).toEqual({ kind: "tools", args: "superagent_run_command" });
  });

  it("refuses unknown or ambiguous input instead of running another scan", () => {
    expect(resolveDoctorTarget("all")).toEqual({ kind: "usage" });
    expect(resolveDoctorTarget("fast")).toEqual({ kind: "usage" });
    expect(resolveDoctorTarget("processes extra")).toEqual({ kind: "usage" });
    expect(resolveDoctorTarget("terminal extra")).toEqual({ kind: "usage" });
    expect(resolveDoctorTarget("superagent_run_command")).toEqual({ kind: "usage" });
  });

  it("prints the single usage line and stays silent on other audits", async () => {
    const lines: string[] = [];
    const ctx = { addLine: (line: { content: string }) => lines.push(line.content) } as never;

    await doctorCommand.execute("nonsense", ctx);
    expect(lines).toEqual([DOCTOR_USAGE]);
    expect(DOCTOR_USAGE).toContain("processes|terminal|tools");
  });

  it("routes terminal diagnostics through the real command", async () => {
    const lines: string[] = [];
    const ctx = { addLine: (line: { content: string }) => lines.push(line.content) } as never;

    await doctorCommand.execute("terminal", ctx);
    expect(lines.join("\n")).toContain("SUPERAGENT TERMINAL DIAGNOSTICS");
    expect(lines.join("\n")).toContain("Verdict:");
  });

  it("keeps autocomplete entries aligned with the dispatcher", () => {
    expect(DOCTOR_SUGGESTIONS).toContain("/doctor terminal");
    expect(DOCTOR_SUGGESTIONS).toContain("/doctor processes");
    expect(DOCTOR_SUGGESTIONS).toContain("/doctor tools");
    for (const suggestion of DOCTOR_SUGGESTIONS.filter((entry) => entry !== "/doctor")) {
      expect(resolveDoctorTarget(suggestion.replace("/doctor", ""))).not.toEqual({ kind: "usage" });
    }
  });
});
