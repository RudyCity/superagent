import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { getYoloModeState, isFullYoloMode, setFullYoloMode, setYoloMode } from "../src/core/permissions.js";

describe("MCP YOLO authorization boundaries", () => {
  let root = "";
  let configDir = "";
  let outsideDir = "";
  let previousConfig: string | undefined;

  const identity = () => ({
    mode: "oauth" as const, subject: "trusted-writer",
    scopes: ["mcp:tools", "mcp:tools:write", "mcp:tools:admin"],
  });

  const makeServer = (audit: any[] = [], exposure: "full" | "gateway" = "full") =>
    createSuperagentMcpServer({
      workspace: root, toolExposure: exposure, authMode: "oauth", allowDangerous: true,
      getIdentity: identity, onToolCall: event => audit.push(event),
    });

  const listNames = async (server: ReturnType<typeof makeServer>): Promise<string[]> => {
    const handler = (server as any)._requestHandlers.get("tools/list");
    const result = await handler({ method: "tools/list", params: {} }, {});
    return result.tools.map((tool: any) => tool.name);
  };

  const write = (server: ReturnType<typeof makeServer>, filepath: string) => {
    const handler = (server as any)._requestHandlers.get("tools/call");
    return handler({
      method: "tools/call",
      params: {
        name: "superagent_write_files",
        arguments: { files: [{ filePath: filepath, content: "MCP_WRITE", overwrite: true }], cwd: root },
      },
    }, {});
  };

  beforeEach(() => {
    previousConfig = process.env.SUPERAGENT_CONFIG_DIR;
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-yolo-config-"));
    root = path.join(configDir, "workspace");
    fs.mkdirSync(root);
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-yolo-external-"));
    process.env.SUPERAGENT_CONFIG_DIR = configDir;
    setYoloMode(false);
  });

  afterEach(() => {
    setYoloMode(false);
    if (previousConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = previousConfig;
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("YOLO OFF hides and rejects dangerous calls despite --allow-dangerous and all OAuth scopes", async () => {
    const audit: any[] = [];
    const server = makeServer(audit);
    const filepath = path.join(root, "denied.txt");
    try {
      expect(await listNames(server)).not.toContain("superagent_write_files");
      expect(await listNames(server)).not.toContain("superagent_grant_project_access");
      await expect(write(server, filepath)).rejects.toThrow(/YOLO OFF/);
      expect(fs.existsSync(filepath)).toBe(false);
      expect(audit.at(-1)).toMatchObject({
        tool: "superagent_write_files", ok: false,
        authorizationDecision: "denied", errorCode: "yolo_off", args: {},
      });
    } finally { await server.close(); }
  });

  it("Scoped YOLO permits in-scope edits and rejects writes outside scope", async () => {
    setYoloMode(true);
    const server = makeServer();
    try {
      expect(await listNames(server)).toContain("superagent_write_files");
      const inside = path.join(root, "inside.txt");
      const result = await write(server, inside);
      expect(result.isError).not.toBe(true);
      expect(fs.readFileSync(inside, "utf8")).toBe("MCP_WRITE");
      const outside = path.join(outsideDir, "outside.txt");
      await expect(write(server, outside)).rejects.toThrow(/Scoped YOLO boundary/);
      expect(fs.existsSync(outside)).toBe(false);
    } finally { await server.close(); }
  });

  it("independent-process downgrade to OFF immediately relocks a FULL session", async () => {
    setFullYoloMode(true);
    const server = makeServer();
    try {
      expect(await listNames(server)).toContain("superagent_write_files");
      const stateFile = path.join(configDir, "yolo-mode.json");
      // Simulate another process writing the persisted authoritative mode.
      fs.writeFileSync(stateFile, JSON.stringify({ mode: "off" }));
      expect(getYoloModeState()).toBe("off");
      expect(isFullYoloMode()).toBe(false);
      expect(await listNames(server)).not.toContain("superagent_write_files");
      const filepath = path.join(root, "after-downgrade.txt");
      await expect(write(server, filepath)).rejects.toThrow(/YOLO OFF/);
      expect(fs.existsSync(filepath)).toBe(false);
    } finally { await server.close(); }
  });

  it("gateway recursion cannot bypass YOLO OFF", async () => {
    const server = makeServer([], "gateway");
    const filepath = path.join(root, "gateway-denied.txt");
    try {
      const handler = (server as any)._requestHandlers.get("tools/call");
      const result = await handler({
        method: "tools/call",
        params: {
          name: "superagent_tool_execute",
          arguments: {
            name: "superagent_write_files",
            arguments: { files: [{ filePath: filepath, content: "NO" }] },
          },
        },
      }, {});
      expect(result.isError).toBe(true);
      expect(fs.existsSync(filepath)).toBe(false);
    } finally { await server.close(); }
  });
});
