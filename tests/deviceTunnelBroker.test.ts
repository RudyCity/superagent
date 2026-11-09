import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  authenticateDeviceTunnel,
  createDeviceTunnelInvite,
  enrollDeviceTunnel,
  getDeviceTunnelInviteStatus,
  listDeviceTunnelDevices,
  pollDeviceTunnel,
  requestDeviceTunnel,
  resetDeviceTunnelBrokerForTests,
  revokeDeviceTunnel,
  submitDeviceTunnelReply,
} from "../src/core/deviceTunnel/broker.js";

const previous = process.env.SUPERAGENT_CONFIG_DIR;
let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-device-tunnel-"));
  process.env.SUPERAGENT_CONFIG_DIR = root;
  resetDeviceTunnelBrokerForTests();
});
afterEach(() => {
  resetDeviceTunnelBrokerForTests();
  fs.rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = previous;
});

describe("Device Tunnel broker", () => {
  it("uses one-time enrollment and persists only a device-token hash", () => {
    const invite = createDeviceTunnelInvite();
    expect(invite.code).toMatch(/^\d{10}$/);

    expect(() => enrollDeviceTunnel({
      inviteId: invite.inviteId,
      code: "0000000000",
      name: "Test Laptop",
      platform: "windows",
      fingerprint: "a".repeat(64),
    })).toThrow(/rejected/i);

    const enrolled = enrollDeviceTunnel({
      inviteId: invite.inviteId,
      code: invite.code,
      name: "Test Laptop",
      platform: "windows",
      fingerprint: "a".repeat(64),
    });
    expect(enrolled.device.online).toBe(true);
    expect(getDeviceTunnelInviteStatus(invite.inviteId)).toMatchObject({ valid: false, state: "used" });
    expect(enrolled.token).toMatch(/^[a-f0-9]{64}$/);
    expect(() => enrollDeviceTunnel({
      inviteId: invite.inviteId,
      code: invite.code,
      name: "Replay",
      platform: "windows",
      fingerprint: "a".repeat(64),
    })).toThrow(/expired|unknown/i);

    const stored = fs.readFileSync(path.join(root, "device-tunnel-peers.json"), "utf8");
    expect(stored).not.toContain(enrolled.token);
    expect(stored).not.toContain(invite.code);
    expect(stored).toContain('"tokenHash"');
    expect(listDeviceTunnelDevices()).toHaveLength(1);
  });

  it("delivers a bounded queued request and accepts a fast reply without races", async () => {
    const invite = createDeviceTunnelInvite();
    const enrolled = enrollDeviceTunnel({
      inviteId: invite.inviteId,
      code: invite.code,
      name: "Android Test",
      platform: "android",
      fingerprint: "b".repeat(64),
    });

    const responsePromise = requestDeviceTunnel(enrolled.device.id, { op: "android.health" }, 5_000);
    const job = await pollDeviceTunnel(enrolled.device.id, enrolled.token, 1_000);
    expect(job?.body).toEqual({ op: "android.health" });
    expect(job?.requestId).toMatch(/^[a-f0-9-]{36}$/i);

    submitDeviceTunnelReply(enrolled.device.id, enrolled.token, job!.requestId, [
      { event: "output", stream: "stdout", data: "ok" },
      { event: "done", ok: true, exitCode: 0 },
    ]);
    await expect(responsePromise).resolves.toEqual([
      { event: "output", stream: "stdout", data: "ok" },
      { event: "done", ok: true, exitCode: 0 },
    ]);
  });

  it("revocation invalidates the device token and pending access", async () => {
    const invite = createDeviceTunnelInvite();
    const enrolled = enrollDeviceTunnel({
      inviteId: invite.inviteId,
      code: invite.code,
      name: "Revoke Test",
      platform: "windows",
      fingerprint: "c".repeat(64),
    });
    const pending = requestDeviceTunnel(enrolled.device.id, { op: "status" }, 5_000);
    revokeDeviceTunnel(enrolled.device.id);
    await expect(pending).rejects.toThrow(/revoked/i);
    expect(() => authenticateDeviceTunnel(enrolled.device.id, enrolled.token))
      .toThrow(/unknown/i);
  });
});
