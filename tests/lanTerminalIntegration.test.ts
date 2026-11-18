import { afterEach, describe, expect, it } from "vitest";
import { lanInterfaces, startLanServer, type LanServerHandle } from "../src/core/lanRemote/transport.js";
import {
  pairLanDevice, openLanSession, closeLanSession, revokeLanDevice,
  startLanTerminal, inputLanTerminal, readLanTerminal, stopLanTerminal,
} from "../src/core/lanRemote/controller.js";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
describe("LAN attended terminal protocol (real pinned TLS on an available private adapter)", () => {
  let server: LanServerHandle | null = null;
  afterEach(async () => { if (server) { await server.close(); server = null; } });
  const adapter = lanInterfaces()[0];
  const maybeIt = adapter ? it : it.skip;

  maybeIt("requires per-task and per-input target consent; binds read/stop to approved session", async () => {
    let allowTerminal = false;
    const approvals: string[] = [];
    server = await startLanServer({
      host: adapter.address, port: 0, segmentName: "terminal-check", code: "12345678",
      onApproval: async ({ kind, detail }) => {
        approvals.push(kind + ":" + (detail || "").slice(0, 30));
        return kind !== "terminal" || allowTerminal;
      },
    });
    const device = await pairLanDevice({
      host: adapter.address, port: server.port, fingerprint: server.fingerprint,
      code: "12345678", segmentName: "terminal-check",
    });
    try {
      await openLanSession(device.id);
      const command = process.platform === "win32"
        ? "Start-Sleep -Seconds 10" : "sleep 10";
      await expect(startLanTerminal(device.id, command)).rejects.toThrow(/approved|denied/i);
      allowTerminal = true;
      const started = await startLanTerminal(device.id, command);
      expect(started.running).toBe(true);
      expect(started.stopping).toBe(false);
      expect(approvals.filter(x => x.startsWith("terminal:")).length).toBe(2);

      allowTerminal = false;
      await expect(inputLanTerminal(device.id, started.jobId, "hello", true))
        .rejects.toThrow(/approved|denied/i);
      allowTerminal = true;
      const input = await inputLanTerminal(device.id, started.jobId, "hello", true);
      expect(input.jobId).toBe(started.jobId);
      expect(approvals.filter(x => x.startsWith("terminal:")).length).toBe(4);
      const stopped = await stopLanTerminal(device.id, started.jobId);
      expect(stopped.stopping || !stopped.running).toBe(true);
      let ended = stopped;
      for (let index = 0; index < 90 && ended.running; index++) {
        await sleep(40);
        ended = await readLanTerminal(device.id, started.jobId, ended.nextCursor);
      }
      expect(ended.running).toBe(false);
      expect(ended.reason).toBe("stopped_by_owner");
      await closeLanSession(device.id);
      await expect(readLanTerminal(device.id, started.jobId)).rejects.toThrow(/approved session|Open an approved/);
    } finally {
      await revokeLanDevice(device.id).catch(() => {});
    }
  }, 25_000);
});
