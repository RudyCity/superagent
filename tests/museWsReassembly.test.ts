import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { MuseWsServerTransport } from "../src/core/remoteAgent/museWsTransport.js";
import {
  encodeEnvelope,
  type ChatEnvelope,
  type RemoteAgentEnvelope,
} from "../src/core/remoteAgent/protocol.js";

const TEST_PORT = 19331;
const TEST_TOKEN = "ws-reassembly-test-token";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs: number
): Promise<T | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await sleep(100);
  }
  return fn();
}

describe("museWsTransport - MUSEBUS reassembly over WebSocket", () => {
  let transport: MuseWsServerTransport;
  const received: RemoteAgentEnvelope[] = [];

  beforeAll(async () => {
    transport = new MuseWsServerTransport({
      wsHost: "127.0.0.1",
      wsPort: TEST_PORT,
      wsPath: "/muse",
      wsToken: TEST_TOKEN,
    } as any);
    await transport.start(async (env) => {
      received.push(env);
    });
  }, 20000);

  afterAll(async () => {
    await transport.stop();
  });

  async function connectAuthed(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/muse`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", (e) => reject(e));
    });
    const authOk = new Promise<void>((resolve) => {
      const onMsg = (data: WebSocket.RawData) => {
        try {
          const m = JSON.parse(data.toString());
          if (m && m.kind === "auth_ok") {
            ws.off("message", onMsg);
            resolve();
          }
        } catch {
          // ignore
        }
      };
      ws.on("message", onMsg);
    });
    ws.send(JSON.stringify({ v: 1, kind: "auth", token: TEST_TOKEN }));
    await authOk;
    return ws;
  }

  it("reassembles a multi-chunk MUSEBUS envelope", async () => {
    const ws = await connectAuthed();
    try {
      const env: ChatEnvelope = {
        v: 1,
        kind: "chat",
        id: "ws_chat_chunked",
        text: "Abc123".repeat(900), // no spaces: MUSEBUS strips edge whitespace (known wire-format limit)
        ts: Date.now(),
      };
      const chunks = encodeEnvelope(env, 1000);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      received.length = 0;
      for (const c of chunks) ws.send(c);
      const got = await waitFor(
        () => received.find((e) => e.id === "ws_chat_chunked"),
        8000
      );
      expect(got).toBeDefined();
      expect(got?.kind).toBe("chat");
      expect((got as ChatEnvelope).text).toBe(env.text);
    } finally {
      ws.close();
    }
  });

  it("still accepts plain JSON envelopes", async () => {
    const ws = await connectAuthed();
    try {
      received.length = 0;
      const env = {
        v: 1,
        kind: "chat",
        id: "ws_chat_plain",
        text: "plain-json-ok",
        ts: Date.now(),
      };
      ws.send(JSON.stringify(env));
      const got = await waitFor(
        () => received.find((e) => e.id === "ws_chat_plain"),
        8000
      );
      expect(got).toBeDefined();
      expect((got as ChatEnvelope).text).toBe("plain-json-ok");
    } finally {
      ws.close();
    }
  });

  it("incomplete chunk emits nothing and does not crash", async () => {
    const ws = await connectAuthed();
    try {
      const env: ChatEnvelope = {
        v: 1,
        kind: "chat",
        id: "ws_chat_partial",
        text: "Xyz789".repeat(900), // no spaces: MUSEBUS strips edge whitespace (known wire-format limit)
        ts: Date.now(),
      };
      const chunks = encodeEnvelope(env, 1000);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      received.length = 0;
      ws.send(chunks[0]); // first chunk only
      await sleep(900);
      expect(
        received.find((e) => e.id === "ws_chat_partial")
      ).toBeUndefined();
      // send the rest - envelope must now complete
      for (const c of chunks.slice(1)) ws.send(c);
      const got = await waitFor(
        () => received.find((e) => e.id === "ws_chat_partial"),
        8000
      );
      expect(got).toBeDefined();
      expect((got as ChatEnvelope).text).toBe(env.text);
    } finally {
      ws.close();
    }
  });
});
