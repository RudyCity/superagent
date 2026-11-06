import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleServerRoute } from "../src/serverRoutes.js";
import { ensureServerAuthToken } from "../src/core/utils/serverSecurity.js";
import { controlChromeCdpTool } from "../src/core/tools/chromeCdpTools.js";
import { controlChromeVisionTool } from "../src/core/tools/chromeVisionTools.js";
import { delegateReadChatTool, delegateSendMessageTool } from "../src/core/tools/delegateTools.js";
import {
  getDelegateMcpPrincipalId, runWithAuthenticatedDelegatePrincipal,
} from "../src/core/browserTransport/delegatePrincipalPolicy.js";
import {
  createDelegateForwardedSigner, createDelegateForwardedVerifier,
  generateDelegateForwardedChannelMaterial,
} from "../src/core/browserTransport/delegateForwardedPrincipal.js";

/**
 * This test ONLY substitutes the private Core verifier adapter. Its protocol
 * uses Worker A's real MAC/target/time/replay verifier, and its callback is
 * invoked under the same trusted ALS principal as production. No global key
 * installation, live services, files, or browser state.
 */
const fixture = vi.hoisted(() => ({
  verifier: undefined as undefined | ((body: unknown) => any),
  calls: 0,
}));
vi.mock("../src/core/browserTransport/delegateForwardedPrincipal.js", async importOriginal => {
  const protocol = await importOriginal<
    typeof import("../src/core/browserTransport/delegateForwardedPrincipal.js")
  >();
  const principal = await import("../src/core/browserTransport/delegatePrincipalPolicy.js");
  return {
    ...protocol,
    withVerifiedDelegateForwardedPrincipal: <T>(
      body: unknown, callback: (verified: any) => T,
    ): T => {
      fixture.calls++;
      if (!fixture.verifier) throw new Error("DELEGATE_FORWARD_BRIDGE_NOT_PROVISIONED");
      const verified = fixture.verifier(body);
      return principal.runWithAuthenticatedDelegatePrincipal({
        sessionId: verified.connectionSessionId, mode: verified.mode,
        subject: verified.subjectHash,
      }, () => callback(verified));
    },
  };
});

const identity = {
  sessionId: "6d699c47-5ab2-49dd-9d2e-6a015356a111",
  mode: "oauth" as const, subject: "verified-mcp-user",
};
const client = "profileAlpha123";
const base = {
  command: "list_targets", transport: "delegate",
  delegateClientId: client,
};
type Reply = { status: number; payload: any; headers: Record<string, string> };
async function call(body: unknown, options: {
  method?: string; remote?: string; host?: string;
  origin?: string; referer?: string; forwarded?: string;
  bearer?: string; content?: string; query?: string;
} = {}): Promise<Reply> {
  const route = "/api/delegate/mcp-dispatch";
  const req: any = {
    method: options.method ?? "POST",
    url: route + (options.query ?? ""),
    headers: {
      host: options.host ?? "127.0.0.1:7888",
      authorization: options.bearer === undefined
        ? "Bearer " + ensureServerAuthToken() : options.bearer,
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.referer ? { referer: options.referer } : {}),
      ...(options.forwarded ? { "x-forwarded-for": options.forwarded } : {}),
    },
    socket: { remoteAddress: options.remote ?? "127.0.0.1" },
  };
  const reply: Reply = { status: -1, payload: undefined, headers: {} };
  const res = {
    setHeader(key: string, value: string) { reply.headers[key.toLowerCase()] = value; },
  };
  const handled = await handleServerRoute(req, res as any, route,
    new URL("http://127.0.0.1:7888" + req.url), {
      activeSessions: new Map(),
      readBody: async () => options.content ?? JSON.stringify(body),
      sendJSON: (_res: unknown, status: number, payload: unknown) => {
        reply.status = status; reply.payload = payload;
      },
    } as any);
  expect(handled).toBe(true);
  return reply;
}

function signed(name: string, args: Record<string, unknown>, issuedAt?: number) {
  const material = generateDelegateForwardedChannelMaterial();
  const signer = createDelegateForwardedSigner(material);
  fixture.verifier = createDelegateForwardedVerifier(material);
  return runWithAuthenticatedDelegatePrincipal(identity, () =>
    signer(name, args, identity, issuedAt));
}
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

beforeEach(() => { fixture.calls = 0; fixture.verifier = undefined; });
afterEach(() => { vi.restoreAllMocks(); fixture.verifier = undefined; });

describe("Core Delegate forwarded host dispatch signed identity boundary", () => {
  it("rejects unsigned browser and semantic requests before importing/using host tools", async () => {
    const browser = vi.spyOn(controlChromeCdpTool, "execute");
    const semantic = vi.spyOn(delegateReadChatTool, "execute");
    expect(await call({ name: "superagent_chrome_cdp", arguments: base })).toMatchObject({
      status: 403, payload: { success: false, error: "DELEGATE_MCP_ATTESTATION_DENIED" },
    });
    expect((await call({
      name: "superagent_delegate_read_chat", arguments: { connections: true },
    })).status).toBe(403);
    expect(fixture.calls).toBe(2);
    expect(browser).not.toHaveBeenCalled();
    expect(semantic).not.toHaveBeenCalled();
  });

  it("fails closed without a trusted private channel, even with bearer and forged attestation", async () => {
    const body = signed("superagent_chrome_cdp", base);
    fixture.verifier = undefined;
    const browser = vi.spyOn(controlChromeCdpTool, "execute");
    const answer = await call(body);
    expect(answer.status).toBe(403);
    expect(answer.payload.error).toBe("DELEGATE_MCP_ATTESTATION_DENIED");
    expect(browser).not.toHaveBeenCalled();
  });

  it("allows a legitimate signed browser request exactly once in an authenticated ALS scope", async () => {
    const body = signed("superagent_chrome_cdp", base);
    let observed: string | undefined;
    const execute = vi.spyOn(controlChromeCdpTool, "execute")
      .mockImplementation(async () => {
        await Promise.resolve();
        observed = getDelegateMcpPrincipalId();
        return "Core sees browser tabs";
      });
    const answer = await call(body);
    expect(answer.status).toBe(200);
    expect(answer.payload).toEqual({ success: true, result: "Core sees browser tabs" });
    expect(observed).toBe(body.attestation.principalId);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0]).toEqual(base);
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.headers["referrer-policy"]).toBe("no-referrer");
    expect(answer.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("dispatches a validated signed semantic tool under the same original principal", async () => {
    const args = { connections: true };
    const body = signed("superagent_delegate_read_chat", args);
    let observed: string | undefined;
    const execute = vi.spyOn(delegateReadChatTool, "execute").mockImplementation(async () => {
      observed = getDelegateMcpPrincipalId();
      return '{"connections":[],"count":0}';
    });
    const answer = await call(body);
    expect(answer).toMatchObject({
      status: 200, payload: { success: true, result: '{"connections":[],"count":0}' },
    });
    expect(observed).toBe(body.attestation.principalId);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0]).toEqual(args);
  });

  it("can route a signed vision status read but never trusts a forged browser actor", async () => {
    const args = {
      command: "status", transport: "delegate", delegateClientId: client,
      payload: JSON.stringify({ transport: "delegate", delegateClientId: client }),
    };
    const body = signed("superagent_chrome_vision", args);
    const exec = vi.spyOn(controlChromeVisionTool, "execute").mockResolvedValue("vision status");
    const reply = await call(body);
    expect(reply.status).toBe(200);
    expect(reply.payload.result).toBe("vision status");
    expect(exec).toHaveBeenCalledOnce();
  });

  it("consumes signed nonce before dispatch and rejects subsequent replay with 409", async () => {
    const body = signed("superagent_chrome_cdp", base);
    const execute = vi.spyOn(controlChromeCdpTool, "execute").mockResolvedValue("once");
    const first = await call(body);
    const duplicate = await call(body);
    expect([first.status, duplicate.status]).toEqual([200, 409]);
    const again = await call(body);
    expect(again.status).toBe(409);
    expect(again.payload.error).toBe("DELEGATE_MCP_ATTESTATION_REPLAY");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("blocks concurrent duplicate requests without sending a second browser operation", async () => {
    const body = signed("superagent_chrome_cdp", base);
    const execute = vi.spyOn(controlChromeCdpTool, "execute").mockResolvedValue("once");
    const results = await Promise.all([call(body), call(body)]);
    expect(results.map(r => r.status).filter(status => status === 200)).toHaveLength(1);
    expect(results.map(r => r.status).filter(status => status === 403 || status === 409)).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects even validly signed contradictory qualified target/profile/tab selectors", async () => {
    const args = {
      command: "snapshot", transport: "delegate", delegateClientId: client,
      delegateTabId: 37, targetId: "delegate:profileBravo123:37",
    };
    const body = signed("superagent_chrome_cdp", args);
    const execute = vi.spyOn(controlChromeCdpTool, "execute");
    const reply = await call(body);
    expect(reply.status).toBe(403);
    expect(reply.payload).toEqual({ success: false, error: "DELEGATE_MCP_TARGET_DENIED" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("denies tampering with tool name, tab/profile/transport, payload or signature without dispatch", async () => {
    const args = {
      command: "snapshot", transport: "delegate",
      delegateClientId: client, delegateTabId: 37,
      targetId: "delegate:" + client + ":37",
    };
    const original = signed("superagent_chrome_cdp", args);
    const execute = vi.spyOn(controlChromeCdpTool, "execute");
    const mutations: Array<(x: any) => void> = [
      x => { x.name = "superagent_chrome_vision"; },
      x => { x.arguments.command = "navigate"; },
      x => { x.arguments.delegateClientId = "profileBravo123"; },
      x => { x.arguments.delegateTabId = 38; },
      x => { x.arguments.transport = "managed"; },
      x => { x.arguments.targetId = "delegate:profileBravo123:37"; },
      x => { x.attestation.target.clientId = "profileBravo123"; },
      x => { x.attestation.mac = "A".repeat(43); },
      x => { x.arguments.payload = { sessionToken: "SECRET-PAYLOAD" }; },
    ];
    for (const mutate of mutations) {
      const changed = copy(original);
      mutate(changed);
      const rejected = await call(changed);
      expect(rejected.status).toBe(403);
      expect(rejected.payload.error).toBe("DELEGATE_MCP_ATTESTATION_DENIED");
      expect(JSON.stringify(rejected.payload)).not.toContain("SECRET-PAYLOAD");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects stale and far-future signed timestamps without invoking the handler", async () => {
    const execute = vi.spyOn(controlChromeCdpTool, "execute");
    const old = signed("superagent_chrome_cdp", base, Date.now() - 40_000);
    expect((await call(old)).status).toBe(403);
    const future = signed("superagent_chrome_cdp", base, Date.now() + 20_000);
    expect((await call(future)).status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects even correctly signed but invalid or unknown tool arguments inside verified scope", async () => {
    const execute = vi.spyOn(controlChromeCdpTool, "execute");
    const unknown = signed("superagent_delegate_unknown_method", { clientId: client });
    expect((await call(unknown)).status).toBe(400);
    const invalid = signed("superagent_chrome_cdp", {
      command: "not_a_browser_command", transport: "delegate", delegateClientId: client,
    });
    const rejected = await call(invalid);
    expect(rejected.status).toBe(400);
    expect(rejected.payload.error).toBe("DELEGATE_MCP_ARGUMENTS_REJECTED");
    expect(execute).not.toHaveBeenCalled();
  });

  it("never returns tool errors containing secrets, tokens, URLs or private messages", async () => {
    const secret = "PRIVATE-SESSION-TOKEN-12345";
    const execute = vi.spyOn(controlChromeCdpTool, "execute")
      .mockResolvedValue("control_chrome_cdp failed: token=" + secret + " https://private.example/secret");
    const result = await call(signed("superagent_chrome_cdp", base));
    expect(result.status).toBe(409);
    expect(result.payload).toEqual({ success: false, error: "DELEGATE_MCP_TOOL_FAILED" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(execute).toHaveBeenCalledOnce();

    vi.spyOn(delegateSendMessageTool, "execute")
      .mockResolvedValue("Error: leaked chat text " + secret);
    const send = await call(signed("superagent_delegate_send_message", {
      clientId: client, tabId: 37, message: "hello",
    }));
    expect(send.status).toBe(409);
    expect(JSON.stringify(send.payload)).not.toContain(secret);
    expect(send.payload.error).toBe("DELEGATE_MCP_TOOL_FAILED");
  });

  it("enforces real bearer and local socket, host, proxy, origin constraints before verifier", async () => {
    const body = signed("superagent_chrome_cdp", base);
    const execute = vi.spyOn(controlChromeCdpTool, "execute");
    expect((await call(body, { bearer: "" })).status).toBe(401);
    expect((await call(body, { bearer: "Bearer forged" })).status).toBe(401);
    expect((await call(body, { remote: "198.51.100.34" })).status).toBe(403);
    expect((await call(body, { host: "malicious.example" })).status).toBe(403);
    expect((await call(body, { origin: "https://malicious.example" })).status).toBe(403);
    expect((await call(body, { referer: "https://malicious.example" })).status).toBe(403);
    expect((await call(body, { forwarded: "127.0.0.1" })).status).toBe(403);
    expect(fixture.calls).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps POST-only and bounded JSON, rejects invalid body without touching verifier", async () => {
    const execute = vi.spyOn(controlChromeCdpTool, "execute");
    expect((await call({}, { method: "GET" })).status).toBe(405);
    expect((await call({}, { content: "x".repeat(112_001) })).status).toBe(413);
    expect((await call({}, { content: "{broken" })).status).toBe(400);
    expect((await call([], {})).status).toBe(400);
    expect(fixture.calls).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });
});
