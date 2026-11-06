import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  delegateForwardingMaterialFromWire,
  delegateForwardingPipePath,
  requestDelegateForwardingMaterial,
  startCoreSupervisorDelegateForwardingBroker,
} from "../src/core/runtime/delegateForwardingLifecycle.js";
import { generateDelegateForwardedChannelMaterial } from "../src/core/browserTransport/delegateForwardedPrincipal.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!().catch(() => {});
});

describe("Delegate forwarding private lifecycle IPC", () => {
  it("round-trips 256-bit material only through the authenticated private broker", async () => {
    const material = generateDelegateForwardedChannelMaterial();
    const controlToken = crypto.randomBytes(32).toString("hex");
    const publicPort = 20000 + Math.floor(Math.random() * 20000);
    const supervisorPid = process.pid + 10000 + Math.floor(Math.random() * 1000);
    const broker = await startCoreSupervisorDelegateForwardingBroker({
      publicPort, supervisorPid, controlToken, material,
    });
    closers.push(broker.close);

    expect(broker.path).toBe(delegateForwardingPipePath(publicPort, supervisorPid));
    const result = await requestDelegateForwardingMaterial({
      supervisorPid, publicPort, controlPort: 31337, controlToken,
    }, 1500);
    result.socket.destroy();
    expect(result.material.channelId).toBe(material.channelId);
    expect(Buffer.from(result.material.key).equals(Buffer.from(material.key))).toBe(true);
  });

  it("rejects an invalid supervisor lease without returning material", async () => {
    const material = generateDelegateForwardedChannelMaterial();
    const controlToken = crypto.randomBytes(32).toString("hex");
    const publicPort = 30000 + Math.floor(Math.random() * 10000);
    const supervisorPid = process.pid + 12000 + Math.floor(Math.random() * 1000);
    const broker = await startCoreSupervisorDelegateForwardingBroker({
      publicPort, supervisorPid, controlToken, material,
    });
    closers.push(broker.close);

    await expect(requestDelegateForwardingMaterial({
      supervisorPid, publicPort, controlPort: 31337,
      controlToken: "0".repeat(64),
    }, 800)).rejects.toThrow(/DELEGATE_FORWARD_BRIDGE/);
  });

  it("rejects malformed or zero key material", () => {
    expect(() => delegateForwardingMaterialFromWire({
      channelId: "A".repeat(24), key: "bad",
    })).toThrow("DELEGATE_FORWARD_BRIDGE_MATERIAL_INVALID");
    expect(() => delegateForwardingMaterialFromWire({
      channelId: "A".repeat(24), key: Buffer.alloc(32).toString("base64url"),
    })).toThrow("DELEGATE_FORWARD_BRIDGE_MATERIAL_INVALID");
  });
});
