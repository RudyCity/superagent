import { describe, expect, it } from "vitest";
import {
  lanInterfaces, onLinkToPeer, privateIntranetPeer, samePrivateIntranetAllocation, outboundLanSource,
} from "../src/core/lanRemote/transport.js";
import { discoverLanDevices } from "../src/core/lanRemote/controller.js";
import { parseTrayLanAction } from "../src/core/runtime/trayLanBridge.js";

describe("explicit routed private-intranet device selection", () => {
  it("allows campus subnets within one /16 but not public, loopback, malformed or other intranets", () => {
    expect(samePrivateIntranetAllocation("10.200.84.27", "10.200.4.187")).toBe(true);
    expect(samePrivateIntranetAllocation("10.200.84.27", "10.201.4.187")).toBe(false);
    expect(samePrivateIntranetAllocation("10.200.84.27", "10.30.0.168")).toBe(false);
    expect(samePrivateIntranetAllocation("192.168.50.2", "192.168.99.15")).toBe(true);
    for (const ip of ["127.0.0.1", "8.8.8.8", "169.254.1.2", "0.0.0.0", "10.200.04.187",
      "10.200.4.999", "10.200.4.187 extra", "::1", "10.201.4.187"]) {
      expect(samePrivateIntranetAllocation("10.200.84.27", ip)).toBe(false);
    }
  });
  it("rejects nonprivate direct probes before sending any UDP packet", async () => {
    for (const ip of ["8.8.8.8", "127.0.0.1", "10.200.4.999", "10.200.04.187", "192.0.2.1"]) {
      await expect(discoverLanDevices("campus-segment", 250, ip))
        .rejects.toThrow(/private IPv4/);
      expect(() => parseTrayLanAction({ action: "discover", segment: "campus-segment", targetIp: ip }))
        .toThrow(/private IPv4/);
    }
  });
  it("uses only physical interfaces for routed peers, not an unrestricted private-IP allowlist", () => {
    const adapters = lanInterfaces();
    expect(privateIntranetPeer("8.8.8.8")).toBe(false);
    expect(privateIntranetPeer("127.0.0.1")).toBe(false);
    expect(privateIntranetPeer("10.200.04.187")).toBe(false);
    for (const adapter of adapters) {
      expect(onLinkToPeer(adapter.address)).toBe(true);
      expect(privateIntranetPeer(adapter.address)).toBe(true);
    }
    if (adapters.length) {
      const first = adapters[0];
      const suffix = first.address.split(".");
      const routed = [suffix[0], suffix[1], suffix[2] === "1" ? "2" : "1", "50"].join(".");
      if (samePrivateIntranetAllocation(first.address, routed)) {
        expect(privateIntranetPeer(routed)).toBe(true);
      }
    }
  });
  it("chooses a verified physical interface in the target's private allocation", () => {
    const adapters = lanInterfaces();
    for (const adapter of adapters) {
      expect(outboundLanSource(adapter.address)).toBe(adapter.address);
    }
    for (const ip of ["8.8.8.8", "127.0.0.1", "169.254.1.2"]) {
      expect(() => outboundLanSource(ip)).toThrow(/approved physical private interface/);
    }
    const matchingCampus = adapters.find((a) => a.address.startsWith("10.200."));
    if (matchingCampus) {
      expect(outboundLanSource("10.200.4.187")).toBe(matchingCampus.address);
    }
  });
});
