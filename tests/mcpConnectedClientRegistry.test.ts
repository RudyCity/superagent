import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  reconcileVerifiedMcpConnections,
  listLastObservedMcpConnections,
  type TrustedMcpSessionMetadata,
} from "../src/core/mcp/mcpConnectedClientRegistry.js";

describe("operator-only MCP connection registration", () => {
  let directory = "";
  let ledger = "";
  const port = 9227;
  const makeSession = (partial: Partial<TrustedMcpSessionMetadata> = {}): TrustedMcpSessionMetadata => {
    const now = Date.now();
    return {
      principalHandle: "idh_1111111111111111",
      sessionHandle: "ses_aaaaaaaaaaaa",
      authMode: "oauth",
      claimedClientName: "ChatGPT",
      claimedClientVersion: "1.0",
      createdAt: now - 5000,
      lastSeenAt: now - 1000,
      state: "idle",
      ...partial,
    };
  };
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "sa-mcp-connected-"));
    ledger = path.join(directory, "connected.json");
  });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  it("registers ChatGPT and Gemini with different tokens on one URL as separate connections", () => {
    const sessions = [
      makeSession(),
      makeSession({ sessionHandle: "ses_bbbbbbbbbbbb", lastSeenAt: Date.now() - 500 }),
      makeSession({
        principalHandle: "idh_2222222222222222",
        sessionHandle: "ses_cccccccccccc",
        claimedClientName: "Gemini",
      }),
    ];
    const saved = reconcileVerifiedMcpConnections(port, sessions, Date.now(), ledger);
    expect(saved).toHaveLength(2);
    expect(saved.map(item => item.connectionHandle).sort()).toEqual([
      "idh_1111111111111111", "idh_2222222222222222",
    ]);
    expect(saved.find(item => item.reportedClientName === "ChatGPT")?.sessionCount).toBe(2);
    expect(saved.find(item => item.reportedClientName === "Gemini")?.sessionCount).toBe(1);
    expect(saved.every(item => item.status === "connected")).toBe(true);
    const file = fs.readFileSync(ledger, "utf8");
    expect(file).not.toMatch(/credentialHash|accessToken|tokenHash|rawSessionId|grant|scope/);
    expect(file).not.toContain("https://");
  });

  it("keeps owner-assigned OAuth names distinct from untrusted clientInfo labels", () => {
    const entries=reconcileVerifiedMcpConnections(port,[
      makeSession({ownerConnectionName:"ChatGPT - Laptop Rudy",claimedClientName:"Unknown Browser"}),
      makeSession({principalHandle:"idh_2222222222222222",sessionHandle:"ses_bbbbbbbbbbbb",
        ownerConnectionName:"Gemini - PC Kantor",claimedClientName:"ChatGPT"}),
    ],Date.now(),ledger);
    expect(entries).toHaveLength(2);
    expect(entries.map(item=>item.ownerConnectionName).sort())
      .toEqual(["ChatGPT - Laptop Rudy","Gemini - PC Kantor"]);
    const saved=fs.readFileSync(ledger,"utf8");
    expect(saved).toContain("ChatGPT - Laptop Rudy");
    expect(saved).not.toContain("accessToken");
    expect(()=>reconcileVerifiedMcpConnections(port,[
      makeSession({ownerConnectionName:"Invalid\\u202EName"}),
    ],Date.now(),ledger)).toThrow("Invalid MCP client label");
  });

  it("keeps connection history without reusing the old online state", () => {
    const first = reconcileVerifiedMcpConnections(port, [
      makeSession(), makeSession({
        principalHandle: "idh_2222222222222222",
        sessionHandle: "ses_cccccccccccc",
        claimedClientName: "Gemini",
      }),
    ], Date.now(), ledger);
    const oldChat = first.find(item => item.reportedClientName === "ChatGPT")!;
    const later = reconcileVerifiedMcpConnections(port, [
      makeSession({
        principalHandle: "idh_2222222222222222",
        sessionHandle: "ses_dddddddddddd",
        claimedClientName: "Gemini",
      }),
    ], Date.now() + 2000, ledger);
    expect(later).toHaveLength(2);
    expect(later.find(item => item.connectionHandle === oldChat.connectionHandle))
      .toMatchObject({ status: "disconnected", sessionCount: 0,
        firstObservedAt: oldChat.firstObservedAt });
    const unverifiable = listLastObservedMcpConnections(port, Date.now() + 3000, ledger);
    expect(unverifiable.every(item => item.status === "disconnected" && item.sessionCount === 0))
      .toBe(true);
    expect(reconcileVerifiedMcpConnections(port, [
      makeSession({sessionHandle:"ses_eeeeeeeeeeee"}),
    ], Date.now() + 4000, ledger)
      .find(item => item.connectionHandle === oldChat.connectionHandle)?.firstObservedAt)
      .toBe(oldChat.firstObservedAt);
  });

  it("never merges two independent owner ports or trusts a forged session", () => {
    reconcileVerifiedMcpConnections(port, [makeSession()], Date.now(), ledger);
    reconcileVerifiedMcpConnections(9228, [makeSession({
      principalHandle:"idh_2222222222222222", sessionHandle:"ses_bbbbbbbbbbbb",
      claimedClientName:"Gemini",
    })], Date.now(), ledger);
    expect(listLastObservedMcpConnections(port, Date.now(), ledger)).toHaveLength(1);
    expect(listLastObservedMcpConnections(9228, Date.now(), ledger)).toHaveLength(1);
    const before = fs.readFileSync(ledger, "utf8");
    expect(() => reconcileVerifiedMcpConnections(port, [
      makeSession({sessionHandle:"injected-session"}),
    ], Date.now(), ledger)).toThrow(/Invalid verified MCP/);
    expect(() => reconcileVerifiedMcpConnections(port, [
      makeSession(), makeSession(),
    ], Date.now(), ledger)).toThrow(/Invalid verified MCP/);
    expect(fs.readFileSync(ledger, "utf8")).toBe(before);
  });

  it("rejects symlinked persistent ledger without modifying target data", () => {
    const target = path.join(directory, "target.json");
    fs.writeFileSync(target, "DO NOT MODIFY");
    try {
      fs.symlinkSync(target, ledger, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    expect(() => reconcileVerifiedMcpConnections(port, [makeSession()], Date.now(), ledger))
      .toThrow(/Unsafe MCP/);
    expect(fs.readFileSync(target, "utf8")).toBe("DO NOT MODIFY");
  });
});
