import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  createSuperagentMcpServer,
} from "../src/core/mcp/superagentMcpServer.js";
import {
  getDefaultSafeTools,
} from "../src/core/mcp/mcpHttpTransport.js";
import {
  setYoloMode,
  setFullYoloMode,
  getYoloModeState,
} from "../src/core/permissions.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

describe("MCP and YOLO Mode Dynamic Integration", () => {
  const safeTools = getDefaultSafeTools();
  const testWorkspace = path.join(os.tmpdir(), `superagent-mcp-yolo-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(testWorkspace, { recursive: true });
    setFullYoloMode(false);
    setYoloMode(false);
  });

  afterEach(() => {
    setFullYoloMode(false);
    setYoloMode(false);
    try {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    } catch {}
  });

  it("SAFE mode (YOLO off, allowDangerous false) hides dangerous tools from ListTools", async () => {
    const server = createSuperagentMcpServer({
      toolExposure: "full", // Test direct-tool policy; production defaults to gateway.
      allowedTools: safeTools,
      workspace: testWorkspace,
    });

    const handler = (server as any)._requestHandlers?.get(ListToolsRequestSchema.shape.method.value);
    expect(handler).toBeDefined();

    const response = await handler({ method: "tools/list", params: {} }, {});
    const toolNames = response.tools.map((t: any) => t.name);

    expect(toolNames).toContain("superagent_list_active");
    expect(toolNames).toContain("superagent_read_files");
    expect(toolNames).not.toContain("superagent_read_file");
    expect(toolNames).not.toContain("superagent_exec_command");
    expect(toolNames).not.toContain("superagent_write_file");
    expect(toolNames).not.toContain("superagent_write_files");
    expect(toolNames).not.toContain("superagent_replace_file_content");
  });

  it("SAFE mode blocks execution of dangerous tools with informative error", async () => {
    const server = createSuperagentMcpServer({
      toolExposure: "full", // Test direct-tool policy; production defaults to gateway.
      allowedTools: safeTools,
      workspace: testWorkspace,
    });

    const callHandler = (server as any)._requestHandlers?.get(CallToolRequestSchema.shape.method.value);
    expect(callHandler).toBeDefined();

    let errorThrown: any = null;
    try {
      await callHandler(
        {
          method: "tools/call",
          params: {
            name: "superagent_write_files",
            arguments: { files: [{ filePath: path.join(testWorkspace, "test.txt"), content: "hello" }] },
          },
        },
        {}
      );
    } catch (err: any) {
      errorThrown = err;
    }

    expect(errorThrown).not.toBeNull();
    expect(errorThrown.message).toContain("YOLO OFF denies MCP write/execute");
    expect(errorThrown.message).toContain("/yolo on");
    expect(errorThrown.message).toContain("/yolo full");
  });

  it("activating Scoped YOLO dynamically exposes dangerous tools in tools/list", async () => {
    const server = createSuperagentMcpServer({
      toolExposure: "full", // Test direct-tool policy; production defaults to gateway.
      allowedTools: safeTools,
      workspace: testWorkspace,
    });

    const listHandler = (server as any)._requestHandlers?.get(ListToolsRequestSchema.shape.method.value);

    // Initial check: off
    expect(getYoloModeState()).toBe("off");
    const initialResp = await listHandler({ method: "tools/list", params: {} }, {});
    expect(initialResp.tools.map((t: any) => t.name)).not.toContain("superagent_write_files");

    // Activate Scoped YOLO
    setYoloMode(true);
    expect(getYoloModeState()).toBe("scoped");

    const scopedResp = await listHandler({ method: "tools/list", params: {} }, {});
    const scopedNames = scopedResp.tools.map((t: any) => t.name);
    expect(scopedNames).toContain("superagent_write_files");
    expect(scopedNames).toContain("superagent_exec_command");
    expect(scopedNames).toContain("superagent_replace_file_content");
  });

  it("Scoped YOLO allows file write within workspace boundary", async () => {
    const server = createSuperagentMcpServer({
      toolExposure: "full", // Test direct-tool policy; production defaults to gateway.
      allowedTools: safeTools,
      workspace: testWorkspace,
    });

    setYoloMode(true);

    const callHandler = (server as any)._requestHandlers?.get(CallToolRequestSchema.shape.method.value);
    const targetFile = path.join(testWorkspace, "scoped_output.txt");

    const result = await callHandler(
      {
        method: "tools/call",
        params: {
          name: "superagent_write_files",
          arguments: { files: [{ filePath: targetFile, content: "scoped YOLO content", overwrite: true }], cwd: testWorkspace },
        },
      },
      {}
    );

    expect(result.isError).toBeFalsy();
    expect(fs.existsSync(targetFile)).toBe(true);
    expect(fs.readFileSync(targetFile, "utf-8")).toBe("scoped YOLO content");
  });

  it("Scoped YOLO blocks file write targeting model-config.json", async () => {
    const server = createSuperagentMcpServer({
      toolExposure: "full", // Test direct-tool policy; production defaults to gateway.
      allowedTools: safeTools,
      workspace: testWorkspace,
    });

    setYoloMode(true);

    const callHandler = (server as any)._requestHandlers?.get(CallToolRequestSchema.shape.method.value);
    const modelConfigTarget = path.join(testWorkspace, "model-config.json");

    let errorThrown: any = null;
    try {
      await callHandler(
        {
          method: "tools/call",
          params: {
            name: "superagent_write_files",
            arguments: { files: [{ filePath: modelConfigTarget, content: "hacked config" }] },
          },
        },
        {}
      );
    } catch (err: any) {
      errorThrown = err;
    }

    expect(errorThrown).not.toBeNull();
    expect(errorThrown.message).toContain("Scoped YOLO boundary");
  });

  it("Scoped YOLO blocks file write targeting out-of-bounds paths", async () => {
    const server = createSuperagentMcpServer({
      toolExposure: "full", // Test direct-tool policy; production defaults to gateway.
      allowedTools: safeTools,
      workspace: testWorkspace,
    });

    setYoloMode(true);

    const callHandler = (server as any)._requestHandlers?.get(CallToolRequestSchema.shape.method.value);
    // Path far outside the test workspace
    const outOfBoundsPath = process.platform === "win32" ? "C:\\Windows\\System32\\bad.dll" : "/etc/passwd_bad";

    let errorThrown: any = null;
    try {
      await callHandler(
        {
          method: "tools/call",
          params: {
            name: "superagent_write_files",
            arguments: { files: [{ filePath: outOfBoundsPath, content: "illegal content" }] },
          },
        },
        {}
      );
    } catch (err: any) {
      errorThrown = err;
    }

    expect(errorThrown).not.toBeNull();
    expect(errorThrown.message).toContain("Scoped YOLO boundary");
    expect(errorThrown.message).toContain("/yolo full");
  });

  it("Scoped YOLO blocks system-destructive commands", async () => {
    const server = createSuperagentMcpServer({
      toolExposure: "full", // Test direct-tool policy; production defaults to gateway.
      allowedTools: safeTools,
      workspace: testWorkspace,
    });

    setYoloMode(true);

    const callHandler = (server as any)._requestHandlers?.get(CallToolRequestSchema.shape.method.value);

    let errorThrown: any = null;
    try {
      await callHandler(
        {
          method: "tools/call",
          params: {
            name: "superagent_exec_command",
            arguments: { command: "rm -rf /", cwd: testWorkspace },
          },
        },
        {}
      );
    } catch (err: any) {
      errorThrown = err;
    }

    expect(errorThrown).not.toBeNull();
    expect(errorThrown.message).toContain("Scoped YOLO boundary");
  });

  it("Full YOLO mode permits system-wide access without scope restrictions", async () => {
    const server = createSuperagentMcpServer({
      toolExposure: "full", // Test direct-tool policy; production defaults to gateway.
      allowedTools: safeTools,
      workspace: testWorkspace,
    });

    setFullYoloMode(true);
    expect(getYoloModeState()).toBe("full");

    const callHandler = (server as any)._requestHandlers?.get(CallToolRequestSchema.shape.method.value);
    const targetFile = path.join(testWorkspace, "fullyolo.txt");

    const result = await callHandler(
      {
        method: "tools/call",
        params: {
          name: "superagent_write_files",
          arguments: { files: [{ filePath: targetFile, content: "full yolo success" }] },
        },
      },
      {}
    );

    expect(result.isError).toBeFalsy();
    expect(fs.readFileSync(targetFile, "utf-8")).toBe("full yolo success");
  });

  it("turning YOLO mode off immediately re-locks dangerous tools", async () => {
    const server = createSuperagentMcpServer({
      toolExposure: "full", // Test direct-tool policy; production defaults to gateway.
      allowedTools: safeTools,
      workspace: testWorkspace,
    });

    // Turn on
    setYoloMode(true);
    const listHandler = (server as any)._requestHandlers?.get(ListToolsRequestSchema.shape.method.value);
    const callHandler = (server as any)._requestHandlers?.get(CallToolRequestSchema.shape.method.value);

    const onResp = await listHandler({ method: "tools/list", params: {} }, {});
    expect(onResp.tools.map((t: any) => t.name)).toContain("superagent_write_files");

    // Turn off
    setYoloMode(false);
    expect(getYoloModeState()).toBe("off");

    const offResp = await listHandler({ method: "tools/list", params: {} }, {});
    expect(offResp.tools.map((t: any) => t.name)).not.toContain("superagent_write_files");

    let errorThrown: any = null;
    try {
      await callHandler(
        {
          method: "tools/call",
          params: {
            name: "superagent_write_files",
            arguments: { files: [{ filePath: path.join(testWorkspace, "foo.txt"), content: "foo" }] },
          },
        },
        {}
      );
    } catch (err: any) {
      errorThrown = err;
    }

    expect(errorThrown).not.toBeNull();
    expect(errorThrown.message).toContain("YOLO OFF denies MCP write/execute");
  });

  it("server advertises tools.listChanged capability", () => {
    const server = createSuperagentMcpServer({
      toolExposure: "full", // Test direct-tool policy; production defaults to gateway.
      allowedTools: safeTools,
      workspace: testWorkspace,
    });
    expect((server as any)._capabilities?.tools?.listChanged).toBe(true);
  });

  it("OAuth read-only scope cannot write even after Full YOLO is enabled", async () => {
    const auditEvents: any[] = [];
    const server = createSuperagentMcpServer({
      toolExposure: "full", // Test direct-tool policy; production defaults to gateway.
      allowedTools: safeTools,
      workspace: testWorkspace,
      authMode: "oauth",
      getIdentity: () => ({ mode: "oauth", subject: "reader", scopes: ["mcp:tools"] }),
      onToolCall: (event) => auditEvents.push(event),
    });
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const targetFile = path.join(testWorkspace, "denied-oauth-yolo.txt");
    setFullYoloMode(true);
    await expect(handler({
      method: "tools/call",
      params: { name: "superagent_write_files",
        arguments: { files: [{ filePath: targetFile, content: "MUST NOT WRITE" }] } },
    }, {})).rejects.toThrow(/mcp:tools:write/i);
    expect(fs.existsSync(targetFile)).toBe(false);
    expect(auditEvents.at(-1)).toMatchObject({
      tool: "superagent_write_files", ok: false, authorizationDecision: "denied",
      errorCode: "insufficient_oauth_scope",
    });
    expect(JSON.stringify(auditEvents)).not.toContain("MUST NOT WRITE");
  });

  it("OAuth read-only or missing identity cannot write with allowDangerous", async () => {
    const target = path.join(testWorkspace, "allow-dangerous-denied.txt");
    for (const identity of [
      { mode: "oauth" as const, subject: "reader", scopes: ["mcp:tools"] },
      { mode: "oauth" as const, subject: "empty", scopes: [] },
      null,
    ]) {
      const server = createSuperagentMcpServer({
      toolExposure: "full", // Test direct-tool policy; production defaults to gateway.
        workspace: testWorkspace, authMode: "oauth", allowDangerous: true,
        getIdentity: () => identity,
      });
      const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
      await expect(handler({
        method: "tools/call",
        params: { name: "superagent_write_files",
          arguments: { files: [{ filePath: target, content: "DENIED" }] } },
      }, {})).rejects.toThrow(/mcp:tools:write/i);
    }
    expect(fs.existsSync(target)).toBe(false);
  });

  it("OAuth tokens without tool scopes do not discover or invoke read-only tools", async () => {
    const server = createSuperagentMcpServer({
      toolExposure: "full", // Test direct-tool policy; production defaults to gateway.
      allowedTools: safeTools, workspace: testWorkspace, authMode: "oauth",
      getIdentity: () => ({ mode: "oauth", subject: "no-grants", scopes: [] }),
    });
    const listing = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    const invoke = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    expect((await listing({ method: "tools/list", params: {} }, {})).tools).toHaveLength(0);
    await expect(invoke({
      method: "tools/call",
      params: { name: "superagent_read_files", arguments: { files: ["README.md"] } },
    }, {})).rejects.toThrow(/mcp:tools/i);
  });

  it("revoking only admin scope immediately hides and blocks project administration", async () => {
    setYoloMode(true);
    let scopes = ["mcp:tools", "mcp:tools:write", "mcp:tools:admin"];
    const events: any[] = [];
    const server = createSuperagentMcpServer({
      toolExposure: "full", // Test direct-tool policy; production defaults to gateway.
      workspace: testWorkspace, authMode: "oauth", allowDangerous: true,
      getIdentity: () => ({ mode: "oauth", subject: "admin-client", scopes }),
      onToolCall: event => events.push(event),
    });
    const listing = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    const call = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const names = async (): Promise<string[]> => (await listing({ method: "tools/list", params: {} }, {}))
      .tools.map((tool: any) => tool.name);
    expect(await names()).toContain("superagent_grant_project_access");
    expect(await names()).toContain("superagent_write_files");
    scopes = ["mcp:tools", "mcp:tools:write"];
    expect(await names()).not.toContain("superagent_grant_project_access");
    expect(await names()).toContain("superagent_write_files");
    await expect(call({
      method: "tools/call",
      params: {
        name: "superagent_grant_project_access",
        arguments: { projectId: "should-not-exist", capabilities: ["read"], secret: "SENTINEL_NOT_FOR_AUDIT" },
      },
    }, {})).rejects.toThrow(/mcp:tools:admin/);
    expect(events.at(-1)).toMatchObject({
      tool: "superagent_grant_project_access", ok: false,
      authorizationDecision: "denied", errorCode: "insufficient_oauth_admin_scope",
      args: {},
    });
    expect(JSON.stringify(events)).not.toContain("SENTINEL_NOT_FOR_AUDIT");
  });

  it("OAuth discovery updates when the same client loses write scope", async () => {
    setYoloMode(true);
    let scopes = ["mcp:tools", "mcp:tools:write"];
    const server = createSuperagentMcpServer({
      toolExposure: "full", // Test direct-tool policy; production defaults to gateway.
      allowedTools: safeTools, authMode: "oauth", allowDangerous: true,
      workspace: testWorkspace,
      getIdentity: () => ({ mode: "oauth", subject: "mutable-client", scopes }),
    });
    const listing = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    const invoke = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const names = async () => (await listing({ method: "tools/list", params: {} }, {}))
      .tools.map((item: any) => item.name);
    expect(await names()).toContain("superagent_write_files");
    scopes = ["mcp:tools"];
    expect(await names()).not.toContain("superagent_write_files");
    expect(await names()).toContain("superagent_read_files");
    const target = path.join(testWorkspace, "revoked-write.txt");
    await expect(invoke({
      method: "tools/call",
      params: { name: "superagent_write_files",
        arguments: { files: [{ filePath: target, content: "REVOKED" }] } },
    }, {})).rejects.toThrow(/mcp:tools:write/i);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("OAuth write scope grants mutation only when dangerous tools are unlocked", async () => {
    const server = createSuperagentMcpServer({
      toolExposure: "full", // Test direct-tool policy; production defaults to gateway.
      allowedTools: safeTools,
      workspace: testWorkspace,
      authMode: "oauth",
      getIdentity: () => ({ mode: "oauth", subject: "writer",
        scopes: ["mcp:tools", "mcp:tools:write"] }),
    });
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const targetFile = path.join(testWorkspace, "oauth-writer.txt");
    const request = {
      method: "tools/call",
      params: { name: "superagent_write_files",
        arguments: { files: [{ filePath: targetFile, content: "authorized" }] } },
    };
    await expect(handler(request, {})).rejects.toThrow(/YOLO OFF denies MCP write\/execute/i);
    setFullYoloMode(true);
    const result = await handler(request, {});
    expect(result.isError).toBeFalsy();
    expect(fs.readFileSync(targetFile, "utf-8")).toBe("authorized");
  });
});

