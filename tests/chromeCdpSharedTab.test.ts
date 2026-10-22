import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  claimCdpTarget, setCdpSharing, inviteCdpAgent, joinCdpTarget, leaveCdpTarget,
  revokeCdpAgent, handoverCdpTarget, getCdpParticipation, listCdpSessions,
  withCdpTargetRead, withCdpTargetWrite, releaseCdpTarget, cdpCoordinatorStatus,
} from "../src/core/tools/chromeCdpSessionManager.js";

describe("Shared Tab Session: owner, observer and contributor", () => {
  let tmp = "";
  const original = process.env.SUPERAGENT_CDP_SESSION_DIR;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "superagent-shared-cdp-"));
    process.env.SUPERAGENT_CDP_SESSION_DIR = tmp;
  });
  afterEach(async () => {
    if (original === undefined) delete process.env.SUPERAGENT_CDP_SESSION_DIR;
    else process.env.SUPERAGENT_CDP_SESSION_DIR = original;
    await rm(tmp, { force: true, recursive: true });
  });
  const shared = async () => {
    const owner = await claimCdpTarget(9222, "ONE_TAB", "owner");
    await setCdpSharing(9222, "ONE_TAB", "owner", owner.sessionToken, true);
    const add = async (agentId: string, role: "observer" | "contributor") => {
      const invite = await inviteCdpAgent(9222, "ONE_TAB", "owner", owner.sessionToken, agentId, role);
      return joinCdpTarget(9222, "ONE_TAB", agentId, invite.inviteId, invite.invitationToken);
    };
    return { owner, add };
  };

  test("isolated is default; no shared access or invitations without owner opt-in", async () => {
    const owner = await claimCdpTarget(9222, "ONE_TAB", "owner");
    expect(owner.mode).toBe("isolated");
    await expect(inviteCdpAgent(9222, "ONE_TAB", "owner", owner.sessionToken, "guest", "observer")).rejects.toThrow(/shared mode/);
    await expect(setCdpSharing(9222, "ONE_TAB", "intruder", "bogus", true)).rejects.toThrow(/sessionToken/);
    await expect(withCdpTargetWrite(9222, "ONE_TAB", "guest", async () => true)).rejects.toThrow(/sessionToken/);
    const state = await listCdpSessions();
    expect(state[0].mode).toBe("isolated");
    expect(state[0].participants).toHaveLength(1);
  });

  test("one-time bound invitations cannot be stolen, replayed, or forged", async () => {
    const { owner } = await shared();
    const i = await inviteCdpAgent(9222, "ONE_TAB", "owner", owner.sessionToken, "reader", "observer");
    await expect(joinCdpTarget(9222, "ONE_TAB", "other", i.inviteId, i.invitationToken)).rejects.toThrow(/invitation/);
    await expect(joinCdpTarget(9222, "ONE_TAB", "reader", i.inviteId, "wrong")).rejects.toThrow(/invitation/);
    const joined = await joinCdpTarget(9222, "ONE_TAB", "reader", i.inviteId, i.invitationToken);
    expect(joined.role).toBe("observer");
    expect(joined.sessionToken).not.toBe(owner.sessionToken);
    await expect(joinCdpTarget(9222, "ONE_TAB", "reader", i.inviteId, i.invitationToken)).rejects.toThrow(/invitation/);
    const file = await readFile(join(tmp, "owners", owner.key + ".json"), "utf8");
    expect(file).not.toContain(joined.sessionToken);
    expect(file).not.toContain(i.invitationToken);
    const publicStatus = JSON.stringify(await cdpCoordinatorStatus());
    expect(publicStatus).not.toContain("tokenHash");
    expect(publicStatus).not.toContain(joined.sessionToken);
    expect(publicStatus).not.toContain(i.invitationToken);
  });

  test("observer reads shared tab but cannot modify it; contributor can write", async () => {
    const { owner, add } = await shared();
    const observer = await add("observer", "observer");
    const contributor = await add("contributor", "contributor");
    expect(await withCdpTargetRead(9222, "ONE_TAB", { agentId: "observer", sessionToken: observer.sessionToken }, async () => "live DOM")).toBe("live DOM");
    await expect(withCdpTargetWrite(9222, "ONE_TAB", "observer", async () => "mutated", { sessionToken: observer.sessionToken })).rejects.toThrow(/observer cannot/);
    expect(await withCdpTargetWrite(9222, "ONE_TAB", "contributor", async () => "clicked", { sessionToken: contributor.sessionToken })).toBe("clicked");
    await expect(releaseCdpTarget(9222, "ONE_TAB", "contributor", contributor.sessionToken)).rejects.toThrow(/sessionToken/);
    await expect(claimCdpTarget(9222, "ONE_TAB", "contributor", contributor.sessionToken)).rejects.toThrow(/sessionToken/);
    await expect(setCdpSharing(9222, "ONE_TAB", "contributor", contributor.sessionToken, false)).rejects.toThrow(/sessionToken/);
    const participants = await getCdpParticipation(9222, "ONE_TAB", "observer", observer.sessionToken);
    expect(participants.participants.map(x => x.role).sort()).toEqual(["contributor", "observer", "owner"]);
    expect(JSON.stringify(participants)).not.toContain(contributor.sessionToken);
    await releaseCdpTarget(9222, "ONE_TAB", "owner", owner.sessionToken);
  });

  test("owner and contributor use the same per-tab exclusive write queue", async () => {
    const { owner, add } = await shared();
    const contributor = await add("contributor", "contributor");
    let count = 0, peak = 0;
    const work = (agentId: string, sessionToken: string) =>
      withCdpTargetWrite(9222, "ONE_TAB", agentId, async () => {
        count++; peak = Math.max(peak, count);
        await new Promise(r => setTimeout(r, 90));
        count--;
      }, { sessionToken });
    await Promise.all([work("owner", owner.sessionToken), work("contributor", contributor.sessionToken)]);
    expect(peak).toBe(1);
  });

  test("revoke and leave immediately invalidate membership capability", async () => {
    const { owner, add } = await shared();
    const guest = await add("guest", "contributor");
    await revokeCdpAgent(9222, "ONE_TAB", "owner", owner.sessionToken, "guest");
    await expect(withCdpTargetRead(9222, "ONE_TAB", { agentId: "guest", sessionToken: guest.sessionToken }, async () => true)).rejects.toThrow(/sessionToken/);
    const again = await add("guest", "observer");
    await leaveCdpTarget(9222, "ONE_TAB", "guest", again.sessionToken);
    await expect(withCdpTargetRead(9222, "ONE_TAB", { agentId: "guest", sessionToken: again.sessionToken }, async () => true)).rejects.toThrow(/sessionToken/);
    await expect(leaveCdpTarget(9222, "ONE_TAB", "owner", owner.sessionToken)).rejects.toThrow(/participant/);
  });

  test("handover promotes only joined contributor and revokes former owner", async () => {
    const { owner, add } = await shared();
    const observer = await add("observer", "observer");
    const contributor = await add("contributor", "contributor");
    const unclaimed = await inviteCdpAgent(9222, "ONE_TAB", "owner", owner.sessionToken, "late-agent", "observer");
    await expect(handoverCdpTarget(9222, "ONE_TAB", "owner", owner.sessionToken, "observer")).rejects.toThrow(/contributor/);
    const result = await handoverCdpTarget(9222, "ONE_TAB", "owner", owner.sessionToken, "contributor");
    expect(result.agentId).toBe("contributor");
    await expect(joinCdpTarget(9222, "ONE_TAB", "late-agent", unclaimed.inviteId, unclaimed.invitationToken)).rejects.toThrow(/invitation/);
    await expect(withCdpTargetRead(9222, "ONE_TAB", { agentId: "owner", sessionToken: owner.sessionToken }, async () => true)).rejects.toThrow(/sessionToken/);
    expect(await withCdpTargetWrite(9222, "ONE_TAB", "contributor", async () => "new owner", { sessionToken: contributor.sessionToken })).toBe("new owner");
    expect(await withCdpTargetRead(9222, "ONE_TAB", { agentId: "observer", sessionToken: observer.sessionToken }, async () => true)).toBe(true);
    await setCdpSharing(9222, "ONE_TAB", "contributor", contributor.sessionToken, false);
    await expect(withCdpTargetRead(9222, "ONE_TAB", { agentId: "observer", sessionToken: observer.sessionToken }, async () => true)).rejects.toThrow(/sessionToken/);
  });

  test("revocation overtakes queued contributor write and blocks it before execution", async () => {
    const { owner, add } = await shared();
    const contributor = await add("contributor", "contributor");
    let releaseHold!: () => void;
    let started!: () => void;
    const wait = new Promise<void>(r => { releaseHold = r; });
    const entered = new Promise<void>(r => { started = r; });
    const holder = withCdpTargetWrite(9222, "ONE_TAB", "owner", async () => {
      started();
      await wait;
    }, { sessionToken: owner.sessionToken });
    await entered;
    const revoke = revokeCdpAgent(9222, "ONE_TAB", "owner", owner.sessionToken, "contributor");
    await new Promise(r => setTimeout(r, 70));
    let ran = false;
    const queued = withCdpTargetWrite(9222, "ONE_TAB", "contributor", async () => {
      ran = true;
    }, { sessionToken: contributor.sessionToken, priority: 9, waitMs: 2500 });
    await new Promise(r => setTimeout(r, 70));
    releaseHold();
    await holder;
    await revoke;
    await expect(queued).rejects.toThrow(/sessionToken/);
    expect(ran).toBe(false);
  });

  test("expired invitation fails without issuing a participant capability", async () => {
    const { owner } = await shared();
    const invitation = await inviteCdpAgent(9222, "ONE_TAB", "owner", owner.sessionToken, "late", "observer");
    const file = join(tmp, "owners", owner.key + ".json");
    const original = JSON.parse(await readFile(file, "utf8"));
    original.invitations[invitation.inviteId].expiresAt = Date.now() - 1;
    await (await import("node:fs/promises")).writeFile(file, JSON.stringify(original));
    await expect(joinCdpTarget(9222, "ONE_TAB", "late", invitation.inviteId, invitation.invitationToken)).rejects.toThrow(/expired/);
    expect((await listCdpSessions())[0].participants).toHaveLength(1);
  });

  test("independent Bun process can write with joined contributor token", async () => {
    const { add } = await shared();
    const contributor = await add("worker", "contributor");
    const script = join(process.cwd(), "tests", "fixtures", "cdpMultiAgentWorker.ts");
    const result = await new Promise<{ exit: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [script, "write", "ONE_TAB", "worker", contributor.sessionToken], {
        cwd: process.cwd(), env: { ...process.env, SUPERAGENT_CDP_SESSION_DIR: tmp }, windowsHide: true,
      });
      let output = "";
      child.stdout.on("data", b => output += String(b));
      child.stderr.on("data", b => output += String(b));
      child.once("error", reject);
      child.once("exit", exit => resolve({ exit, output }));
    });
    expect(result.exit).toBe(0);
    expect(result.output).toMatch(/success|ok|write/i);
  });
});
