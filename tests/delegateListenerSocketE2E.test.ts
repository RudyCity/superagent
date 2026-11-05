/** Real loopback WebSocket smoke test: pairing, authenticated reconnect and
 * manual STOP persistence. No Chrome tabs, external network or fake RPC sends.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { DelegateBridge } from "../src/core/delegate/bridge.js";
import { readDelegateListenerPreference, writeDelegateListenerPreference
} from "../src/core/delegate/delegateListenerPreference.js";
import { applyDelegateListenerAction } from "../src/core/delegate/delegateListenerLifecycle.js";

const oldConfig = process.env.SUPERAGENT_CONFIG_DIR;
let root: string | undefined;
afterEach(() => {
  if (oldConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = oldConfig;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("real Delegate loopback end-to-end", () => {
  it("pairs a Chrome origin, stops persistently, then accepts the saved proof after restart", async () => {
    root = mkdtempSync(join(tmpdir(), "sa-delegate-ws-"));
    process.env.SUPERAGENT_CONFIG_DIR = root;
    const secret = "c".repeat(48);
    const proofs = join(root, "delegate", "paired-profiles-v1.json");
    const makeBridge = () => new DelegateBridge(0, secret, () => {}, () => {}, proofs);
    const first = makeBridge();
    let socket: WebSocket | undefined;
    let second: DelegateBridge | undefined;
    try {
      await first.start();
      const pair = first.getPairingCode();
      expect(pair?.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      const open = async (bridge: DelegateBridge, identity: Record<string, unknown>) => {
        const listener = (bridge as any).server.address();
        const origin = "chrome-extension://" + "a".repeat(32);
        const ws = new WebSocket("ws://127.0.0.1:" + listener.port, [], {
          origin, headers: { Origin: origin },
        });
        await once(ws, "open");
        const reply = once(ws, "message");
        ws.send(JSON.stringify({
          type: "hello", protocol: "superagent-delegate-v1",
          clientId: "test-chrome-profile-123",
          label: "Isolated E2E Chrome",
          ...identity,
        }));
        const [raw] = await reply;
        return { ws, ack: JSON.parse(raw.toString()) };
      };
      const joined = await open(first, { pairingCode: pair!.code });
      socket = joined.ws;
      expect(joined.ack.type).toBe("hello_ack");
      expect(joined.ack.authToken).toHaveLength(64);
      const issued = joined.ack.authToken as string;
      expect(first.listConnections()).toHaveLength(1);
      await applyDelegateListenerAction(first, "stop");
      expect(first.isRunning()).toBe(false);
      expect(first.getPairingCode()).toBeNull();
      expect(() => first.renewPairingCode()).toThrow("DELEGATE_LISTENER_NOT_RUNNING");
      expect(readDelegateListenerPreference()).toBe(false);
      socket = undefined; // closed by the bridge
      second = makeBridge();
      if (readDelegateListenerPreference()) await second.start();
      expect(second.isRunning()).toBe(false); // startup respects explicit OFF
      await applyDelegateListenerAction(second, "start");
      expect(readDelegateListenerPreference()).toBe(true);
      const resumed = await open(second, { authToken: issued });
      socket = resumed.ws;
      expect(resumed.ack.type).toBe("hello_ack");
      expect(resumed.ack.authToken).toBeUndefined(); // saved proof reused
      expect(second.listConnections()).toHaveLength(1);
    } finally {
      socket?.close();
      await second?.close();
      await first.close();
    }
  });
});
