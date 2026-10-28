import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimCdpTarget, cdpCoordinatorStatus, getCdpExecutionState,
  heartbeatCdpSession, inviteCdpAgent, joinCdpTarget, listCdpSessions,
  setCdpSharing, withCdpTargetRead, withCdpTargetWrite,
} from "../src/core/tools/chromeCdpSessionManager.js";
import { classifyCdpCommand } from "../src/core/tools/chromeCdpCommandPolicy.js";

describe("CDP coordinator optimizations P0–P2", () => {
  let root = "";
  const prior = process.env.SUPERAGENT_CDP_SESSION_DIR;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cdp-opt-test-"));
    process.env.SUPERAGENT_CDP_SESSION_DIR = root;
  });
  afterEach(async () => {
    if (prior === undefined) delete process.env.SUPERAGENT_CDP_SESSION_DIR;
    else process.env.SUPERAGENT_CDP_SESSION_DIR = prior;
    await rm(root, { force: true, recursive: true });
  });
  test("observer does not extend owner claim, member heartbeat stays bounded", async () => {
    const owner = await claimCdpTarget(9222, "TAB_A", "owner");
    await setCdpSharing(9222, "TAB_A", "owner", owner.sessionToken, true);
    const invite = await inviteCdpAgent(9222, "TAB_A", "owner", owner.sessionToken, "reader", "observer");
    const reader = await joinCdpTarget(9222, "TAB_A", "reader", invite.inviteId, invite.invitationToken);
    const f = join(root, "owners", owner.key + ".json");
    const stored = JSON.parse(await readFile(f, "utf8"));
    stored.expiresAt = Date.now() + 3500;
    await writeFile(f, JSON.stringify(stored));
    await withCdpTargetRead(9222, "TAB_A", { agentId: "reader", sessionToken: reader.sessionToken }, async () => true);
    expect(JSON.parse(await readFile(f, "utf8")).expiresAt).toBe(stored.expiresAt);
    const heartbeat = await heartbeatCdpSession(9222, "TAB_A", "reader", reader.sessionToken);
    expect(heartbeat.role).toBe("observer");
    expect(heartbeat.expiresAt).toBeLessThanOrEqual(stored.expiresAt);
    const renewed = await heartbeatCdpSession(9222, "TAB_A", "owner", owner.sessionToken);
    expect(renewed.expiresAt).toBeGreaterThan(Date.now() + 240000);
  });
  test("revisions increment after serialized write and reject stale preconditions", async () => {
    const owner = await claimCdpTarget(9222, "TAB_B", "owner");
    await setCdpSharing(9222, "TAB_B", "owner", owner.sessionToken, true);
    expect((await listCdpSessions())[0].revision).toBe(0);
    const before = await withCdpTargetRead(9222, "TAB_B",
      { agentId: "owner", sessionToken: owner.sessionToken }, async () => getCdpExecutionState());
    expect(before?.revision).toBe(0);
    await withCdpTargetWrite(9222, "TAB_B", "owner", async () => "navigated",
      { sessionToken: owner.sessionToken, expectedRevision: 0 });
    expect((await listCdpSessions())[0].revision).toBe(1);
    await expect(withCdpTargetWrite(9222, "TAB_B", "owner", async () => "stale",
      { sessionToken: owner.sessionToken, expectedRevision: 0 })).rejects.toThrow(/stale revision/);
    const info = await cdpCoordinatorStatus();
    expect(info.sessions[0].revision).toBe(1);
    expect(info.summary.activeAgents).toBe(1);
  });
  test("expired claims cannot be read or written by legacy or named callers", async () => {
    const claim = await claimCdpTarget(9222, "TAB_C", "owner");
    const f = join(root, "owners", claim.key + ".json");
    const state = JSON.parse(await readFile(f, "utf8"));
    state.expiresAt = Date.now() - 100;
    await writeFile(f, JSON.stringify(state));
    await expect(withCdpTargetRead(9222, "TAB_C", {}, async () => "leak")).rejects.toThrow(/expired|unclaimed/i);
    await expect(withCdpTargetRead(9222, "TAB_C", { agentId: "owner", sessionToken: claim.sessionToken }, async () => "leak")).rejects.toThrow(/expired|unclaimed/i);
    await expect(withCdpTargetWrite(9222, "TAB_C", undefined, async () => "modified")).rejects.toThrow(/claim/i);
  });
  test("unknown and mutating terminal commands do not use read-only guard", () => {
    expect(classifyCdpCommand("snapshot")).toBe("read");
    expect(classifyCdpCommand("shared_snapshot")).toBe("read");
    expect(classifyCdpCommand("read_workspace")).toBe("read");
    expect(classifyCdpCommand("read_accessibility_tree")).toBe("read");
    expect(classifyCdpCommand("inspect_frames")).toBe("read");
    expect(classifyCdpCommand("capture_dom_snapshot")).toBe("read");
    expect(classifyCdpCommand("get_dialogs", { clear: true })).toBe("write");
    expect(classifyCdpCommand("clear_terminal_sessions")).toBe("write");
    expect(classifyCdpCommand("execute_terminal")).toBe("write");
    expect(classifyCdpCommand("some_new_mutation")).toBe("write");
    expect(classifyCdpCommand("join_target")).toBe("admin");
    expect(classifyCdpCommand("heartbeat_session")).toBe("admin");
  });
});
