import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  ipv4Value, privateV4, sameOnLink, lanInterfaces, startLanServer,
  type LanServerHandle,
} from "../src/core/lanRemote/transport.js";
import {
  closeLanSession, execLanCommand, listLanDevices, openLanSession,
  pairLanDevice, revokeLanDevice,
} from "../src/core/lanRemote/controller.js";
import { LAN_MCP_TOOL_CLASSIFICATIONS, LAN_MCP_TOOL_DEFS } from "../src/core/mcp/tools/lanMcpTools.js";

describe("LAN-only address checks", () => {
  it("rejects invalid and non-private addresses", () => {
    expect(ipv4Value("192.168.1.12")).not.toBeNull();
    for (const address of ["", "127.0.0.1", "8.8.8.8", "192.168.1.999", "192.168.01.1", "::1"]) {
      expect(privateV4(address)).toBe(false);
    }
    expect(privateV4("10.2.3.4")).toBe(true);
    expect(privateV4("172.16.0.22")).toBe(true);
    expect(privateV4("172.32.0.1")).toBe(false);
  });
  it("limits peers to verified matching subnet", () => {
    expect(sameOnLink("192.168.1.7", "255.255.255.0", "192.168.1.99")).toBe(true);
    expect(sameOnLink("192.168.1.7", "255.255.255.0", "192.168.2.7")).toBe(false);
    expect(sameOnLink("192.168.1.7", "255.255.255.0", "127.0.0.1")).toBe(false);
    expect(sameOnLink("192.168.1.7", "255.255.255.0", "8.8.8.8")).toBe(false);
  });
  it("classifies every mutating LAN MCP tool as dangerous", () => {
    expect(new Set(LAN_MCP_TOOL_DEFS.map((d) => d.name)).size).toBe(LAN_MCP_TOOL_DEFS.length);
    expect(LAN_MCP_TOOL_CLASSIFICATIONS.superagent_lan_terminal_exec).toBe("dangerous");
    expect(LAN_MCP_TOOL_CLASSIFICATIONS.superagent_lan_pair).toBe("dangerous");
    expect(LAN_MCP_TOOL_CLASSIFICATIONS.superagent_lan_list_devices).toBe("safe");
  });
});

describe("LAN pairing and terminal with explicit approval", () => {
  let client: LanServerHandle | null = null;
  afterEach(async () => { if (client) { await client.close(); client = null; } });
  const target = lanInterfaces()[0];
  const maybeIt = target ? it : it.skip;
  maybeIt("rejects wrong fingerprint, invalid pairing, denies sessions, then executes a bounded command and revokes", async () => {
    let allowSession = false;
    let approvals = 0;
    client = await startLanServer({
      segmentName: "test-lan",
      host: target.address, port: 0, code: "12345678",
      onApproval: async (request) => { approvals++; return request.kind === "pair" || allowSession; },
    });
    await expect(pairLanDevice({ host: target.address, port: client.port, fingerprint: "0".repeat(64), code: "12345678" })).rejects.toThrow(/fingerprint/i);
    await expect(pairLanDevice({ host: target.address, port: client.port, fingerprint: client.fingerprint, code: "00000000" })).rejects.toThrow(/pairing/i);
    const paired = await pairLanDevice({ host: target.address, port: client.port, fingerprint: client.fingerprint, code: "12345678" });
    expect(client.state().paired).toBe(1);
    expect(approvals).toBe(1);
    await expect(execLanCommand(paired.id, "echo")).rejects.toThrow(/Open an approved session/);
    await expect(openLanSession(paired.id)).rejects.toThrow(/not approved/);
    allowSession = true;
    const open = await openLanSession(paired.id);
    expect(open.connected).toBe(true);
    const command = process.platform === "win32" ? "Write-Output LAN_E2E_OK" : "printf LAN_E2E_OK";
    const result = await execLanCommand(paired.id, command);
    expect(result.stdout).toContain("LAN_E2E_OK");
    expect(result.exitCode).toBe(0);
    expect(result.ok).toBe(true);
    await closeLanSession(paired.id);
    await expect(execLanCommand(paired.id, command)).rejects.toThrow(/Open an approved session/);
    await revokeLanDevice(paired.id);
    expect(listLanDevices().some((d) => d.id === paired.id)).toBe(false);
    expect(client.state().paired).toBe(0);
  }, 30_000);
});
