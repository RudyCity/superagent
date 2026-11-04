import { describe, expect, it } from "vitest";
import { handleServerRoute } from "../src/serverRoutes.js";

type Reply = { status: number; payload: any };
async function invokeHost(input: {
  method?: string; name?: unknown; args?: unknown; body?: string;
  remote?: string; host?: string; origin?: string;
} = {}): Promise<Reply> {
  let reply: Reply | undefined;
  const req: any = {
    method: input.method || "POST",
    headers: {
      host: input.host || "127.0.0.1:7888",
      ...(input.origin ? { origin: input.origin } : {}),
    },
    socket: { remoteAddress: input.remote || "127.0.0.1" },
  };
  const res: any = { setHeader() {} };
  const body = input.body ?? JSON.stringify({
    name: input.name ?? "superagent_delegate_read_chat",
    arguments: input.args ?? { connections: true },
  });
  const handled = await handleServerRoute(req, res,
    "/api/delegate/mcp-dispatch",
    new URL("http://127.0.0.1:7888/api/delegate/mcp-dispatch"),
    {
      activeSessions: new Map(),
      sendJSON: (_res: unknown, status: number, payload: unknown) => { reply = { status, payload }; },
      readBody: async () => body,
    } as any,
  );
  expect(handled).toBe(true);
  expect(reply).toBeDefined();
  return reply!;
}

describe("Host-owned Delegate MCP route", () => {
  it("reads paired-client roster from the same host bridge without creating another socket", async () => {
    const reply = await invokeHost();
    expect(reply.status).toBe(200);
    expect(reply.payload.success).toBe(true);
    expect(JSON.parse(reply.payload.result)).toEqual(expect.objectContaining({
      connections: expect.any(Array), count: expect.any(Number),
    }));
  });
  it("rejects non-loopback and browser-origin requests", async () => {
    expect((await invokeHost({ remote: "192.0.2.50" })).status).toBe(403);
    expect((await invokeHost({ host: "superagent.example" })).status).toBe(403);
    expect((await invokeHost({ origin: "https://chatgpt.com" })).status).toBe(403);
  });
  it("does not accept methods other than POST", async () => {
    const reply = await invokeHost({ method: "GET" });
    expect(reply.status).toBe(405);
  });
  it("strictly rejects malformed, oversized, or mutation-without-message payloads", async () => {
    expect((await invokeHost({ name: "delegate.send_message" })).status).toBe(400);
    expect((await invokeHost({ name: ["superagent_delegate_read_chat"] })).status).toBe(400);
    expect((await invokeHost({ name: "superagent_delegate_send_message", args: {} })).status).toBe(400);
    expect((await invokeHost({ body: '{"name":"superagent_delegate_read_chat","arguments":{},"extra":1}' })).status).toBe(400);
    expect((await invokeHost({ body: "malformed" })).status).toBe(400);
    expect((await invokeHost({ body: "x".repeat(105_001) })).status).toBe(413);
  });
  it("never guesses or creates a new ChatGPT chat for unknown profile IDs", async () => {
    const reply = await invokeHost({
      name: "superagent_delegate_read_chat",
      args: { clientId: "this-client-does-not-exist" },
    });
    expect(reply.status).toBe(409);
    expect(reply.payload.success).toBe(false);
    expect(reply.payload.error).toContain("Error:");
  });
});
