import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { AcpServer } from "../../src/core/channels/acp/acpServer.js";
import {
  ACP_ERROR_CODES,
  ACP_PROTOCOL_VERSION,
  createAcpRequest,
  createAcpSuccessResponse,
} from "../../src/core/channels/acp/types.js";

// Helper to collect line-delimited JSON-RPC messages from a stream
function createMessageCollector(stream: PassThrough) {
  const messages: any[] = [];
  let buffer = "";

  stream.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        messages.push(JSON.parse(line));
      }
    }
  });

  return {
    messages,
    waitForMessage: async (predicate: (msg: any) => boolean, timeoutMs = 2000): Promise<any> => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const found = messages.find(predicate);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("Timed out waiting for message matching predicate");
    },
  };
}

describe("AcpServer - Bidirectional JSON-RPC Transport", () => {
  it("completes the initialize handshake successfully", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const collector = createMessageCollector(serverToClient);

    const server = new AcpServer({
      inputStream: clientToServer,
      outputStream: serverToClient,
      name: "superagent-test",
      version: "1.14.107",
    });

    server.start();

    // Client sends initialize request
    const initReq = createAcpRequest(1, "initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: { name: "tline-desktop", version: "0.9.0" },
      capabilities: { streaming: true, interactivePermissions: true },
      workspace: { workspacePath: "D:/test/workspace" },
    });

    clientToServer.write(JSON.stringify(initReq) + "\n");

    const response = await collector.waitForMessage((m) => m.id === 1);
    expect(response.jsonrpc).toBe("2.0");
    expect(response.result.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    expect(response.result.agentInfo.name).toBe("superagent-test");
    expect(response.result.capabilities.promptStreaming).toBe(true);

    server.close();
  });

  it("creates a new session and handles prompts with streaming updates", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const collector = createMessageCollector(serverToClient);

    const server = new AcpServer({
      inputStream: clientToServer,
      outputStream: serverToClient,
      onPrompt: async (params, srv) => {
        // Simulate LLM streaming thought and text
        srv.sendUpdate(params.sessionId, {
          kind: "thought_chunk",
          delta: "Analyzing workspace context...",
        });
        srv.sendUpdate(params.sessionId, {
          kind: "text_chunk",
          delta: "Hello from Superagent!",
        });
      },
    });

    server.start();

    // 1. Create session
    const newSessionReq = createAcpRequest(2, "session/new", {
      workspacePath: "D:/test/workspace",
      clientMode: "tline",
    });
    clientToServer.write(JSON.stringify(newSessionReq) + "\n");

    const sessionResp = await collector.waitForMessage((m) => m.id === 2);
    expect(sessionResp.result.sessionId).toBeDefined();
    const sessionId = sessionResp.result.sessionId;

    // 2. Send prompt
    const promptReq = createAcpRequest(3, "session/prompt", {
      sessionId,
      prompt: "Hello Superagent",
    });
    clientToServer.write(JSON.stringify(promptReq) + "\n");

    const promptResp = await collector.waitForMessage((m) => m.id === 3);
    expect(promptResp.result.accepted).toBe(true);

    // 3. Receive streaming updates
    const thoughtUpdate = await collector.waitForMessage(
      (m) => m.method === "session/update" && m.params.update.kind === "thought_chunk"
    );
    expect(thoughtUpdate.params.update.delta).toBe("Analyzing workspace context...");

    const textUpdate = await collector.waitForMessage(
      (m) => m.method === "session/update" && m.params.update.kind === "text_chunk"
    );
    expect(textUpdate.params.update.delta).toBe("Hello from Superagent!");

    server.close();
  });

  it("handles parse errors and unknown methods gracefully", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const collector = createMessageCollector(serverToClient);

    const server = new AcpServer({
      inputStream: clientToServer,
      outputStream: serverToClient,
    });

    server.start();

    // 1. Send invalid JSON
    clientToServer.write("MALFORMED JSON LINE\n");
    const parseError = await collector.waitForMessage((m) => m.error?.code === ACP_ERROR_CODES.PARSE_ERROR);
    expect(parseError.error.message).toContain("Parse error");

    // 2. Send unknown method
    const unknownReq = createAcpRequest(99, "non_existent_method", {});
    clientToServer.write(JSON.stringify(unknownReq) + "\n");
    const methodError = await collector.waitForMessage((m) => m.id === 99);
    expect(methodError.error.code).toBe(ACP_ERROR_CODES.METHOD_NOT_FOUND);

    server.close();
  });

  it("supports reverse permission requests from agent to client", async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const collector = createMessageCollector(serverToClient);

    const server = new AcpServer({
      inputStream: clientToServer,
      outputStream: serverToClient,
    });

    server.start();

    // Start background permission request from server
    const permissionPromise = server.requestPermission({
      permissionId: "perm_1001",
      sessionId: "sess_test",
      workspacePath: "D:/test",
      action: "command_execute",
      target: "git pull",
      description: "Pull updates from git",
      riskLevel: "medium",
      expiresInMs: 2000,
    });

    // Wait for the client to receive the request
    const clientReceived = await collector.waitForMessage(
      (m) => m.method === "session/request_permission"
    );
    expect(clientReceived.params.permissionId).toBe("perm_1001");
    expect(clientReceived.params.action).toBe("command_execute");

    // Client responds with approval
    const clientResponse = createAcpSuccessResponse(clientReceived.id, {
      permissionId: "perm_1001",
      decision: "approved",
      decidedAt: Date.now(),
    });
    clientToServer.write(JSON.stringify(clientResponse) + "\n");

    const result = await permissionPromise;
    expect(result.decision).toBe("approved");

    server.close();
  });
});
