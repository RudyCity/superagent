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
    expect(errorThrown.message).toContain("blocked by MCP tool allowlist");
    expect(errorThrown.message).toContain("/yolo or /yolo full");
  });

  it("activating Scoped YOLO dynamically exposes dangerous tools in tools/list", async () => {
    const server = createSuperagentMcpServer({
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
    expect(errorThrown.message).toContain("blocked by MCP tool allowlist");
  });

  it("server advertises tools.listChanged capability", () => {
    const server = createSuperagentMcpServer({
      allowedTools: safeTools,
      workspace: testWorkspace,
    });
    expect((server as any)._capabilities?.tools?.listChanged).toBe(true);
  });

  it("OAuth client with read-only scope can execute dangerous tools when YOLO is active", async () => {
    // Client has only read-only scope 'mcp:tools'
    const readOnlyIdentity = {
      mode: "oauth",
      subject: "chatgpt",
      scopes: ["mcp:tools"],
    };

    const server = createSuperagentMcpServer({
      allowedTools: safeTools,
      workspace: testWorkspace,
      authMode: "oauth",
      getIdentity: () => readOnlyIdentity,
    });

    const callHandler = (server as any)._requestHandlers?.get(CallToolRequestSchema.shape.method.value);
    const targetFile = path.join(testWorkspace, "oauth_yolo.txt");

    // 1. In safe mode (YOLO off), calling dangerous tool should fail
    setYoloMode(false);
    let errSafe: any = null;
    try {
      await callHandler(
        {
          method: "tools/call",
          params: {
            name: "superagent_write_files",
            arguments: { files: [{ filePath: targetFile, content: "test" }] },
          },
        },
        {}
      );
    } catch (e: any) {
      errSafe = e;
    }
    expect(errSafe).not.toBeNull();

    // 2. Turn on YOLO mode: dangerous tool is now executable even with mcp:tools scope
    setFullYoloMode(true);
    const result = await callHandler(
      {
        method: "tools/call",
        params: {
          name: "superagent_write_files",
          arguments: { files: [{ filePath: targetFile, content: "oauth yolo success" }] },
        },
      },
      {}
    );
    expect(result.isError).toBeFalsy();
    expect(fs.readFileSync(targetFile, "utf-8")).toBe("oauth yolo success");
  });
});

