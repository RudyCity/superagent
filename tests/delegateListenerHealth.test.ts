import { describe, it, expect } from "vitest";
import net from "node:net";
import {
  inspectDelegateListenerHealth, probeDelegateListenerPort,
} from "../src/core/delegate/delegateListenerHealth.js";

describe("Delegate listener port health (no ownership inference)", () => {
  it("handles current worker running and operator ON", async () => {
    await expect(inspectDelegateListenerHealth(true, true)).resolves.toMatchObject({
      healthy: true, desiredEnabled: true, portProbe: "occupied", portOwnerUnknown: false,
    });
  });

  it("identifies an occupied port with no current worker listener", async () => {
    const socket = net.createServer();
    await new Promise<void>((resolve) =>
      socket.listen(0, "127.0.0.1", resolve));
    try {
      const address = socket.address();
      if (!address || typeof address === "string") throw new Error("missing test TCP port");
      expect(await probeDelegateListenerPort(address.port)).toBe("occupied");
      expect(await inspectDelegateListenerHealth(false, true, () =>
        probeDelegateListenerPort(address.port))).toMatchObject({
        healthy: false, portOwnerUnknown: true, portProbe: "occupied",
      });
      expect(await inspectDelegateListenerHealth(false, false, () =>
        probeDelegateListenerPort(address.port))).toMatchObject({
        healthy: false, portOwnerUnknown: true,
      });
    } finally {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
  });

  it("accepts a verifiably free loopback port when operator OFF", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probeDelegateListenerPort(port)).toBe("free");
    expect(await inspectDelegateListenerHealth(false, false, () =>
      probeDelegateListenerPort(port))).toMatchObject({
      healthy: true, portProbe: "free", portOwnerUnknown: false,
    });
  });

  it("treats inconclusive probes as unhealthy rather than inventing ownership", async () => {
    const h = await inspectDelegateListenerHealth(false, false, async () => "unknown");
    expect(h.healthy).toBe(false);
    expect(h.portOwnerUnknown).toBe(false);
    await expect(probeDelegateListenerPort(0)).rejects.toThrow("DELEGATE_PORT_PROBE_INVALID_ARGUMENT");
  });
});
