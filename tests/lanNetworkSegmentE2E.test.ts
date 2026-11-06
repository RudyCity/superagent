import { afterEach, describe, expect, it } from "vitest";
import dgram from "node:dgram";
import { lanInterfaces, startLanServer, type LanServerHandle } from "../src/core/lanRemote/transport.js";
import {
  discoveryRequestForSegment, networkSegmentTag, parseSegmentDiscoveryResponse,
} from "../src/core/lanRemote/networkSegment.js";

describe("Network segment targeted UDP v2 responder (real on-link socket)", () => {
  let server: LanServerHandle | null = null;
  afterEach(async () => { if (server) { await server.close(); server = null; } });
  const adapter = lanInterfaces()[0];
  const runIf = adapter ? it : it.skip;
  runIf("ignores wrong segment and v1, responds only to exact tag with no secret text", async () => {
    server = await startLanServer({ host: adapter.address, port: 0,
      code: "11223344", segmentName: "alpha-team", onApproval: async () => false });
    const udp = dgram.createSocket("udp4");
    try {
      await new Promise<void>((resolve, reject) => {
        udp.once("error", reject);
        udp.bind(0, adapter.address, () => { udp.removeListener("error", reject); resolve(); });
      });
      const results: Array<any> = [];
      udp.on("message", (packet, remote) => {
        try { results.push({ value: JSON.parse(packet.toString()), remote }); }
        catch { results.push({ invalid: true }); }
      });
      const send = (text: string) => new Promise<void>((resolve, reject) => {
        udp.send(Buffer.from(text, "utf8"), server!.port + 1, adapter.address,
          (error) => error ? reject(error) : resolve());
      });
      await send("SUPERAGENT_LAN_DISCOVER_1");
      await send(discoveryRequestForSegment("beta-team"));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(results).toHaveLength(0);
      // The transport is UDP: retry the same idempotent probe a bounded
      // number of times because Windows firewall/adapter startup may drop
      // an initial datagram. No discovery state is mutated by the probe.
      for (let tryNo = 0; tryNo < 5 && results.length === 0; tryNo++) {
        await send(discoveryRequestForSegment("ALPHA-TEAM"));
        for (let i = 0; i < 8 && results.length === 0; i++)
          await new Promise((resolve) => setTimeout(resolve, 75));
      }
      expect(results.length).toBeGreaterThanOrEqual(1);
      const { value, remote } = results[0];
      expect(remote.address).toBe(adapter.address);
      expect(value.version).toBe(2);
      expect(value.segmentTag).toBe(networkSegmentTag("alpha-team"));
      expect(value).not.toHaveProperty("segmentName");
      expect(JSON.stringify(value)).not.toContain("alpha-team");
      expect(parseSegmentDiscoveryResponse(value, adapter.address, networkSegmentTag("alpha-team")))
        .toMatchObject({ port: server.port, platform: "windows" });
      expect(parseSegmentDiscoveryResponse(value, adapter.address, networkSegmentTag("beta-team")))
        .toBeNull();
    } finally { udp.close(); }
  }, 15_000);
});
