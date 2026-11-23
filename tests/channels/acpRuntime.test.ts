import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { AcpRuntime } from "../../src/core/channels/acp/acpRuntime.js";
import { AcpHttpServer } from "../../src/core/channels/acp/acpHttpServer.js";
import {
  ACP_PROTOCOL_VERSION,
  createAcpRequest,
} from "../../src/core/channels/acp/types.js";

describe("AcpRuntime - Agent Integration & Prompt Lifecycle", () => {
  it("initializes runtime server with custom streams", async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const runtime = new AcpRuntime({
      inputStream: input,
      outputStream: output,
      name: "acp-runtime-test",
    });

    runtime.start();

    // Verify initialize
    let responseText = "";
    const donePromise = new Promise<void>((resolve) => {
      output.on("data", (chunk) => {
        responseText += chunk.toString();
        if (responseText.includes("\n")) {
          resolve();
        }
      });
    });

    const initReq = createAcpRequest(1, "initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: { name: "test-client", version: "1.0.0" },
      capabilities: {},
      workspace: { workspacePath: process.cwd() },
    });

    input.write(JSON.stringify(initReq) + "\n");
    await donePromise;

    const parsed = JSON.parse(responseText.trim());
    expect(parsed.id).toBe(1);
    expect(parsed.result.agentInfo.name).toBe("acp-runtime-test");

    runtime.close();
  });

  it("activates goal mode and streams status for /goal or /loop prompts", async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const runtime = new AcpRuntime({
      inputStream: input,
      outputStream: output,
      name: "acp-loop-test",
    });

    runtime.start();

    // 1. session/new
    const newSessionReq = createAcpRequest(2, "session/new", {
      workspacePath: process.cwd(),
      clientMode: "tline",
    });
    input.write(JSON.stringify(newSessionReq) + "\n");

    // Wait for response
    let lines: string[] = [];
    await new Promise<void>((resolve) => {
      output.on("data", (chunk) => {
        lines.push(...chunk.toString().split("\n").filter(Boolean));
        if (lines.length >= 1) resolve();
      });
    });

    const sessionRes = JSON.parse(lines[0]);
    expect(sessionRes.id).toBe(2);
    const sessionId = sessionRes.result.sessionId;

    // 2. session/prompt with /goal
    lines = [];
    const promptReq = createAcpRequest(3, "session/prompt", {
      sessionId,
      prompt: "/goal Build long-running autonomous loop",
    });
    input.write(JSON.stringify(promptReq) + "\n");

    await new Promise<void>((resolve) => {
      output.on("data", (chunk) => {
        lines.push(...chunk.toString().split("\n").filter(Boolean));
        if (lines.length >= 2) resolve();
      });
    });

    // One of the lines should be prompt ACK, and one should be notification with Goal Mode Activated
    const hasGoalActivation = lines.some((l) => {
      try {
        const msg = JSON.parse(l);
        return (
          msg.method === "session/update" &&
          msg.params?.update?.summary?.includes("Goal Mode Activated")
        );
      } catch {
        return false;
      }
    });

    expect(hasGoalActivation).toBe(true);

    runtime.close();
  });

  it("initializes session agent with single tier and exposes superagent developer tools", async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const runtime = new AcpRuntime({
      inputStream: input,
      outputStream: output,
      name: "acp-tools-test",
    });

    runtime.start();

    // 1. session/new
    const newSessionReq = createAcpRequest(100, "session/new", {
      workspacePath: process.cwd(),
      clientMode: "tline",
    });
    input.write(JSON.stringify(newSessionReq) + "\n");

    let lines: string[] = [];
    await new Promise<void>((resolve) => {
      output.on("data", (chunk) => {
        lines.push(...chunk.toString().split("\n").filter(Boolean));
        if (lines.length >= 1) resolve();
      });
    });

    const sessionRes = JSON.parse(lines[0]);
    const sessionId = sessionRes.result.sessionId;

    // 2. session/prompt triggers agent creation
    lines = [];
    const promptReq = createAcpRequest(101, "session/prompt", {
      sessionId,
      prompt: "hello test",
    });
    input.write(JSON.stringify(promptReq) + "\n");

    await new Promise<void>((resolve) => {
      output.on("data", (chunk) => {
        lines.push(...chunk.toString().split("\n").filter(Boolean));
        if (lines.length >= 1) resolve();
      });
    });

    const agent = runtime.getAgent(sessionId);
    expect(agent).toBeDefined();
    expect(agent?.tier).toBe("single");

    const activeTools = await agent!.getActiveTools();
    const toolNames = activeTools.map((t) => t.name);

    // Verify full developer toolset is present
    expect(toolNames).toContain("run_command");
    expect(toolNames).toContain("write_to_file");
    expect(toolNames).toContain("replace_file_content");
    expect(toolNames).toContain("apply_patch");
    expect(toolNames).toContain("bash");
    expect(toolNames).toContain("glob");
    expect(toolNames).toContain("grep");

    runtime.close();
  });
});

describe("AcpHttpServer - Remote HTTP & SSE Transport", () => {
  let server: AcpHttpServer;
  const testPort = 7899;

  beforeAll(async () => {
    server = new AcpHttpServer({
      port: testPort,
      host: "127.0.0.1",
    });
    await server.start();
  });

  afterAll(async () => {
    await server.close();
  });

  it("handles JSON-RPC initialize via POST /api/acp", async () => {
    const reqBody = createAcpRequest(10, "initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: { name: "tline-remote", version: "0.9.0" },
      capabilities: {},
      workspace: { workspacePath: process.cwd() },
    });

    const res = await fetch(`http://127.0.0.1:${testPort}/api/acp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    });

    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.id).toBe(10);
    expect(json.result.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    expect(json.result.agentInfo.name).toBe("superagent-acp-core");
  });

  it("handles session/new via POST /api/acp", async () => {
    const reqBody = createAcpRequest(11, "session/new", {
      workspacePath: process.cwd(),
      clientMode: "tline",
    });

    const res = await fetch(`http://127.0.0.1:${testPort}/api/acp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    });

    expect(res.status).toBe(200);
    const json: any = await res.json();
    expect(json.id).toBe(11);
    expect(json.result.sessionId).toBeDefined();
    expect(json.result.status).toBe("ready");
  });

  it("rejects malformed requests with 400 Bad Request", async () => {
    const res = await fetch(`http://127.0.0.1:${testPort}/api/acp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "NOT_VALID_JSON",
    });

    expect(res.status).toBe(400);
    const json: any = await res.json();
    expect(json.error.code).toBe(-32700);
  });
});
