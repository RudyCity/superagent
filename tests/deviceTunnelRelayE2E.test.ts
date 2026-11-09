import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDeviceTunnelInvite,
  enrollDeviceTunnel,
  pollDeviceTunnel,
  requestDeviceTunnel,
  resetDeviceTunnelBrokerForTests,
  submitDeviceTunnelReply,
} from "../src/core/deviceTunnel/broker.js";
import { relayLocalLanRequest } from "../src/core/deviceTunnel/client.js";
import {
  LAN_PORT,
  lanInterfaces,
  startLanServer,
} from "../src/core/lanRemote/transport.js";

const previous = process.env.SUPERAGENT_CONFIG_DIR;
const roots: string[] = [];

afterEach(() => {
  resetDeviceTunnelBrokerForTests();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = previous;
});

describe("Device Tunnel relay to existing LAN protocol engine", () => {
  const adapter = lanInterfaces()[0];
  const maybeIt = adapter ? it : it.skip;

  maybeIt("carries pair and session approval through the reverse tunnel queue", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-tunnel-relay-"));
    roots.push(root);
    process.env.SUPERAGENT_CONFIG_DIR = root;
    resetDeviceTunnelBrokerForTests();

    const target = await startLanServer({
      host: adapter.address,
      segmentName: "tunnel-e2e",
      port: 0,
      onApproval: async () => true,
      onNotice: () => {},
    });
    try {
      const invite = createDeviceTunnelInvite();
      const enrolled = enrollDeviceTunnel({
        inviteId: invite.inviteId,
        code: invite.code,
        name: "Relay E2E",
        platform: "windows",
        fingerprint: target.fingerprint,
      });

      async function roundTrip(body: Record<string, unknown>) {
        const coreResponse = requestDeviceTunnel(enrolled.device.id, body, 8_000);
        const job = await pollDeviceTunnel(enrolled.device.id, enrolled.token, 1_000);
        expect(job).not.toBeNull();
        const frames = await relayLocalLanRequest({
          host: target.host,
          port: target.port || LAN_PORT,
          fingerprint: target.fingerprint,
          body: job!.body,
          maxReplyChars: job!.maxReplyChars,
          timeoutMs: 8_000,
        });
        submitDeviceTunnelReply(enrolled.device.id, enrolled.token, job!.requestId, frames);
        return await coreResponse as Record<string, unknown>[];
      }

      const paired = await roundTrip({ op: "pair", code: target.code, label: "Tunnel E2E" });
      expect(paired[0]).toMatchObject({ ok: true, platform: "windows" });
      const pairId = paired[0].pairId as string;
      const pairToken = paired[0].pairToken as string;
      expect(pairId).toMatch(/^[a-f0-9-]{36}$/i);
      expect(pairToken).toMatch(/^[a-f0-9]{64}$/);

      const opened = await roundTrip({ op: "open", pairId, pairToken });
      expect(opened[0]).toMatchObject({ ok: true });
      expect(opened[0].sessionId).toMatch(/^[a-f0-9-]{36}$/i);
      expect(opened[0].sessionToken).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await target.close();
    }
  }, 30_000);
});
