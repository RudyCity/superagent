import { describe, expect, it } from "vitest";
import { mcpCommand } from "../src/core/commands/mcpCommand.js";

function ctx() {
  const lines: Array<{type: string; content: string}> = [];
  return { lines, handler: { addLine: (line: {type:string;content:string}) => lines.push(line) } as any };
}

describe("MCP backend reload commands never fall back to tunnel restart", () => {
  it("uses fail-closed reload on an unregistered port for /mcp tunnel restart", async () => {
    const {lines, handler} = ctx();
    await mcpCommand.execute("tunnel restart --port 19997", handler);
    expect(lines.at(-1)?.type).toBe("error");
    expect(lines.at(-1)?.content).toContain("MCP_RELOAD_NO_MANAGED_OWNER");
    expect(lines.at(-1)?.content).toContain("Existing URL is unchanged");
  });
  it("supports /mcp tunnel reload and /mcp reload --port without touching other tunnels", async () => {
    for (const command of ["tunnel reload --port 19997", "reload --port 19997"]) {
      const {lines, handler} = ctx();
      await mcpCommand.execute(command, handler);
      expect(lines.at(-1)?.type).toBe("error");
      expect(lines.at(-1)?.content).toContain("MCP_RELOAD_NO_MANAGED_OWNER");
    }
  });
  it("rejects invalid ports before attempting any reload", async () => {
    for (const command of ["tunnel reload --port 0", "tunnel restart --port 70000"]) {
      const {lines, handler} = ctx();
      await mcpCommand.execute(command, handler);
      expect(lines.at(-1)?.type).toBe("error");
      expect(lines.at(-1)?.content).toContain("Invalid MCP backend reload port");
    }
  });
});
