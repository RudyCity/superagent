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
