import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimCdpTarget, setCdpSharing, inviteCdpAgent, joinCdpTarget,
  pauseCdpTarget, resumeCdpTarget, withCdpTargetWrite, withCdpTargetRead,
  getCdpParticipation, releaseCdpTarget, listCdpSessions, readRecentCdpActivity,
} from "../src/core/tools/chromeCdpSessionManager.js";

describe("Managed CDP pause/resume fencing and ownership", () => {
  let temp = "";
  const original = process.env.SUPERAGENT_CDP_SESSION_DIR;
  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), "superagent-cdp-paused-"));
    process.env.SUPERAGENT_CDP_SESSION_DIR = temp;
  });
  afterEach(async () => {
    if (original === undefined) delete process.env.SUPERAGENT_CDP_SESSION_DIR;
    else process.env.SUPERAGENT_CDP_SESSION_DIR = original;
    await rm(temp, { recursive:true, force:true });
  });

  test("action timeline is bounded and rejects foreign actors or malicious event fields", async () => {
    const owner = await claimCdpTarget(9222, "TAB_AUDIT", "owner");
    await withCdpTargetWrite(9222, "TAB_AUDIT", "owner", async () => true,
      { sessionToken: owner.sessionToken });
    await pauseCdpTarget(9222, "TAB_AUDIT", "owner", owner.sessionToken);
    const malicious = { time: new Date().toISOString(), event: "steal_credentials",
      key: owner.key.slice(0, 16), actor: "owner", token: "VERY_PRIVATE" };
    const unknownActor = { time: new Date().toISOString(), event: "write_success",
      key: owner.key.slice(0, 16), actor: "intruder", cookie: "VERY_PRIVATE" };
    await appendFile(join(temp, "events.jsonl"), JSON.stringify(malicious) + "\\n" +
      JSON.stringify(unknownActor) + "\\n");
    const activity = await readRecentCdpActivity(await listCdpSessions());
    expect(activity.some(e => e.event === "paused_by_owner")).toBe(true);
    expect(activity.some(e => e.event === "write_success")).toBe(true);
    expect(activity.every(e => e.actor === "owner" && e.targetId === "TAB_AUDIT")).toBe(true);
    expect(JSON.stringify(activity)).not.toContain("VERY_PRIVATE");
    await releaseCdpTarget(9222, "TAB_AUDIT", "owner", owner.sessionToken);
  });

  test("owner-only pause blocks writes, while authorized observers may watch", async () => {
    const owner = await claimCdpTarget(9222, "TAB_PAUSE", "owner");
    await setCdpSharing(9222, "TAB_PAUSE", "owner", owner.sessionToken, true);
    const guestInvite = await inviteCdpAgent(9222, "TAB_PAUSE", "owner", owner.sessionToken, "guest", "contributor");
    const guest = await joinCdpTarget(9222, "TAB_PAUSE", "guest", guestInvite.inviteId, guestInvite.invitationToken);
    const observerInvite = await inviteCdpAgent(9222, "TAB_PAUSE", "owner", owner.sessionToken, "watcher", "observer");
    const observer = await joinCdpTarget(9222, "TAB_PAUSE", "watcher", observerInvite.inviteId, observerInvite.invitationToken);
    await expect(pauseCdpTarget(9222, "TAB_PAUSE", "guest", guest.sessionToken)).rejects.toThrow(/sessionToken/);
    const paused = await pauseCdpTarget(9222, "TAB_PAUSE", "owner", owner.sessionToken);
    expect(paused.paused).toBe(true);
    expect(paused.pausedAt).toBeGreaterThan(0);
    expect(paused.revision).toBeGreaterThan(owner.revision);
    const current = await listCdpSessions();
    expect(current.find(s => s.targetId === "TAB_PAUSE")?.paused).toBe(true);
    await expect(withCdpTargetWrite(9222, "TAB_PAUSE", "owner", async () => "mutation", { sessionToken: owner.sessionToken })).rejects.toThrow(/paused/);
    await expect(withCdpTargetWrite(9222, "TAB_PAUSE", "guest", async () => "mutation", { sessionToken: guest.sessionToken })).rejects.toThrow(/paused/);
    expect(await withCdpTargetRead(9222, "TAB_PAUSE", { agentId:"watcher", sessionToken:observer.sessionToken }, async () => "watch")).toBe("watch");
    await expect(resumeCdpTarget(9222, "TAB_PAUSE", "guest", guest.sessionToken, paused.revision, async () => true)).rejects.toThrow(/sessionToken/);
    await expect(resumeCdpTarget(9222, "TAB_PAUSE", "owner", owner.sessionToken, paused.revision, false as any)).rejects.toThrow(/fresh target/);
    await expect(resumeCdpTarget(9222, "TAB_PAUSE", "owner", owner.sessionToken, paused.revision - 1, async () => true)).rejects.toThrow(/stale revision/);
    await expect(resumeCdpTarget(9222, "TAB_PAUSE", "owner", owner.sessionToken,
      paused.revision, async () => false)).rejects.toThrow(/document cannot be verified/);
    expect((await listCdpSessions()).find(s => s.targetId === "TAB_PAUSE")?.paused).toBe(true);
    const resumed = await resumeCdpTarget(9222, "TAB_PAUSE", "owner", owner.sessionToken,
      paused.revision, async () => true);
    expect(resumed.paused).toBe(false);
    expect(resumed.generation).not.toBe(paused.generation);
    expect(resumed.revision).toBe(paused.revision + 1);
    expect(await withCdpTargetWrite(9222, "TAB_PAUSE", "guest", async () => "safe", { sessionToken: guest.sessionToken })).toBe("safe");
    await releaseCdpTarget(9222, "TAB_PAUSE", "owner", owner.sessionToken);
  });

  test("pausing waits for the in-flight gesture and fences pending queued writes", async () => {
    const owner = await claimCdpTarget(9222, "TAB_QUEUE", "owner");
    let unblock!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(r => { unblock = r; });
    const enteredPromise = new Promise<void>(r => { entered = r; });
    const running = withCdpTargetWrite(9222, "TAB_QUEUE", "owner", async () => {
      entered();
      await blocked;
      return "done";
    }, { sessionToken: owner.sessionToken });
    await enteredPromise;
    const pause = pauseCdpTarget(9222, "TAB_QUEUE", "owner", owner.sessionToken);
    await new Promise(r => setTimeout(r, 50));
    let queuedRan = false;
    const queued = withCdpTargetWrite(9222, "TAB_QUEUE", "owner", async () => {
      queuedRan = true;
    }, { sessionToken: owner.sessionToken, waitMs:3000, priority:9 });
    await new Promise(r => setTimeout(r, 55));
    expect(queuedRan).toBe(false);
    unblock();
    expect(await running).toBe("done");
    expect((await pause).paused).toBe(true);
    await expect(queued).rejects.toThrow(/paused/);
    expect(queuedRan).toBe(false);
    await releaseCdpTarget(9222, "TAB_QUEUE", "owner", owner.sessionToken);
  });
});
