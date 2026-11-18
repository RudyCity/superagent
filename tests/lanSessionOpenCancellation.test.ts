import { afterEach, describe, expect, it } from "vitest";
import { lanInterfaces, startLanServer, type LanServerHandle } from "../src/core/lanRemote/transport.js";
import {
  pairLanDevice, openLanSession, closeLanSession, listLanDevices, revokeLanDevice,
} from "../src/core/lanRemote/controller.js";

describe("LAN session close racing physical owner approval", () => {
  const adapter = lanInterfaces()[0];
  let receiver: LanServerHandle | null = null;
  const ids: string[] = [];
  afterEach(async () => {
    await Promise.allSettled(ids.splice(0).map(id => revokeLanDevice(id)));
    if (receiver) { await receiver.close(); receiver = null; }
  });

  (adapter ? it : it.skip)("invalidates a late approved session instead of reconnecting it", async () => {
    let approveSession: (() => void) | undefined;
    let sawPrompt: (() => void) | undefined;
    const prompt = new Promise<void>(resolve => { sawPrompt = resolve; });
    const decision = new Promise<void>(resolve => { approveSession = resolve; });
    receiver = await startLanServer({
      host: adapter.address, port: 0, segmentName: "session-race", code: "98765432",
      onApproval: async request => {
        if (request.kind !== "session") return true;
        sawPrompt?.();
        await decision;
        return true;
      },
    });
    const d = await pairLanDevice({
      host: adapter.address, port: receiver.port, fingerprint: receiver.fingerprint,
      code: "98765432", segmentName: "session-race",
    });
    ids.push(d.id);
    const pendingOpen = openLanSession(d.id);
    try {
      await prompt;
      await closeLanSession(d.id);
      approveSession?.();
      await expect(pendingOpen).rejects.toThrow(/cancelled|revoked/);
      expect(listLanDevices().find(entry => entry.id === d.id)?.connected).toBe(false);
      for (let tries = 0; tries < 25 && receiver.state().sessionActive; tries++) {
        await new Promise<void>(resolve => setTimeout(resolve, 40));
      }
      expect(receiver.state().sessionActive).toBe(false);
    } finally {
      approveSession?.();
      await pendingOpen.catch(() => {});
    }
  }, 25_000);
});
