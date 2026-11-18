import { afterEach, describe, expect, it } from "vitest";
import { lanInterfaces, startLanServer, type LanServerHandle } from "../src/core/lanRemote/transport.js";
import {
  listLanDevices, pairLanDevice, openLanSession, closeLanSession, revokeLanDevice,
  startLanTerminal, readLanTerminal, inputLanTerminal, stopLanTerminal, execAndroidShellCommand,
} from "../src/core/lanRemote/controller.js";
import { LanTerminalFleet } from "../src/core/lanRemote/terminalFleet.js";

describe("2 independently approved LAN receiver terminal sessions", () => {
  const adapter = lanInterfaces()[0];
  const receivers: LanServerHandle[] = [];
  const ids: string[] = [];
  afterEach(async () => {
    await Promise.allSettled(ids.splice(0).map(id => revokeLanDevice(id)));
    await Promise.allSettled(receivers.splice(0).map(receiver => receiver.close()));
  });

  (adapter ? it : it.skip)("starts and stops two physically separate receiver processes in parallel", async () => {
    const approvals = { alpha: [] as string[], beta: [] as string[] };
    const make = async (label: "alpha" | "beta") => {
      const receiver = await startLanServer({
        host: adapter.address, port: 0, code: label === "alpha" ? "11112222" : "33334444",
        segmentName: "fleet-contract",
        onApproval: async ({ kind }) => {
          approvals[label].push(kind);
          return true;
        },
      });
      receivers.push(receiver);
      return receiver;
    };
    const [receiverA, receiverB] = await Promise.all([make("alpha"), make("beta")]);
    const [deviceA, deviceB] = await Promise.all([
      pairLanDevice({ host: adapter.address, port: receiverA.port, code: "11112222",
        fingerprint: receiverA.fingerprint, segmentName: "fleet-contract" }),
      pairLanDevice({ host: adapter.address, port: receiverB.port, code: "33334444",
        fingerprint: receiverB.fingerprint, segmentName: "fleet-contract" }),
    ]);
    ids.push(deviceA.id, deviceB.id);
    await Promise.all([openLanSession(deviceA.id), openLanSession(deviceB.id)]);
    const fleet = new LanTerminalFleet({
      list: listLanDevices, open: openLanSession, close: closeLanSession,
      start: startLanTerminal, read: readLanTerminal,
      input: inputLanTerminal, stop: stopLanTerminal, android: execAndroidShellCommand,
      fullYolo: () => true, destructive: () => false,
    });
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 20" : "sleep 20";
    const started = await fleet.execute("start", [
      { deviceId: deviceA.id, command },
      { deviceId: deviceB.id, command },
    ]);
    expect(started).toMatchObject({ requested: 2, succeeded: 2, failed: 0 });
    expect(approvals.alpha).toContain("terminal");
    expect(approvals.beta).toContain("terminal");
    const a = started.results[0], b = started.results[1];
    if (!a.ok || !("terminal" in a) || !b.ok || !("terminal" in b))
      throw Error("Windows terminal receipts missing");
    expect(a.terminal.jobId).not.toBe(b.terminal.jobId);
    const stoppedA = await stopLanTerminal(deviceA.id, a.terminal.jobId);
    expect(stoppedA.stopping || !stoppedA.running).toBe(true);
    // A stop must not propagate to B's independent process/session.
    const stillB = await readLanTerminal(deviceB.id, b.terminal.jobId, 0);
    expect(stillB.running).toBe(true);
    const stoppedB = await stopLanTerminal(deviceB.id, b.terminal.jobId);
    expect(stoppedB.stopping || !stoppedB.running).toBe(true);
    await closeLanSession(deviceA.id);
    await expect(readLanTerminal(deviceA.id, a.terminal.jobId)).rejects.toThrow(/approved session/);
  }, 35_000);
});
