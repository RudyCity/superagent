import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import WebSocket from "ws";
import { DelegateBridge } from "../src/core/delegate/bridge.js";
import {
  delegateReadChatTool, delegateListChatsTool, delegateReadChatFullTool,
  delegateSearchHistoryTool, delegateCreateChatTool,
} from "../src/core/tools/delegateTools.js";
import { getToolByName, getToolDefinitions } from "../src/core/tools/index.js";
import {
  delegateToolset, masterToolset, superagentToolset, chromeExtensionToolset,
  ORCHESTRATION_TOOL_NAMES, EXTENSION_CHAT_HIDDEN_TOOL_NAMES,
  filterExtensionChatTools, withModeAwareDiscoveryTools,
} from "../src/core/tools/toolsets.js";

const names = [
  "delegate.create_chat",
  "delegate.read_chat",
  "delegate.list_chats",
  "delegate.read_chat_full",
  "delegate.search_history",
  "delegate.sync_history",
  "delegate.search_index",
  "delegate.doctor",
  "delegate.run_until_done",
  "delegate.send_message",
  "delegate.stop_generation",
];

async function freePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw Error("No port");
  return new Promise((resolve) => listener.close(() => resolve(address.port)));
}

async function connectedBridge(): Promise<{ bridge: DelegateBridge; ws: WebSocket }> {
  const bridge = new DelegateBridge(await freePort());
  await bridge.start();
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, {
    origin: "chrome-extension://" + "a".repeat(32),
    headers: { Origin: "chrome-extension://" + "a".repeat(32) },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "hello", protocol: "superagent-delegate-v1" }));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("HELLO timeout")), 2000);
    ws.on("message", function handshake(raw) {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "hello_ack") {
        clearTimeout(timer);
        ws.off("message", handshake);
        resolve();
      }
    });
  });
  return { bridge, ws };
}

const opened: Array<{ bridge: DelegateBridge; ws: WebSocket }> = [];
afterEach(async () => {
  for (const { bridge, ws } of opened.splice(0)) {
    ws.terminate();
    await bridge.close();
  }
});

describe("delegate registration and visibility", () => {
  it("exports seven conforming Delegate tools, including read-only history tools, without modifying Master", () => {
    expect(delegateToolset.map((x) => x.name)).toEqual(names);
    for (const t of delegateToolset) {
      expect(t.parameters.type).toBe("object");
      expect(typeof t.execute).toBe("function");
      expect(ORCHESTRATION_TOOL_NAMES.has(t.name)).toBe(false);
      expect(masterToolset.some((master) => master.name === t.name)).toBe(false);
      expect(EXTENSION_CHAT_HIDDEN_TOOL_NAMES.has(t.name)).toBe(false);
    }
  });

  it("registers all Delegate tools in the global lookup catalog", () => {
    const catalog = getToolDefinitions();
    for (const name of names) {
      expect(getToolByName(name)?.name).toBe(name);
      expect(catalog.some((tool) => tool.name === name)).toBe(true);
    }
  });

  it("exposes all delegate tools via mode-aware discovery in single-agent T-Line and Chrome chat", async () => {
    for (const chrome of [false, true]) {
      const base = chrome ? chromeExtensionToolset : filterExtensionChatTools(superagentToolset);
      const visible = withModeAwareDiscoveryTools([...base, ...delegateToolset], chrome);
      const discover = visible.find((t) => t.name === "list_tools");
      const describe = visible.find((t) => t.name === "describe_tool");
      expect(discover).toBeDefined();
      expect(describe).toBeDefined();
      const listing = await discover!.execute({ query: "delegate" }, process.cwd());
      for (const name of names) expect(listing).toContain(name);
      const details = JSON.parse(await describe!.execute({ names }, process.cwd()));
      expect(details.map((x: { name: string }) => x.name)).toEqual(names);
    }
  });

  it("does not unhide the 12 existing extension-only tools in T-Line mode", () => {
    const filtered = filterExtensionChatTools([...chromeExtensionToolset, ...delegateToolset]);
    expect([...EXTENSION_CHAT_HIDDEN_TOOL_NAMES]).toHaveLength(12);
    for (const name of EXTENSION_CHAT_HIDDEN_TOOL_NAMES) {
      expect(filtered.some((t) => t.name === name)).toBe(false);
    }
    for (const name of names) expect(filtered.some((t) => t.name === name)).toBe(true);
  });
});

  it("supports safe connection discovery and strict history schemas", async () => {
    const list = JSON.parse(await delegateReadChatTool.execute({ connections: true }, process.cwd()));
    expect(list.count).toBe(0);
    expect(list.connections).toEqual([]);
    const readParams = delegateReadChatTool.parameters as { properties: Record<string, unknown> };
    const createParams = delegateCreateChatTool.parameters as { properties: Record<string, unknown> };
    const listParams = delegateListChatsTool.parameters as { properties: Record<string, unknown> };
    const fullParams = delegateReadChatFullTool.parameters as { properties: Record<string, unknown>; required?: string[] };
    const searchParams = delegateSearchHistoryTool.parameters as { properties: Record<string, unknown>; required?: string[] };
    expect(readParams.properties.connections).toBeTruthy();
    expect(readParams.properties.clientId).toBeTruthy();
    expect(createParams.properties.clientId).toBeTruthy();
    expect(createParams.properties.tabId).toBeTruthy();
    expect(listParams.properties.cursor).toBeTruthy();
    expect(fullParams.required).toContain("chatId");
    expect(searchParams.required).toContain("query");
  });

describe("delegate bridge", () => {
  it("forwards a request exactly once and returns the reply", async () => {
    const entry = await connectedBridge();
    opened.push(entry);
    let transmissions = 0;
    entry.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "request") {
        transmissions++;
        entry.ws.send(JSON.stringify({
          type: "response", id: msg.id, ok: true, result: { status: "finished" },
        }));
      }
    });
    const result = JSON.parse(await entry.bridge.request("delegate.read_chat", {}, undefined, 2000));
    expect(result.status).toBe("finished");
    expect(transmissions).toBe(1);
  });

  it("does not retry a timed-out request", async () => {
    const entry = await connectedBridge();
    opened.push(entry);
    let transmissions = 0;
    entry.ws.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "request") transmissions++;
    });
    await expect(entry.bridge.request("delegate.send_message", { message: "hello" }, undefined, 80))
      .rejects.toThrow("DELEGATE_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(transmissions).toBe(1);
  });

  it("fails fast when the extension is missing", async () => {
    const bridge = new DelegateBridge(await freePort());
    await expect(bridge.request("delegate.read_chat", {}, undefined, 1000))
      .rejects.toThrow("DELEGATE_EXTENSION_NOT_CONNECTED");
    await bridge.close();
  });

  it("aborts only the RPC, without issuing stop_generation", async () => {
    const entry = await connectedBridge();
    opened.push(entry);
    const calls: string[] = [];
    entry.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "request") calls.push(msg.method);
    });
    const controller = new AbortController();
    const pending = entry.bridge.request("delegate.send_message", { message: "hello" }, controller.signal, 2000);
    await new Promise((resolve) => setTimeout(resolve, 40));
    controller.abort();
    await expect(pending).rejects.toThrow("DELEGATE_ABORTED");
    expect(calls).toEqual(["delegate.send_message"]);
  });

  it("rejects connections without an extension origin", async () => {
    const bridge = new DelegateBridge(await freePort());
    await bridge.start();
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`);
    await expect(new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, response) => reject(new Error(String(response.statusCode))));
    })).rejects.toThrow();
    ws.terminate();
    await bridge.close();
  });
});
