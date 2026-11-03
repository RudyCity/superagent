import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flushDelegateConnectionAudit,
  writeDelegateConnectionAudit,
  type DelegateAuditRecord,
} from "../src/core/delegate/connectionAudit.js";

const originalConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
const directories: string[] = [];

afterEach(async () => {
  await flushDelegateConnectionAudit();
  if (originalConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = originalConfigDir;
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("Delegate connection terminal output", () => {
  it("prints only successful Chrome connections but retains the entire audit trail in JSONL", async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-delegate-audit-"));
    directories.push(folder);
    process.env.SUPERAGENT_CONFIG_DIR = folder;
    const consoleLines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((...args) => consoleLines.push(args.join(" ")));
    const initial: DelegateAuditRecord = {
      timestamp: "2026-11-04T00:00:00.000Z",
      event: "listener_started",
      pid: 321,
      listenerPort: 17341,
      endpoint: "ws://127.0.0.1:17341",
      activeProfiles: 0,
      openSockets: 0,
      pendingRequests: 0,
    };
    const events: DelegateAuditRecord[] = [
      initial,
      { ...initial, event: "socket_open", connectionId: "connection-a", openSockets: 1 },
      {
        ...initial, event: "connected", connectionId: "connection-a",
        clientId: "chrome-work-001", profileLabel: "Chrome Work",
        extensionId: "a".repeat(32), extensionVersion: "1.4.0",
        remoteAddress: "127.0.0.1", remotePort: 49152,
        authVerified: true, activeProfiles: 1, openSockets: 1,
      },
      { ...initial, event: "handshake_rejected", reasonCode: "DELEGATE_AUTH_FAILED" },
      { ...initial, event: "disconnected", clientId: "chrome-work-001", closeCode: 1000 },
    ];
    for (const e of events) writeDelegateConnectionAudit(e);
    await flushDelegateConnectionAudit();

    expect(consoleLines).toHaveLength(1);
    expect(consoleLines[0]).toContain("[Delegate][CONNECTED]");
    expect(consoleLines[0]).toContain('"profileLabel":"Chrome Work"');
    expect(consoleLines[0]).toContain('"remotePort":49152');
    expect(consoleLines[0]).not.toContain("DELEGATE_AUTH_FAILED");

    const logPath = path.join(folder, "logs", "delegate-connections-2026-11-04.jsonl");
    const rows = fs.readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows.map(row => row.event)).toEqual(events.map(e => e.event));
    expect(rows[2].clientId).toBe("chrome-work-001");
  });
});
