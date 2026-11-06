import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DELEGATE_MCP_TOOL_NAMES,
  DELEGATE_MCP_TOOL_DEFS,
  dispatchDelegateMcpTool,
  validateDelegateMcpArgs,
  delegateMcpObservation,
} from "../src/core/mcp/tools/delegateMcpTools.js";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { setYoloMode } from "../src/core/permissions.js";
import { emitMcpActivity, onMcpActivity } from "../src/core/mcp/mcpActivityBus.js";

const invoke = async (
  server: ReturnType<typeof createSuperagentMcpServer>,
  name: string, args: Record<string, unknown> = {},
) => {
  const handler = (server as any)._requestHandlers.get("tools/call");
  return await handler({ method: "tools/call", params: { name, arguments: args } });
};
const listed = async (server: ReturnType<typeof createSuperagentMcpServer>): Promise<string[]> => {
  const handler = (server as any)._requestHandlers.get("tools/list");
  const result = await handler({ method: "tools/list", params: {} });
  return result.tools.map((entry: any) => entry.name);
};
afterEach(() => {
  vi.unstubAllGlobals();
  setYoloMode(false);
});

describe("Dedicated Delegate MCP tools: arguments, rights and single dispatch", () => {
  it("defines thirteen distinct direct MCP tools with no arbitrary target URI", () => {
    expect(DELEGATE_MCP_TOOL_DEFS.map(x => x.name)).toEqual([
      "superagent_delegate_read_chat",
      "superagent_delegate_list_chats",
      "superagent_delegate_read_chat_full",
      "superagent_delegate_search_history",
      "superagent_delegate_sync_history",
      "superagent_delegate_search_index",
      "superagent_delegate_doctor",
      "superagent_delegate_run_until_done",
      "superagent_delegate_inspect_chat_config",
      "superagent_delegate_configure_chat",
      "superagent_delegate_create_chat",
      "superagent_delegate_send_message",
      "superagent_delegate_stop_generation",
    ]);
    expect(DELEGATE_MCP_TOOL_DEFS.every(x => x.inputSchema.additionalProperties === false)).toBe(true);
    expect(DELEGATE_MCP_TOOL_DEFS.some(x => "url" in x.inputSchema.properties)).toBe(false);
  });

  it("strictly validates live chat and history arguments", () => {
    const read = DELEGATE_MCP_TOOL_NAMES.read;
    const send = DELEGATE_MCP_TOOL_NAMES.send;
    expect(validateDelegateMcpArgs(read, { connections: true })).toBeNull();
    expect(validateDelegateMcpArgs(read, { connections: true, tabId: 1 })).toBe("DELEGATE_CONNECTION_LIST_EXCLUSIVE");
    expect(validateDelegateMcpArgs(read, { clientId: "bad" })).toBe("DELEGATE_INVALID_CLIENT_ID");
    expect(validateDelegateMcpArgs(read, { url: "https://external.example/" })).toBe("DELEGATE_UNEXPECTED_ARGUMENT");
    expect(validateDelegateMcpArgs(read, { tabId: -5 })).toBe("DELEGATE_INVALID_TAB_ID");
    expect(validateDelegateMcpArgs(DELEGATE_MCP_TOOL_NAMES.list, { cursor: 0, limit: 50 })).toBeNull();
    expect(validateDelegateMcpArgs(DELEGATE_MCP_TOOL_NAMES.list, { limit: 201 })).toBe("DELEGATE_INVALID_LIMIT");
    expect(validateDelegateMcpArgs(DELEGATE_MCP_TOOL_NAMES.readFull, { chatId: "6aebe337-eaf0-83ec-8658-055863973410", limit: 40 })).toBeNull();
    expect(validateDelegateMcpArgs(DELEGATE_MCP_TOOL_NAMES.readFull, { chatId: "bad" })).toBe("DELEGATE_INVALID_CHAT_ID");
    expect(validateDelegateMcpArgs(DELEGATE_MCP_TOOL_NAMES.search, { query: "delegate", maxChats: 100 })).toBeNull();
    expect(validateDelegateMcpArgs(DELEGATE_MCP_TOOL_NAMES.search, { query: "" })).toBe("DELEGATE_INVALID_QUERY");
    expect(validateDelegateMcpArgs(send, {})).toBe("DELEGATE_INVALID_MESSAGE");
    expect(validateDelegateMcpArgs(send, {message:"hello"})).toBeNull();
    expect(validateDelegateMcpArgs(send, { message: "hello", model: "GPT-5.6", effort: "high" })).toBeNull();
    expect(validateDelegateMcpArgs(send, { message: "hello", effort: "ultra" })).toBe("DELEGATE_INVALID_EFFORT");
    expect(validateDelegateMcpArgs(DELEGATE_MCP_TOOL_NAMES.configure, { clientId: "profileAlpha123", tabId: 101, model: "GPT-5.6", effort: "high" })).toBeNull();
    expect(validateDelegateMcpArgs(DELEGATE_MCP_TOOL_NAMES.configure, { clientId: "profileAlpha123", tabId: 101 })).toBe("DELEGATE_CHAT_CONFIG_REQUIRED");
    expect(validateDelegateMcpArgs(send, { message: "hi", stop: true })).toBe("DELEGATE_UNEXPECTED_ARGUMENT");
    expect(validateDelegateMcpArgs(DELEGATE_MCP_TOOL_NAMES.create, { newTab: true })).toBeNull();
    expect(validateDelegateMcpArgs(DELEGATE_MCP_TOOL_NAMES.create, { newTab: "true" })).toBe("DELEGATE_INVALID_NEW_TAB");
    expect(validateDelegateMcpArgs(DELEGATE_MCP_TOOL_NAMES.create, { newTab: true, tabId: 101 })).toBe("DELEGATE_NEW_TAB_WITH_TAB_ID");
    expect(validateDelegateMcpArgs(read, { newTab: true })).toBe("DELEGATE_UNEXPECTED_ARGUMENT");
  });

  it("read-only OAuth exposes live/history/index diagnostics, never mutations, in gateway mode", async () => {
    const server = createSuperagentMcpServer({
      authMode: "oauth", toolExposure: "gateway",
      getIdentity: () => ({ mode: "oauth", subject: "reader", scopes: ["mcp:tools"] }),
    });
    try {
      const names = await listed(server);
      for (const name of [
        DELEGATE_MCP_TOOL_NAMES.read,
        DELEGATE_MCP_TOOL_NAMES.list,
        DELEGATE_MCP_TOOL_NAMES.readFull,
        DELEGATE_MCP_TOOL_NAMES.search,
        DELEGATE_MCP_TOOL_NAMES.searchIndex,
        DELEGATE_MCP_TOOL_NAMES.doctor,
      ]) expect(names).toContain(name);
      for (const name of [
        DELEGATE_MCP_TOOL_NAMES.sync,
        DELEGATE_MCP_TOOL_NAMES.runUntilDone,
        DELEGATE_MCP_TOOL_NAMES.create,
        DELEGATE_MCP_TOOL_NAMES.send,
        DELEGATE_MCP_TOOL_NAMES.stop,
      ]) expect(names).not.toContain(name);
      await expect(invoke(server, DELEGATE_MCP_TOOL_NAMES.runUntilDone, {
        message: "must-not-send",
      })).rejects.toThrow(/mcp:tools:write/);
    } finally {
      await server.close();
    }
  });

  it("OAuth write and local YOLO enable mutation discovery, revocation blocks cached calls", async () => {
    setYoloMode(true);
    let scopes = ["mcp:tools", "mcp:tools:write"];
    const server = createSuperagentMcpServer({
      authMode: "oauth", toolExposure: "gateway", allowDangerous: true,
      getIdentity: () => ({ mode: "oauth", subject: "writer", scopes }),
    });
    try {
      const names = await listed(server);
      for (const name of Object.values(DELEGATE_MCP_TOOL_NAMES)) expect(names).toContain(name);
      scopes = ["mcp:tools"];
      expect(await listed(server)).not.toContain(DELEGATE_MCP_TOOL_NAMES.send);
      await expect(invoke(server, DELEGATE_MCP_TOOL_NAMES.send, {
        message: "must-not-send",
      })).rejects.toThrow(/mcp:tools:write/);
    } finally {
      await server.close();
    }
  });

  it("fails closed before local host RPC without a trusted MCP forwarding principal", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true, json: async () => ({ success: true, result: '{"count":0}' }),
    }));
    vi.stubGlobal("fetch", fetcher);
    const output = await dispatchDelegateMcpTool(DELEGATE_MCP_TOOL_NAMES.read, { connections: true });
    expect(output?.isError).toBe(true);
    expect(output?.content[0].text).toContain("DELEGATE_FORWARD_PRINCIPAL_REQUIRED");
    expect(fetcher).not.toHaveBeenCalled();
    // Signed host dispatch, bearer, nonce and profile binding are covered by
    // delegateForwardedHostDispatch.test.ts and delegateForwardedPrincipal.test.ts.
  });

  it("redacts message and read-chat text from MCP activity, including gateway nesting", () => {
    const secretMessage = "do-not-leak-message-12345";
    const secretReply = "private-chat-response-xyz";
    const observed: unknown[] = [];
    const stop = onMcpActivity(event => observed.push(event));
    try {
      emitMcpActivity({
        type: "tool_call", tool: DELEGATE_MCP_TOOL_NAMES.send,
        args: { message: secretMessage, clientId: "some-profile-id" },
        output: secretReply, timestamp: Date.now(), ok: true,
      });
      emitMcpActivity({
        type: "tool_call", tool: "superagent_tool_execute",
        args: {
          name: DELEGATE_MCP_TOOL_NAMES.read,
          arguments: { clientId: "another-profile-id" },
        },
        output: secretReply, timestamp: Date.now(), ok: true,
      });
    } finally {
      stop();
    }
    const json = JSON.stringify(observed);
    expect(json).not.toContain(secretMessage);
    expect(json).not.toContain(secretReply);
    expect(json).not.toContain("another-profile-id");
    expect(json).toContain("contentRedacted");
    expect(delegateMcpObservation("superagent_get_workspace", {message: secretMessage})).toBeNull();
  });

  it("audits fail-closed MCP dispatch without logging the message body", async () => {
    setYoloMode(true);
    const privateMessage = "sensitive-outgoing-chat-text";
    const traces: unknown[] = [];
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({ success: true, result: JSON.stringify({ delivery: "sent" }) }),
    }));
    const server = createSuperagentMcpServer({
      authMode: "oauth", toolExposure: "gateway", allowDangerous: true,
      getIdentity: () => ({ mode: "oauth", subject: "author", scopes: ["mcp:tools", "mcp:tools:write"] }),
      onToolCall: entry => traces.push(entry),
    });
    try {
      const response = await invoke(server, DELEGATE_MCP_TOOL_NAMES.send, { message: privateMessage });
      expect(response.isError).toBe(true); // No private bridge key has been provisioned in this test.
      const audit = JSON.stringify(traces);
      expect(audit).toContain("contentRedacted");
      expect(audit).not.toContain(privateMessage);
    } finally {
      await server.close();
    }
  });

  it("invalid arguments or missing principal never send or retry a chat mutation", async () => {
    const fetcher = vi.fn(async () => { throw new Error("remote closed after click"); });
    vi.stubGlobal("fetch", fetcher);
    const bad = await dispatchDelegateMcpTool(DELEGATE_MCP_TOOL_NAMES.send, { message: "" });
    expect(bad?.isError).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(0);
    const uncertain = await dispatchDelegateMcpTool(DELEGATE_MCP_TOOL_NAMES.send, { message: "one send" });
    expect(uncertain?.isError).toBe(true);
    expect(uncertain?.content[0].text).toContain("DELEGATE_FORWARD_PRINCIPAL_REQUIRED");
    expect(fetcher).toHaveBeenCalledTimes(0);
  });
});
