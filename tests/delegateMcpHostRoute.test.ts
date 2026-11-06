import { describe, expect, it, vi } from "vitest";
// Focus this legacy suite on HTTP auth/input guards. Signed forwarding is
// exercised separately in delegateForwardedHostDispatch.test.ts.
vi.mock("../src/core/utils/serverSecurity.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/core/utils/serverSecurity.js")>()),
  isRequestAuthorized: () => true,
}));
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
      authorization: "Bearer isolated-test-capability",
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
  it("rejects unsigned roster reads before touching the host bridge", async () => {
    const reply = await invokeHost();
    expect(reply).toMatchObject({
      status: 403, payload: { success: false, error: "DELEGATE_MCP_ATTESTATION_DENIED" },
    });
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
    // Parse-level defects remain 400; syntactically valid but unsigned requests
    // must be denied before argument/tool dispatch, regardless of their fields.
    expect((await invokeHost({ name: "delegate.send_message" })).status).toBe(403);
    expect((await invokeHost({ name: ["superagent_delegate_read_chat"] })).status).toBe(403);
    expect((await invokeHost({ name: "superagent_delegate_send_message", args: {} })).status).toBe(403);
    expect((await invokeHost({ body: '{"name":"superagent_delegate_read_chat","arguments":{},"extra":1}' })).status).toBe(403);
    expect((await invokeHost({ body: "malformed" })).status).toBe(400);
    expect((await invokeHost({ body: "x".repeat(112_001) })).status).toBe(413);
  });
  it("does not route unsigned messages to an unknown profile", async () => {
    const reply = await invokeHost({
      name: "superagent_delegate_read_chat",
      args: { clientId: "this-client-does-not-exist" },
    });
    expect(reply).toMatchObject({
      status: 403, payload: { success: false, error: "DELEGATE_MCP_ATTESTATION_DENIED" },
    });
  });
});
