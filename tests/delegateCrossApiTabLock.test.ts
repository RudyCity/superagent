import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DelegateBridge, delegateBridge, type DelegateMethod } from "../src/core/delegate/bridge.js";
import {
  delegateCreateChatTool, delegateReadChatTool, delegateRunUntilDoneTool,
  delegateSendMessageTool, delegateStopGenerationTool,
} from "../src/core/tools/delegateTools.js";
import { DelegateMultiTabOrchestrator, type MultiTabBridge } from "../src/core/delegate/multiTabOrchestrator.js";
import {
  claimDelegateTarget, releaseDelegateTarget, withDelegateTargetLock,
} from "../src/core/browserTransport/sessionCoordinator.js";
import { validateDelegateMcpArgs, DELEGATE_MCP_TOOL_NAMES } from "../src/core/mcp/tools/delegateMcpTools.js";

const clientId = "profile-test-0001";
const anotherClient = "profile-test-0002";
const connection = (id: string) => ({
  clientId: id, label: "Mock Chrome", extensionId: "mock", extensionVersion: "1.8.0",
  capabilities: ["delegate-cdp-v1"], connectedAt: Date.now(),
});
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check: () => boolean) {
  for (let n = 0; n < 100 && !check(); n++) await new Promise(r => setTimeout(r, 10));
  expect(check()).toBe(true);
}
afterEach(() => vi.restoreAllMocks());

describe("Semantic Delegate / CDP cross-API safety", () => {
  it("requires explicit profile and tab for dangerous semantic writes", async () => {
    const rpc = vi.spyOn(delegateBridge, "request").mockResolvedValue('{"status":"sent"}');
    vi.spyOn(delegateBridge, "listConnections").mockReturnValue([connection(clientId)]);
    expect(await delegateSendMessageTool.execute({ message: "private" }, "")).toContain("DELEGATE_EXPLICIT_CLIENT_REQUIRED");
    expect(await delegateSendMessageTool.execute({ clientId, message: "private" }, "")).toContain("DELEGATE_EXPLICIT_TAB_REQUIRED");
    expect(await delegateStopGenerationTool.execute({ clientId }, "")).toContain("DELEGATE_EXPLICIT_TAB_REQUIRED");
    expect(await delegateCreateChatTool.execute({ clientId }, "")).toContain("DELEGATE_EXPLICIT_TAB_REQUIRED");
    expect(await delegateRunUntilDoneTool.execute({ clientId, message: "private" }, "")).toContain("DELEGATE_EXPLICIT_TAB_REQUIRED");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects claimed CDP tab, permits a separate unclaimed tab and read-only access", async () => {
    vi.spyOn(delegateBridge, "listConnections").mockReturnValue([connection(clientId), connection(anotherClient)]);
    const rpc = vi.spyOn(delegateBridge, "request").mockImplementation(async method =>
      JSON.stringify({ status: method === "delegate.send_message" ? "sent" : "waiting_for_input" }));
    const session = claimDelegateTarget(clientId, 101, "worker-test-owner");
    try {
      expect(await delegateSendMessageTool.execute({ clientId, tabId: 101, message: "blocked" }, "")).toContain("DELEGATE_CDP_TARGET_CLAIMED");
      expect(await delegateStopGenerationTool.execute({ clientId, tabId: 101 }, "")).toContain("DELEGATE_CDP_TARGET_CLAIMED");
      expect(await delegateReadChatTool.execute({ clientId, tabId: 101 }, "")).toContain("waiting_for_input");
      expect(await delegateSendMessageTool.execute({ clientId, tabId: 202, message: "okay" }, "")).toContain("sent");
      expect(rpc.mock.calls.filter(([method]) => method === "delegate.send_message")).toHaveLength(1);
      expect(rpc.mock.calls.find(([method]) => method === "delegate.send_message")?.[1]).toMatchObject({ tabId: 202 });
    } finally {
      releaseDelegateTarget(clientId, 101, "worker-test-owner", session.sessionToken);
    }
  });

  it("serializes a direct semantic send behind a CDP lock on the same tab", async () => {
    vi.spyOn(delegateBridge, "listConnections").mockReturnValue([connection(clientId)]);
    const rpc = vi.spyOn(delegateBridge, "request").mockResolvedValue('{"status":"sent"}');
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    let inside = false;
    const occupied = withDelegateTargetLock(clientId, 303, async () => {
      inside = true;
      await hold;
    });
    await until(() => inside);
    const send = delegateSendMessageTool.execute({ clientId, tabId: 303, message: "only once" }, "");
    await tick();
    expect(rpc).not.toHaveBeenCalled();
    release();
    await occupied;
    expect(await send).toContain("sent");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("does not deadlock the existing multi-tab orchestrator lock", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-cross-api-"));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls: DelegateMethod[] = [];
    const fake: MultiTabBridge = {
      listConnections: () => [{ clientId }],
      async request(method, params) {
        calls.push(method);
        if (method === "delegate.peek_chat") {
          return JSON.stringify({ ready: true, status: "finished", url: "https://chatgpt.com/c/test-chat-12345678",
            latest_response_text: calls.includes("delegate.send_message") ? "[[SA_DELEGATE_" + (params.tabId ? "invalid" : "") + "_DONE]]" : "" });
        }
        return JSON.stringify({ status: "sent" });
      },
    };
    const scheduler = new DelegateMultiTabOrchestrator(fake, path.join(dir, "ledger.json"), { pollMs: 100 });
    let inside = false;
    const occupied = withDelegateTargetLock(clientId, 404, async () => { inside = true; await gate; });
    try {
      await until(() => inside);
      scheduler.enqueue({ requestId: "request-crosslock-01", clientId, tabId: 404,
        workerId: "worker-a", message: "isolated prompt", maxRuntimeMs: 30000 });
      await tick();
      expect(calls).not.toContain("delegate.send_message");
      release();
      await occupied;
      await until(() => calls.includes("delegate.send_message"));
      expect(calls.filter(method => method === "delegate.send_message")).toHaveLength(1);
    } finally {
      release();
      await occupied;
      await until(() => scheduler.snapshot().activeCount === 0).catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("durable request receipt prevents replay across new bridge instances", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-receipt-"));
    const file = path.join(dir, "receipts.json");
    const first = new DelegateBridge(19990, "test", () => {}, () => {}, undefined, file);
    const second = new DelegateBridge(19991, "test", () => {}, () => {}, undefined, file);
    const send = vi.fn(async () => "sent");
    try {
      expect(await first.executeOnce("request-durable-001", "delegate.send_message",
        clientId, { tabId: 9, message: "secret-prompt" }, send)).toBe("sent");
      await expect(second.executeOnce("request-durable-001", "delegate.send_message",
        clientId, { tabId: 9, message: "secret-prompt" }, send)).rejects.toThrow("DELEGATE_REQUEST_ALREADY_CONFIRMED");
      await expect(second.executeOnce("request-durable-001", "delegate.send_message",
        clientId, { tabId: 9, message: "different" }, send)).rejects.toThrow("DELEGATE_REQUEST_ID_REUSE_CONFLICT");
      expect(send).toHaveBeenCalledTimes(1);
      const contents = fs.readFileSync(file, "utf8");
      expect(contents).not.toContain("secret-prompt");
      expect(contents).not.toContain("request-durable-001");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("parallel calls with one idempotency key dispatch only once while the first is pending", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-parallel-key-"));
    const instance = new DelegateBridge(19995, "test", () => {}, () => {},
      undefined, path.join(dir, "receipts.json"));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const operation = vi.fn(async () => { await gate; return "ok"; });
    try {
      const first = instance.executeOnce("parallel-request-01", "delegate.send_message",
        clientId, { tabId: 22, message: "one" }, operation);
      await until(() => operation.mock.calls.length === 1);
      await expect(instance.executeOnce("parallel-request-01", "delegate.send_message",
        clientId, { tabId: 22, message: "one" }, operation)).rejects.toThrow("DELEGATE_REQUEST_ALREADY_PENDING");
      release();
      expect(await first).toBe("ok");
      expect(operation).toHaveBeenCalledTimes(1);
    } finally {
      release();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ambiguous RPC error leaves an uncertain receipt; read-only verification cannot resend", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-uncertain-"));
    const file = path.join(dir, "receipts.json");
    const first = new DelegateBridge(19992, "test", () => {}, () => {}, undefined, file);
    const afterRestart = new DelegateBridge(19993, "test", () => {}, () => {}, undefined, file);
    const attempt = vi.fn(async () => { throw new Error("DELEGATE_TIMEOUT"); });
    try {
      await expect(first.executeOnce("request-timeout-01", "delegate.send_message",
        clientId, { tabId: 10, message: "once" }, attempt)).rejects.toThrow("DELEGATE_TIMEOUT");
      await expect(afterRestart.executeOnce("request-timeout-01", "delegate.send_message",
        clientId, { tabId: 10, message: "once" }, attempt)).rejects.toThrow("DELEGATE_REQUEST_ALREADY_UNCERTAIN");
      expect(attempt).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).receipts[0].status).toBe("uncertain");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("core bridge guards claimed reads and all direct mutation RPCs without a second lock", async () => {
    const instance = new DelegateBridge(19994, "test", () => {}, () => {});
    const sent: Array<Record<string, unknown>> = [];
    const socket = {
      send(payload: string, callback: (error?: Error) => void) {
        const parsed = JSON.parse(payload);
        sent.push(parsed);
        const pending = (instance as any).pending.get(parsed.id);
        (instance as any).pending.delete(parsed.id);
        clearTimeout(pending.timer);
        pending.detachAbort();
        pending.resolve('{"status":"safe_read"}');
        callback();
      },
    };
    (instance as any).connected = async () => ({ clientId, socket });
    const claim = claimDelegateTarget(clientId, 606, "core-guard-owner");
    try {
      await expect(instance.request("delegate.send_message", { tabId: 606, message: "blocked" },
        undefined, 1000, clientId)).rejects.toThrow("DELEGATE_CDP_TARGET_CLAIMED");
      await expect(instance.request("delegate.send_message", { message: "implicit" },
        undefined, 1000, clientId)).rejects.toThrow("DELEGATE_EXPLICIT_TAB_REQUIRED");
      await expect(instance.request("delegate.create_chat", { newTab: true },
        undefined, 1000)).rejects.toThrow("DELEGATE_EXPLICIT_CLIENT_REQUIRED");
      await expect(instance.request("delegate.read_chat", {},
        undefined, 1000, clientId)).rejects.toThrow("DELEGATE_EXPLICIT_TAB_REQUIRED");
      expect(await instance.request("delegate.read_chat", { tabId: 606 },
        undefined, 1000, clientId)).toContain("safe_read");
      expect(sent.map(row => row.method)).toEqual(["delegate.peek_chat"]);
    } finally {
      releaseDelegateTarget(clientId, 606, "core-guard-owner", claim.sessionToken);
    }
  });

  it("MCP accepts valid idempotency keys and rejects malformed ones", () => {
    expect(validateDelegateMcpArgs(DELEGATE_MCP_TOOL_NAMES.send,
      { clientId, tabId: 12, message: "okay", requestId: "request-test-003" })).toBeNull();
    expect(validateDelegateMcpArgs(DELEGATE_MCP_TOOL_NAMES.send,
      { clientId, tabId: 12, message: "okay", requestId: "bad" })).toBe("DELEGATE_INVALID_REQUEST_ID");
  });
});
