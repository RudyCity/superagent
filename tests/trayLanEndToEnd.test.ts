import { afterEach, describe, expect, it, vi } from "vitest";
import { lanInterfaces, startLanServer, type LanServerHandle } from "../src/core/lanRemote/transport.js";

// Test-only substitution: never change persisted Full YOLO or production flags.
// Exercises the same Core -> LAN boundary with an authorized operator.
vi.mock("../src/core/permissions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/permissions.js")>();
  return { ...actual, isFullYoloMode: () => true };
});
import { dispatchTrayLanAction } from "../src/core/runtime/trayLanBridge.js";

describe("Authenticated Tray management flow -> Windows LAN Client", () => {
  const physical = lanInterfaces()[0];
  let server: LanServerHandle | null = null;
  afterEach(async () => { if (server) { await server.close(); server = null; } });

  const maybeIt = physical ? it : it.skip;
  maybeIt("pairs, opens with target approvals, rejects destructive commands, executes then revokes", async () => {
    const approvals: string[] = [];
    server = await startLanServer({
      segmentName: "test-lan",
      host: physical.address, port: 0, code: "11223344",
      onApproval: async ({ kind }) => { approvals.push(kind); return true; },
    });
    const paired = await dispatchTrayLanAction({
      action: "pair", host: physical.address, port: server.port, fingerprint: server.fingerprint,
      code: "11223344", controller: "SuperAgent Tray",
    }) as any;
    const deviceId: string = paired.device.id;
    expect(paired.device.label).toContain(physical.address);
    const initial = await dispatchTrayLanAction({ action: "list" }) as any;
    expect(initial.devices.some((d: any) => d.id === deviceId && !d.connected)).toBe(true);
    await expect(dispatchTrayLanAction({ action: "exec", deviceId, command: "Write-Output X" }))
      .rejects.toThrow(/approved session/);
    const active = await dispatchTrayLanAction({ action: "open", deviceId }) as any;
    expect(active.device.connected).toBe(true);
    expect(approvals).toEqual(["pair", "session"]);
    await expect(dispatchTrayLanAction({ action: "exec", deviceId, command: "Stop-Computer -Force" }))
      .rejects.toThrow(/destructive/i);
    const command = process.platform === "win32" ? "Write-Output TRAY_NATIVE_OK" : "printf TRAY_NATIVE_OK";
    const response = await dispatchTrayLanAction({ action: "exec", deviceId, command }) as any;
    expect(response.result.ok).toBe(true);
    expect(response.result.stdout).toContain("TRAY_NATIVE_OK");
    await dispatchTrayLanAction({ action: "close", deviceId });
    await dispatchTrayLanAction({ action: "revoke", deviceId });
    const final = await dispatchTrayLanAction({ action: "list" }) as any;
    expect(final.devices.some((d: any) => d.id === deviceId)).toBe(false);
    expect(server.state().paired).toBe(0);
  }, 30000);
});
