import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setBrowserControlHandler, browserControlHandler } from "../src/core/tools/browserMacroTools.js";
import {
  claimCdpTarget, listCdpSessions, releaseCdpTarget, withCdpTargetWrite,
  withCdpTargetRead, cdpCoordinatorStatus, assertNoExternalBrowserMutation, rebindCdpTarget,
} from "../src/core/tools/chromeCdpSessionManager.js";

describe("Chrome CDP multi-agent capability and queue coordinator", () => {
  let dir = "";
  const oldDir = process.env.SUPERAGENT_CDP_SESSION_DIR;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "superagent-cdp-session-"));
    process.env.SUPERAGENT_CDP_SESSION_DIR = dir;
  });
  afterEach(async () => {
    if (oldDir === undefined) delete process.env.SUPERAGENT_CDP_SESSION_DIR;
    else process.env.SUPERAGENT_CDP_SESSION_DIR = oldDir;
    await rm(dir, { recursive: true, force: true });
  });

  test("requires a secret token even if another caller knows agentId", async () => {
    const claimed = await claimCdpTarget(9222, "TAB_A", "agent-a");
    expect(claimed.sessionToken.length).toBeGreaterThan(32);
    expect((await listCdpSessions())[0]).not.toHaveProperty("sessionToken");
    expect((await listCdpSessions())[0]).not.toHaveProperty("tokenHash");
    await expect(withCdpTargetRead(9222, "TAB_A", { agentId: "agent-a" }, async () => "stolen")).rejects.toThrow(/sessionToken/);
    await expect(withCdpTargetWrite(9222, "TAB_A", "agent-a", async () => "stolen")).rejects.toThrow(/sessionToken/);
    await expect(claimCdpTarget(9222, "TAB_A", "agent-a")).rejects.toThrow(/sessionToken/);
    await expect(claimCdpTarget(9222, "TAB_A", "agent-b")).rejects.toThrow(/sessionToken/);
    await expect(releaseCdpTarget(9222, "TAB_A", "agent-b", claimed.sessionToken)).rejects.toThrow(/sessionToken/);
    expect(await withCdpTargetRead(9222, "TAB_A", { agentId: "agent-a", sessionToken: claimed.sessionToken }, async () => "read")).toBe("read");
    expect(await withCdpTargetWrite(9222, "TAB_A", "agent-a", async () => "write", { sessionToken: claimed.sessionToken })).toBe("write");
    await releaseCdpTarget(9222, "TAB_A", "agent-a", claimed.sessionToken);
    expect((await listCdpSessions()).length).toBe(0);
  });

  test("renews read-only sessions and recovers expired leases with new capabilities", async () => {
    const original = await claimCdpTarget(9222, "TAB_A", "agent-a");
    const ownerFile = join(dir, "owners", original.key + ".json");
    const before = JSON.parse(await readFile(ownerFile, "utf8"));
    before.expiresAt = Date.now() + 100;
    await writeFile(ownerFile, JSON.stringify(before));
    await withCdpTargetRead(9222, "TAB_A", { agentId: "agent-a", sessionToken: original.sessionToken }, async () => true);
    expect(JSON.parse(await readFile(ownerFile, "utf8")).expiresAt).toBeGreaterThan(Date.now() + 60_000);
    const altered = JSON.parse(await readFile(ownerFile, "utf8"));
    altered.expiresAt = Date.now() - 500;
    await writeFile(ownerFile, JSON.stringify(altered));
    const recovered = await claimCdpTarget(9222, "TAB_A", "agent-b");
    expect(recovered.sessionToken).not.toBe(original.sessionToken);
    await expect(withCdpTargetWrite(9222, "TAB_A", "agent-a", async () => true, { sessionToken: original.sessionToken })).rejects.toThrow();
  });

  test("same-tab operations serialize, different targets are parallel", async () => {
    const a = await claimCdpTarget(9222, "TAB_A", "agent-a");
    const b = await claimCdpTarget(9222, "TAB_B", "agent-b");
    let simultaneous = 0;
    let peak = 0;
    const work = (target: string, actor: string, token: string) =>
      withCdpTargetWrite(9222, target, actor, async () => {
        simultaneous++;
        peak = Math.max(peak, simultaneous);
        await new Promise(r => setTimeout(r, 100));
        simultaneous--;
        return target;
      }, { sessionToken: token });
    expect(await Promise.all([work("TAB_A", "agent-a", a.sessionToken), work("TAB_B", "agent-b", b.sessionToken)])).toEqual(["TAB_A", "TAB_B"]);
    expect(peak).toBe(2);

    let entered = false;
    const hold = withCdpTargetWrite(9222, "TAB_A", "agent-a", async () => {
      await new Promise(r => setTimeout(r, 120));
      return "held";
    }, { sessionToken: a.sessionToken });
    await new Promise(r => setTimeout(r, 30));
    const queued = withCdpTargetWrite(9222, "TAB_A", "agent-a", async () => { entered = true; return true; }, { sessionToken: a.sessionToken, waitMs: 2000 });
    expect(await hold).toBe("held");
    expect(await queued).toBe(true);
    expect(entered).toBe(true);
  });

  test("supports cancellation and displays queue/session status without secrets", async () => {
    const claim = await claimCdpTarget(9222, "TAB_A", "agent-a");
    const abort = new AbortController();
    abort.abort();
    await expect(withCdpTargetWrite(9222, "TAB_A", "agent-a", async () => true, {
      sessionToken: claim.sessionToken, signal: abort.signal,
    })).rejects.toThrow(/cancelled/);
    const status = await cdpCoordinatorStatus();
    expect(status.sessions.length).toBe(1);
    expect(JSON.stringify(status)).not.toContain(claim.sessionToken);
  });

  test("fail-closes extension writes while CDP owns any tab", async () => {
    await assertNoExternalBrowserMutation();
    const claim = await claimCdpTarget(9222, "TAB_A", "agent-a");
    await expect(assertNoExternalBrowserMutation()).rejects.toThrow(/blocked/);
    await releaseCdpTarget(9222, "TAB_A", "agent-a", claim.sessionToken);
    await assertNoExternalBrowserMutation();
  });

  test("port isolation and releasing an operation lock after failures", async () => {
    await expect(withCdpTargetWrite(9222, "TAB_A", undefined, async () => { throw new Error("expected"); })).rejects.toThrow("expected");
    const first = await claimCdpTarget(9222, "TAB_A", "agent-a");
    const second = await claimCdpTarget(9333, "TAB_A", "agent-b");
    expect(await withCdpTargetWrite(9333, "TAB_A", "agent-b", async () => true, { sessionToken: second.sessionToken })).toBe(true);
    await expect(withCdpTargetWrite(9222, "TAB_A", "agent-b", async () => true, { sessionToken: second.sessionToken })).rejects.toThrow(/sessionToken/);
    await releaseCdpTarget(9222, "TAB_A", "agent-a", first.sessionToken);
  });
  test("rebind is authenticated and never steals another agent's replacement tab", async () => {
    const old = await claimCdpTarget(9222, "OLD_TAB", "agent-a");
    const other = await claimCdpTarget(9222, "BUSY_TAB", "agent-b");
    await expect(rebindCdpTarget(9222, "OLD_TAB", "BUSY_TAB", "agent-a", old.sessionToken)).rejects.toThrow(/sessionToken/);
    await expect(rebindCdpTarget(9222, "OLD_TAB", "NEW_TAB", "agent-a", "wrong-token")).rejects.toThrow(/sessionToken/);
    const rebound = await rebindCdpTarget(9222, "OLD_TAB", "NEW_TAB", "agent-a", old.sessionToken);
    expect(rebound.targetId).toBe("NEW_TAB");
    expect(rebound.sessionToken).not.toBe(old.sessionToken);
    expect((await listCdpSessions()).some(s => s.targetId === "OLD_TAB")).toBe(false);
    await releaseCdpTarget(9222, "NEW_TAB", "agent-a", rebound.sessionToken);
    await releaseCdpTarget(9222, "BUSY_TAB", "agent-b", other.sessionToken);
  });

  test("real independent Bun processes share ownership and reject invalid credentials", async () => {
    const claim = await claimCdpTarget(9222, "TAB_A", "agent-a");
    const other = await claimCdpTarget(9222, "TAB_B", "agent-b");
    const worker = join(process.cwd(), "tests", "fixtures", "cdpMultiAgentWorker.ts");
    const invoke = (targetId: string, agentId: string, token: string) =>
      new Promise<{ code: number; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [worker, "write", targetId, agentId, token], {
          cwd: process.cwd(),
          env: { ...process.env, SUPERAGENT_CDP_SESSION_DIR: dir },
          windowsHide: true,
        });
        let output = "";
        child.stdout.on("data", (chunk) => { output += String(chunk); });
        child.stderr.on("data", (chunk) => { output += String(chunk); });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code: code || 0, output }));
      });
    const [a, b, intruder] = await Promise.all([
      invoke("TAB_A", "agent-a", claim.sessionToken),
      invoke("TAB_B", "agent-b", other.sessionToken),
      invoke("TAB_A", "agent-b", other.sessionToken),
    ]);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.output).toContain("CDP_OK");
    expect(b.output).toContain("CDP_OK");
    expect(intruder.code).not.toBe(0);
    expect(intruder.output).toContain("CDP_DENIED");
    expect(intruder.output).not.toContain(claim.sessionToken);
  });

  test("priority queue serves the highest priority waiting agent first", async () => {
    const owner = await claimCdpTarget(9222, "TAB_A", "agent-a");
    let unblock!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const blocked = new Promise<void>(resolve => { unblock = resolve; });
    const running = withCdpTargetWrite(9222, "TAB_A", "agent-a", async () => {
      signalStarted();
      await blocked;
      return true;
    }, { sessionToken: owner.sessionToken });
    await started;
    const sequence: string[] = [];
    const low = withCdpTargetWrite(9222, "TAB_A", "agent-a", async () => {
      sequence.push("low");
    }, { sessionToken: owner.sessionToken, priority: 9, waitMs: 3000 });
    await new Promise(r => setTimeout(r, 75));
    const high = withCdpTargetWrite(9222, "TAB_A", "agent-a", async () => {
      sequence.push("high");
    }, { sessionToken: owner.sessionToken, priority: 0, waitMs: 3000 });
    await new Promise(r => setTimeout(r, 100));
    unblock();
    await Promise.all([running, high, low]);
    expect(sequence).toEqual(["high", "low"]);
  });

  test("browser extension wrapper is blocked while CDP claim is active", async () => {
    setBrowserControlHandler(async () => "UNSAFE_EXTENSION_ACTION");
    const owner = await claimCdpTarget(9222, "TAB_A", "agent-a");
    try {
      await expect(browserControlHandler!("navigate", "https://example.com/", "")).rejects.toThrow(/blocked/);
      await releaseCdpTarget(9222, "TAB_A", "agent-a", owner.sessionToken);
      expect(await browserControlHandler!("navigate", "https://example.com/", "")).toBe("UNSAFE_EXTENSION_ACTION");
    } finally {
      setBrowserControlHandler(null);
    }
  });

});
