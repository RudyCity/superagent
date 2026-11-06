import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleControlChromeCdp, handleControlChromeVision, validateDelegateBrowserHostArgs,
} from "../src/core/mcp/tools/chromeMcpTools.js";
import { controlChromeCdpTool } from "../src/core/tools/chromeCdpTools.js";
import { delegateBridge } from "../src/core/delegate/bridge.js";
import { handleServerRoute } from "../src/serverRoutes.js";
import { runWithAuthenticatedDelegatePrincipal } from "../src/core/browserTransport/delegatePrincipalPolicy.js";
import { ensureServerAuthToken } from "../src/core/utils/serverSecurity.js";

// Keep security utilities; replace only this fake MCP client's local bearer lookup.
vi.mock("../src/core/utils/serverSecurity.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/core/utils/serverSecurity.js")>()),
  getServerAuthToken: () => "delegate-cdp-test-token",
}));

afterEach(() => vi.restoreAllMocks());

type HostReply = { status: number; payload: any };
async function hostCall(name: string, args: Record<string, unknown>, options: {
  remote?: string; origin?: string; host?: string; method?: string;
} = {}): Promise<HostReply> {
  let reply: HostReply | undefined;
  const req: any = {
    method: options.method || "POST",
    headers: {
      host: options.host || "127.0.0.1:7888",
      authorization: "Bearer " + ensureServerAuthToken(),
      ...(options.origin ? { origin: options.origin } : {}),
    },
    socket: { remoteAddress: options.remote || "127.0.0.1" },
  };
  const handled = await handleServerRoute(req, { setHeader() {} } as any,
    "/api/delegate/mcp-dispatch",
    new URL("http://127.0.0.1:7888/api/delegate/mcp-dispatch"),
    {
      activeSessions: new Map(),
      sendJSON: (_res: unknown, status: number, payload: unknown) => { reply = { status, payload }; },
      readBody: async () => JSON.stringify({ name, arguments: args }),
    } as any,
  );
  expect(handled).toBe(true);
  return reply!;
}

describe("Delegate-CDP MCP to Core owner bridge", () => {
  it("does not forward unsigned discovery or create a second bridge", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true, json: async () => ({ success: true, result: "- id: delegate:chrome-test001:5" }),
    } as Response);
    const start = vi.spyOn(delegateBridge, "start");
    const result = await handleControlChromeCdp({
      command: "list_targets", transport: "delegate", delegateClientId: "chrome-test001",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/DELEGATE_FORWARD_/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("requires signed MCP context for auto, qualified Delegate and vision; preserves managed CDP", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true, json: async () => ({ success: true, result: "owner response" }),
    } as Response);
    const auto = await handleControlChromeCdp({ command: "list_targets", transport: "auto" });
    const qualified = await handleControlChromeCdp({
      command: "snapshot", targetId: "delegate:chrome-test001:5",
    });
    const vision = await handleControlChromeVision({
      command: "status", payload: JSON.stringify({ transport: "delegate", delegateClientId: "chrome-test001" }),
    });
    for (const result of [auto, qualified, vision]) {
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/DELEGATE_FORWARD_/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    const local = vi.spyOn(controlChromeCdpTool, "execute").mockResolvedValue("local managed result");
    const managed = await handleControlChromeCdp({ command: "list_targets", transport: "managed" });
    expect(managed.content[0].text).toBe("local managed result");
    expect(local).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never retries or forwards a mutation without a trusted signer bootstrap", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false, json: async () => ({ success: false, error: "DELEGATE_CDP_DENIED" }),
    } as Response);
    // An authenticated principal alone cannot sign: only the trusted MCP
    // forwarding scope plus private channel material grants that authority.
    const result = await runWithAuthenticatedDelegatePrincipal({
      sessionId: "aaaabbbb-cccc-4ddd-eeee-ffffffffffff",
      mode: "oauth", subject: "orchestrator-test",
    }, () => handleControlChromeCdp({
      command: "navigate", transport: "delegate", delegateClientId: "chrome-test001",
      delegateTabId: 5, url: "https://example.com/",
    }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/DELEGATE_FORWARD_/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates command, target and transport at Core boundary", () => {
    expect(validateDelegateBrowserHostArgs("superagent_chrome_cdp", {
      command: "list_targets", transport: "delegate",
    })).toBeNull();
    expect(validateDelegateBrowserHostArgs("superagent_chrome_cdp", {
      command: "list_targets", transport: "auto",
    })).toBeNull();
    expect(validateDelegateBrowserHostArgs("superagent_chrome_cdp", {
      command: "list_targets", transport: "managed",
    })).toBe("DELEGATE_CDP_TRANSPORT_REQUIRED");
    expect(validateDelegateBrowserHostArgs("superagent_chrome_cdp", {
      command: "not-real", transport: "delegate",
    })).toBe("DELEGATE_CDP_INVALID_COMMAND");
    expect(validateDelegateBrowserHostArgs("superagent_chrome_cdp", {
      command: "navigate", transport: "delegate", delegateTabId: -1,
    })).toBe("DELEGATE_CDP_INVALID_TAB");
    expect(validateDelegateBrowserHostArgs("superagent_chrome_cdp", {
      command: "list_targets", transport: "delegate", evil: true,
    })).toBe("DELEGATE_CDP_UNEXPECTED_ARGUMENT");
    expect(validateDelegateBrowserHostArgs("superagent_chrome_cdp", {
      command: "list_targets", payload: "{bad",
    })).toBe("DELEGATE_CDP_INVALID_PAYLOAD");
  });

  it("Core rejects unsigned host calls including reads before any browser action", async () => {
    const execution = vi.spyOn(controlChromeCdpTool, "execute").mockResolvedValue("Core sees browser tabs");
    const args = { command: "list_targets", transport: "delegate" };
    const unsigned = await hostCall("superagent_chrome_cdp", args);
    expect(unsigned).toEqual({ status: 403,
      payload: { success: false, error: "DELEGATE_MCP_ATTESTATION_DENIED" } });
    expect((await hostCall("superagent_chrome_cdp", args, { remote: "192.0.2.1" })).status).toBe(403);
    expect((await hostCall("superagent_chrome_cdp", args, { origin: "https://chatgpt.com" })).status).toBe(403);
    expect((await hostCall("superagent_chrome_cdp", { ...args, transport: "managed" })).status).toBe(403);
    expect((await hostCall("superagent_chrome_cdp", { ...args, command: "evil" })).status).toBe(403);
    expect(execution).not.toHaveBeenCalled();
  });
});
