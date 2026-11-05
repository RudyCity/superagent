import { describe, expect, it } from "vitest";
import { DelegateBridge } from "../src/core/delegate/bridge.js";

function bridge() {
  return new DelegateBridge(0, "b".repeat(48), () => {}, () => {});
}

describe("atomic Delegate stop quiescence", () => {
  it("rejects new RPC, renewal and pairing after quiesce, then can be restarted", async () => {
    const listener = bridge();
    try {
      await listener.start();
      expect(listener.getPairingCode()).not.toBeNull();
      listener.quiesceForStop();
      expect(listener.getPairingCode()).toBeNull();
      expect(() => listener.renewPairingCode()).toThrow("DELEGATE_BRIDGE_QUIESCING");
      await expect(listener.request("delegate.read_chat", {}))
        .rejects.toThrow("DELEGATE_BRIDGE_QUIESCING");
      await expect(listener.start()).rejects.toThrow("DELEGATE_BRIDGE_QUIESCING");
      await listener.close();
      expect(listener.isRunning()).toBe(false);
      await listener.start();
      expect(listener.getPairingCode()).not.toBeNull();
    } finally {
      await listener.close();
    }
  });

  it("refuses stop when an in-flight request exists and reopens acceptance", async () => {
    const listener = bridge();
    try {
      await listener.start();
      const pending = (listener as any).pending as Map<string, any>;
      pending.set("held", { socket: null });
      expect(() => listener.quiesceForStop()).toThrow("DELEGATE_BRIDGE_BUSY");
      pending.delete("held"); // Fixture-only request; never on real service
      expect(listener.getPairingCode()).not.toBeNull();
      expect(() => listener.renewPairingCode()).not.toThrow();
      listener.quiesceForStop();
      listener.resumeAfterRejectedStop();
      expect(listener.getPairingCode()).not.toBeNull();
    } finally {
      await listener.close();
    }
  });
});
