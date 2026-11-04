import { describe, expect, it } from "vitest";
import { mcpCommand } from "../src/core/commands/mcpCommand.js";
import { spawnSync } from "node:child_process";
import path from "node:path";

function ctx() {
  const lines: Array<{type: string; content: string}> = [];
  return { lines, handler: { addLine: (line: {type:string;content:string}) => lines.push(line) } as any };
}

describe("MCP backend reload commands never fall back to tunnel restart", () => {
  it("routes standalone mcp logs and reload directly, never into the agent loop", () => {
    const entry = path.resolve("dist/cli.js");
    const run = (args: string[]) => spawnSync(process.execPath, [entry, "mcp", ...args], {
      cwd:process.cwd(), encoding:"utf8", timeout:20000, maxBuffer:128_000,
    });
    const result = run(["logs", "--port", "19997", "--tail", "2"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("MCP lifecycle log");
    expect(result.stderr).not.toContain("[Delegate]");
    const unavailable = run(["reload", "--port", "19997"]);
    expect(unavailable.status).toBe(1);
    expect(unavailable.stderr).toContain("MCP_RELOAD_NO_MANAGED_OWNER");
    expect(unavailable.stderr).not.toContain("[Delegate]");
    const bare = run(["reload"]);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain("interactive TUI");
  }, 70_000);

  it("bootstrap token regeneration fails closed on unknown owners and never prints credentials", async () => {
    const invalid = ctx();
    await mcpCommand.execute("tunnel token regenerate --mcp-port 19997", invalid.handler);
    expect(invalid.lines.at(-1)?.type).toBe("error");
    expect(invalid.lines.at(-1)?.content).toContain("MCP_BOOTSTRAP_NO_MANAGED_OWNER");
    const wrong = ctx();
    await mcpCommand.execute("tunnel token regenerate --port 70000", wrong.handler);
    expect(wrong.lines.at(-1)?.content).toContain("Invalid MCP bootstrap rotation port");
    const guide = ctx();
    await mcpCommand.execute("help", guide.handler);
    expect(guide.lines.at(-1)?.content).toContain("token regenerate --port <port>");
  });

  it("standalone token command routes directly and fails on missing owner without opening an agent", () => {
    const cli = path.resolve("dist/cli.js");
    const result = spawnSync(process.execPath,[
      cli,"mcp","tunnel","token","regenerate","--mcp-port","19997",
    ], {cwd:process.cwd(), encoding:"utf8", timeout:20000, maxBuffer:64_000});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MCP_BOOTSTRAP_NO_MANAGED_OWNER");
    expect(result.stderr).not.toContain("[Delegate]");
    expect(result.stdout).not.toContain("APPROVAL CODE");
  },30_000);

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
  it("provides MCP command help and a shorter /mcp logs alias", async () => {
    const help = ctx();
    await mcpCommand.execute("help", help.handler);
    expect(help.lines.at(-1)?.content).toContain("SuperAgent MCP");
    expect(help.lines.at(-1)?.content).toContain("restart --port <port> --full");
    expect(help.lines.at(-1)?.content).toContain("Quick URL may change");
    const tunnelHelp = ctx();
    await mcpCommand.execute("tunnel help", tunnelHelp.handler);
    expect(tunnelHelp.lines.at(-1)?.content).toContain("blue-green backend reload");
    const alias = ctx();
    await mcpCommand.execute("logs --port 19997 --tail 20", alias.handler);
    expect(alias.lines.at(-1)?.type).toBe("system");
    expect(alias.lines.at(-1)?.content).toContain("MCP lifecycle log");
  });

  it("exposes read-only MCP lifecycle logs and rejects oversized tail requests", async () => {
    const result = ctx();
    await mcpCommand.execute("tunnel logs --port 19997 --tail 20", result.handler);
    expect(result.lines.at(-1)?.type).toBe("system");
    expect(result.lines.at(-1)?.content).toContain("MCP lifecycle log");
    for (const bad of ["tunnel logs --port 70000", "tunnel logs --port 19997 --tail 101"]) {
      const r = ctx();
      await mcpCommand.execute(bad, r.handler);
      expect(r.lines.at(-1)?.type).toBe("error");
      expect(r.lines.at(-1)?.content).toContain("Invalid MCP lifecycle log port or tail");
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
