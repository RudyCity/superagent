import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DISCOVERY_REQUEST_PREFIX, normalizeNetworkSegment, networkSegmentTag,
  discoveryRequestForSegment, isSegmentDiscoveryRequest, parseSegmentDiscoveryResponse,
} from "../src/core/lanRemote/networkSegment.js";
import { lanInterfaces, startLanServer } from "../src/core/lanRemote/transport.js";
import { pairLanDevice, revokeLanDevice } from "../src/core/lanRemote/controller.js";
import { discoverLanDevices } from "../src/core/lanRemote/controller.js";

const tag = networkSegmentTag(" OFFICE_A ");
const reply = {
  version: 2, segmentTag: tag, address: "192.168.55.8", port: 17845, name: "Android Test",
  fingerprint: "a".repeat(64), platform: "android",
};

describe("mandatory LAN network segments", () => {
  it("normalizes safe ASCII and creates deterministic domain-separated SHA256", () => {
    expect(normalizeNetworkSegment("  Office_A  ")).toBe("office_a");
    expect(normalizeNetworkSegment("AB.C-1")).toBe("ab.c-1");
    expect(normalizeNetworkSegment("  A B  ")).toBe("a b");
    expect(tag).toBe(crypto.createHash("sha256")
      .update("superagent-lan-segment-v1:office_a").digest("hex"));
    expect(networkSegmentTag("office_a")).toBe(tag);
    expect(networkSegmentTag("office_b")).not.toBe(tag);
  });

  it("rejects empty, unsafe and overlong segments before scanning or listening", async () => {
    for (const invalid of [
      undefined, null, "", " ", "ab", "a".repeat(33), "bad?", "foo/bar",
      "été", "foo\nbar", "foo:bar", "🧪exp", " " + "x".repeat(33) + " ",
    ]) {
      expect(() => normalizeNetworkSegment(invalid)).toThrow(/segment/i);
      await expect(discoverLanDevices(invalid as string)).rejects.toThrow(/segment/i);
      await expect(startLanServer({
        host: "192.168.1.1", segmentName: invalid as string,
        onApproval: async () => false,
      })).rejects.toThrow(/segment/i);
    }
  });

  it("accepts only exact segment-tagged v2 queries, never legacy v1", () => {
    const request = discoveryRequestForSegment("office_a");
    expect(request).toBe(DISCOVERY_REQUEST_PREFIX + tag);
    expect(isSegmentDiscoveryRequest(request, tag)).toBe(true);
    expect(isSegmentDiscoveryRequest(Buffer.from(request), tag)).toBe(true);
    expect(isSegmentDiscoveryRequest("SUPERAGENT_LAN_DISCOVER_1", tag)).toBe(false);
    expect(isSegmentDiscoveryRequest(discoveryRequestForSegment("office_b"), tag)).toBe(false);
    expect(isSegmentDiscoveryRequest(request + "\n", tag)).toBe(false);
    expect(isSegmentDiscoveryRequest(request, "X".repeat(64))).toBe(false);
  });

  it("rejects wrong segment, obsolete v1, spoofed address and malformed devices", () => {
    expect(parseSegmentDiscoveryResponse(reply, reply.address, tag)).toEqual(reply);
    for (const update of [
      { version: 1 }, { segmentTag: networkSegmentTag("office_b") },
      { segmentTag: tag.toUpperCase() }, { port: 0 }, { port: 65535 },
      { port: 17845.5 }, { name: "malicious\nname" },
      { fingerprint: "0".repeat(63) }, { platform: "linux" },
    ]) {
      expect(parseSegmentDiscoveryResponse({ ...reply, ...update }, reply.address, tag)).toBeNull();
    }
    expect(parseSegmentDiscoveryResponse(reply, "192.168.55.9", tag)).toBeNull();
    expect(parseSegmentDiscoveryResponse(reply, reply.address, networkSegmentTag("other"))).toBeNull();
    expect(parseSegmentDiscoveryResponse(null, reply.address, tag)).toBeNull();
  });

  const physicalAdapter = lanInterfaces()[0];
  const onLinkIt = physicalAdapter ? it : it.skip;
  onLinkIt("pairs only after segment match, pinned TLS and explicit owner consent", async () => {
    let approved = 0;
    const server = await startLanServer({
      host: physicalAdapter.address, port: 0, segmentName: "Office_A",
      code: "87654321", onApproval: async (request) => {
        if (request.kind === "pair") approved++;
        return true;
      },
    });
    try {
      const input = {
        host: physicalAdapter.address, port: server.port, fingerprint: server.fingerprint,
        code: "87654321", controller: "Segment Test",
      };
      await expect(pairLanDevice({ ...input, segmentName: "other" }))
        .rejects.toThrow(/segment/i);
      expect(approved).toBe(0);
      const paired = await pairLanDevice({ ...input, segmentName: " office_a " });
      expect(paired.paired).toBe(true);
      expect(approved).toBe(1);
      expect(server.state().paired).toBe(1);
      await revokeLanDevice(paired.id);
    } finally {
      await server.close();
    }
  }, 30_000);

  it("both client entrypoints require a segment before opening listener", () => {
    const base = path.join(process.cwd(), "apps/superagent-lan-android/app/src/main/java/click/superagent/lanclient");
    const server = fs.readFileSync(path.join(base, "LanClientServer.java"), "utf8");
    const activity = fs.readFileSync(path.join(base, "MainActivity.java"), "utf8");
    const windows = fs.readFileSync(path.join(process.cwd(), "src/lanClient.ts"), "utf8");
    expect(server).toContain("public Info start(String segmentName)");
    expect(server).toContain("SUPERAGENT_LAN_DISCOVER_2:");
    expect(server).toContain('put("segmentTag", segmentTag)');
    expect(activity).toContain("pending.start(segmentName)");
    expect(activity).toContain("segmentInput.getText().toString()");
    expect(windows).toContain("--segment=");
    expect(windows).toContain("segmentName,");
  });
});

