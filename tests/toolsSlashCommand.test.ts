import { describe, it, expect } from "vitest";
import { toolsCommand } from "../src/core/commands/coreCommands.js";

describe("Slash Command: /tools", () => {
  it("lists all available tools when run with no arguments", async () => {
    const lines: string[] = [];
    const ctx = {
      addLine: (line: any) => {
        lines.push(line.content);
      },
    } as any;

    await toolsCommand.execute("", ctx);
    expect(lines.length).toBeGreaterThan(0);
    const output = lines.join("\n");
    expect(output).toContain("Available AI Tools");
    expect(output).toContain("control_chrome_cdp");
    expect(output).toContain("run_command");
  });

  it("describes a specific tool on /tools describe <name>", async () => {
    const lines: string[] = [];
    const ctx = {
      addLine: (line: any) => {
        lines.push(line.content);
      },
    } as any;

    await toolsCommand.execute("describe control_chrome_cdp", ctx);
    expect(lines.length).toBeGreaterThan(0);
    const output = lines.join("\n");
    expect(output).toContain("control_chrome_cdp");
    expect(output).toContain("parameters");
  });

  it("searches tools matching query on /tools search <query>", async () => {
    const lines: string[] = [];
    const ctx = {
      addLine: (line: any) => {
        lines.push(line.content);
      },
    } as any;

    await toolsCommand.execute("search cdp", ctx);
    expect(lines.length).toBeGreaterThan(0);
    const output = lines.join("\n");
    expect(output).toContain("control_chrome_cdp");
  });
});
