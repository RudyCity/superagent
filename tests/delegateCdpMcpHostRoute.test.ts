import { afterEach, describe, expect, it, vi } from "vitest";
import { handleControlChromeCdp, handleControlChromeVision, validateDelegateBrowserHostArgs } from "../src/core/mcp/tools/chromeMcpTools.js";
import { controlChromeCdpTool } from "../src/core/tools/chromeCdpTools.js";
import { delegateBridge } from "../src/core/delegate/bridge.js";
import { handleServerRoute } from "../src/serverRoutes.js";

// Keep all security helpers except the local bearer lookup for this fake MCP client.
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
    headers: { host: options.host || "127.0.0.1:7888", ...(options.origin ? { origin: options.origin } : {}) },
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
  it("forwards Delegate-CDP discovery once instead of binding a second listener", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true, json: async () => ({ success: true, result: "- id: delegate:chrome-test001:5" }),
    } as Response);
    const start = vi.spyOn(delegateBridge, "start");
    const result = await handleControlChromeCdp({
      command: "list_targets", transport: "delegate", delegateClientId: "chrome-test001",
    });
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain("delegate:chrome-test001:5");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://127.0.0.1:7888/api/delegate/mcp-dispatch");
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "superagent_chrome_cdp",
      arguments: { command: "list_targets", transport: "delegate", delegateClientId: "chrome-test001" },
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("forwards auto discovery, qualified Delegate targets and vision; leaves managed CDP local", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true, json: async () => ({ success: true, result: "owner response" }),
    } as Response);
    expect((await handleControlChromeCdp({ command: "list_targets", transport: "auto" })).content[0].text)
      .toBe("owner response");
    expect((await handleControlChromeCdp({
      command: "snapshot", targetId: "delegate:chrome-test001:5",
    })).content[0].text).toBe("owner response");
    expect((await handleControlChromeVision({
      command: "status", payload: JSON.stringify({ transport: "delegate", delegateClientId: "chrome-test001" }),
    })).content[0].text).toBe("owner response");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body)).name).toBe("superagent_chrome_vision");
    const local = vi.spyOn(controlChromeCdpTool, "execute").mockResolvedValue("local managed result");
    const managed = await handleControlChromeCdp({ command: "list_targets", transport: "managed" });
    expect(managed.content[0].text).toBe("local managed result");
    expect(local).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry an uncertain rejected host operation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false, json: async () => ({ success: false, error: "DELEGATE_CDP_DENIED" }),
    } as Response);
    const result = await handleControlChromeCdp({
      command: "navigate", transport: "delegate", delegateClientId: "chrome-test001",
      delegateTabId: 5, url: "https://example.com/",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("DENIED");
    expect(fetchMock).toHaveBeenCalledOnce();
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

  it("Core dispatches exactly once through the owner-side tool and blocks non-local callers", async () => {
    const execution = vi.spyOn(controlChromeCdpTool, "execute").mockResolvedValue("Core sees browser tabs");
    const args = { command: "list_targets", transport: "delegate" };
    const success = await hostCall("superagent_chrome_cdp", args);
    expect(success).toEqual({ status: 200, payload: { success: true, result: "Core sees browser tabs" } });
    expect(execution).toHaveBeenCalledOnce();
    expect((await hostCall("superagent_chrome_cdp", args, { remote: "192.0.2.1" })).status).toBe(403);
    expect((await hostCall("superagent_chrome_cdp", args, { origin: "https://chatgpt.com" })).status).toBe(403);
    expect((await hostCall("superagent_chrome_cdp", { ...args, transport: "managed" })).status).toBe(400);
    expect((await hostCall("superagent_chrome_cdp", { ...args, command: "evil" })).status).toBe(400);
    expect(execution).toHaveBeenCalledOnce();
  });
});
