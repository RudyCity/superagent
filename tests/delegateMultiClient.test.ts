import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import WebSocket from "ws";
import { DelegateBridge } from "../src/core/delegate/bridge.js";

const originA = "chrome-extension://" + "a".repeat(32);
const originB = "chrome-extension://" + "b".repeat(32);

async function freePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const addr = listener.address();
  if (!addr || typeof addr === "string") throw new Error("No local port");
  return new Promise<number>(resolve => listener.close(() => resolve(addr.port)));
}

const active: Array<{ bridge: DelegateBridge; clients: WebSocket[] }> = [];
async function testBridge(token?: string) {
  const bridge = new DelegateBridge(await freePort(), token);
  await bridge.start();
  const entry = { bridge, clients: [] as WebSocket[] };
  active.push(entry);
  return entry;
}

async function connect(
  entry: { bridge: DelegateBridge; clients: WebSocket[] },
  clientId: string,
  label: string,
  origin = originA,
  authToken?: string,
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${entry.bridge.port}`, {
    headers: { Origin: origin },
  });
  entry.clients.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  const acknowledged = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("HELLO timed out")), 2000);
    const listener = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "hello_ack") {
        clearTimeout(timer);
        ws.off("message", listener);
        resolve();
      }
    };
    ws.on("message", listener);
  });
  ws.send(JSON.stringify({
    type: "hello", protocol: "superagent-delegate-v1", clientId, label,
    ...(authToken ? { authToken } : {}),
  }));
  await acknowledged;
  return ws;
}

afterEach(async () => {
  for (const entry of active.splice(0)) {
    for (const ws of entry.clients) ws.terminate();
    await entry.bridge.close();
  }
});

describe("multiple independent Chrome Delegate connections", () => {
  it("accepts two Chrome profiles and lists their separate stable identities", async () => {
    const entry = await testBridge();
    await connect(entry, "chrome-work-001", "Chrome Kerja", originA);
    await connect(entry, "chrome-personal-001", "Chrome Personal", originB);
    const clients = entry.bridge.listConnections();
    expect(clients).toHaveLength(2);
    expect(clients.map(c => c.clientId)).toEqual([
      "chrome-work-001", "chrome-personal-001",
    ]);
    expect(clients.map(c => c.label)).toEqual(["Chrome Kerja", "Chrome Personal"]);
    expect(clients.map(c => c.extensionId)).toEqual(["a".repeat(32), "b".repeat(32)]);
  });

  it("refuses ambiguous create_chat and sends nothing to either profile", async () => {
    const entry = await testBridge();
    const first = await connect(entry, "chrome-work-001", "Kerja", originA);
    const second = await connect(entry, "chrome-personal-001", "Personal", originB);
    let dispatched = 0;
    for (const ws of [first, second]) {
      ws.on("message", raw => {
        if (JSON.parse(raw.toString()).type === "request") dispatched++;
      });
    }
    await expect(
      entry.bridge.request("delegate.create_chat", {}, undefined, 600),
    ).rejects.toThrow("DELEGATE_MULTIPLE_CLIENTS");
    expect(dispatched).toBe(0);
  });

  it("routes exactly one send_message to the selected clientId only", async () => {
    const entry = await testBridge();
    const work = await connect(entry, "chrome-work-001", "Kerja", originA);
    const personal = await connect(entry, "chrome-personal-001", "Personal", originB);
    let dispatchedWork = 0;
    let dispatchedPersonal = 0;
    work.on("message", raw => {
      if (JSON.parse(raw.toString()).type === "request") dispatchedWork++;
    });
    personal.on("message", raw => {
      const request = JSON.parse(raw.toString());
      if (request.type !== "request") return;
      dispatchedPersonal++;
      personal.send(JSON.stringify({
        type: "response", id: request.id, ok: true,
        result: { delivery: "sent", selected: "chrome-personal-001" },
      }));
    });
    const output = JSON.parse(await entry.bridge.request(
      "delegate.send_message", { message: "single test message" },
      undefined, 2500, "chrome-personal-001",
    ));
    expect(output.selected).toBe("chrome-personal-001");
    expect(dispatchedWork).toBe(0);
    expect(dispatchedPersonal).toBe(1);
  });

  it("rejects offline targeted clients without failing over to another profile", async () => {
    const entry = await testBridge();
    await connect(entry, "chrome-work-001", "Kerja");
    await expect(entry.bridge.request(
      "delegate.stop_generation", {}, undefined, 100, "chrome-personal-001",
    )).rejects.toThrow("DELEGATE_TARGET_NOT_CONNECTED");
  });

  it("can keep one profile connected while the other disconnects", async () => {
    const entry = await testBridge();
    const work = await connect(entry, "chrome-work-001", "Kerja", originA);
    const personal = await connect(entry, "chrome-personal-001", "Personal", originB);
    work.close();
    await new Promise<void>(resolve => work.once("close", () => resolve()));
    // Client close can reach the browser before server has processed its close event.
    for (let attempt = 0; attempt < 30 && entry.bridge.listConnections().length !== 1; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(entry.bridge.listConnections().map(c => c.clientId)).toEqual(["chrome-personal-001"]);
    personal.on("message", raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === "request") {
        personal.send(JSON.stringify({ type: "response", id: m.id, ok: true, result: { ok: true } }));
      }
    });
    const result = JSON.parse(await entry.bridge.request("delegate.read_chat", {}, undefined, 2000));
    expect(result.ok).toBe(true);
  });

  it("does not allow a response from a different Chrome socket to resolve another request", async () => {
    const entry = await testBridge();
    const work = await connect(entry, "chrome-work-001", "Kerja", originA);
    const personal = await connect(entry, "chrome-personal-001", "Personal", originB);
    work.on("message", raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "request") return;
      personal.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: { compromised: true } }));
      setTimeout(() => work.send(JSON.stringify({ type: "response", id: msg.id, ok: true, result: { correct: true } })), 30);
    });
    const output = JSON.parse(await entry.bridge.request(
      "delegate.read_chat", {}, undefined, 1000, "chrome-work-001",
    ));
    expect(output.correct).toBe(true);
    expect(output.compromised).toBeUndefined();
  });

  it("does not let a different extension origin hijack an existing clientId", async () => {
    const entry = await testBridge();
    await connect(entry, "chrome-work-001", "Kerja", originA);
    const attacker = new WebSocket(`ws://127.0.0.1:${entry.bridge.port}`, {
      headers: { Origin: originB },
    });
    entry.clients.push(attacker);
    await new Promise<void>((resolve, reject) => {
      attacker.once("open", resolve);
      attacker.once("error", reject);
    });
    const refused = new Promise<number>(resolve => {
      attacker.once("close", code => resolve(code));
    });
    attacker.send(JSON.stringify({
      type: "hello", protocol: "superagent-delegate-v1",
      clientId: "chrome-work-001", label: "Spoofed",
    }));
    expect(await refused).toBe(1008);
    expect(entry.bridge.listConnections().map(c => c.clientId)).toEqual(["chrome-work-001"]);
    expect(entry.bridge.listConnections()[0].label).toBe("Kerja");
  });

  it("rejects unauthenticated connections when a pairing token is configured", async () => {
    const token = "0123456789abcdef".repeat(4);
    const entry = await testBridge(token);
    const ws = new WebSocket(`ws://127.0.0.1:${entry.bridge.port}`, {
      headers: { Origin: originA },
    });
    entry.clients.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve); ws.once("error", reject);
    });
    const closed = new Promise<number>(resolve => ws.once("close", code => resolve(code)));
    ws.send(JSON.stringify({
      type: "hello", protocol: "superagent-delegate-v1",
      clientId: "chrome-work-001", label: "Impersonator",
      authToken: "wrong-token",
    }));
    expect(await closed).toBe(1008);
    expect(entry.bridge.listConnections()).toHaveLength(0);
    const good = await connect(entry, "chrome-work-001", "Paired", originA, token);
    expect(good.readyState).toBe(WebSocket.OPEN);
    expect(entry.bridge.listConnections()).toHaveLength(1);
  });

  it("rejects short secrets before opening its server socket", async () => {
    const bridge = new DelegateBridge(await freePort(), "short-token");
    await expect(bridge.start()).rejects.toThrow("DELEGATE_AUTH_CONFIGURATION_INVALID");
  });

  it("does not permit hijacking an active profile even from the same extension origin", async () => {
    const entry = await testBridge();
    const existing = await connect(entry, "chrome-work-001", "Original", originA);
    const another = new WebSocket(`ws://127.0.0.1:${entry.bridge.port}`, {
      headers: { Origin: originA },
    });
    entry.clients.push(another);
    await new Promise<void>((resolve, reject) => {
      another.once("open", resolve); another.once("error", reject);
    });
    const closed = new Promise<number>(resolve => another.once("close", code => resolve(code)));
    another.send(JSON.stringify({
      type: "hello", protocol: "superagent-delegate-v1",
      clientId: "chrome-work-001", label: "Takeover",
    }));
    expect(await closed).toBe(1008);
    expect(existing.readyState).toBe(WebSocket.OPEN);
    expect(entry.bridge.listConnections().map(c => c.label)).toEqual(["Original"]);
  });
});
