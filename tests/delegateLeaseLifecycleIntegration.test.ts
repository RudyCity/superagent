import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = Buffer.alloc(32, 73);
const A = "a".repeat(32);
const B = "b".repeat(32);
const PROFILE = "delegate-chrome-profile-1234";
const OTHER_PROFILE = "delegate-chrome-profile-9999";
const TAB = 701;
let dir: string;

type Evidence = {
  epoch: string; ownerId: string; assertCurrent: () => boolean;
  assertPrivateStorage: (directory: string) => boolean;
  isEpochRetired: (epoch: string) => boolean;
};
function evidence(
  epoch = A, opts: { live?: () => boolean; retired?: (epoch: string) => boolean;
    protected?: () => boolean } = {},
): Evidence {
  return {
    epoch, ownerId: "verified-core-" + epoch.slice(0, 4),
    assertCurrent: opts.live ?? (() => true),
    assertPrivateStorage: path => path === dir && (opts.protected?.() ?? true),
    isEpochRetired: opts.retired ?? (() => false),
  };
}
async function load() {
  const runtime = await import("../src/core/browserTransport/delegateLeaseRuntime.js");
  const core = await import("../src/core/browserTransport/sessionCoordinator.js");
  return { runtime, core };
}
function options(proof: Evidence, initializeEmptyJournal = false) {
  return { directory: dir, integrityKey: KEY, verifiedCoreOwner: proof, initializeEmptyJournal };
}
beforeEach(() => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), "delegate-core-fence-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("verified Core lease lifecycle (no live services or journals)", () => {
  it("defaults to disabled, and blocks missing evidence/key without env fallback", async () => {
    const { runtime, core } = await load();
    expect(runtime.getDelegateLeaseRuntimeStatus().status).toBe("DISABLED");
    const result = runtime.activateDelegateLeaseRuntime();
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/verified supervisor|key/i);
    expect(() => core.claimDelegateTarget(PROFILE, TAB, "owner")).toThrow(/unavailable|verified/i);
  });

  it("requires protected evidence and never initializes a new journal implicitly", async () => {
    const { runtime } = await load();
    const result = runtime.activateDelegateLeaseRuntime(options(evidence(A, { protected: () => false }), true));
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/protected storage/i);
    vi.resetModules();
    const next = await load();
    const missing = next.runtime.activateDelegateLeaseRuntime(options(evidence(A)));
    expect(missing.status).toBe("BLOCKED");
    expect(missing.reason).toMatch(/MISSING|journal/i);
  });

  it("explicitly initializes under verified fencing and preserves only token digests", async () => {
    const { runtime, core } = await load();
    expect(runtime.activateDelegateLeaseRuntime(options(evidence(), true)).status).toBe("ACTIVE");
    const owner = core.claimDelegateTarget(PROFILE, TAB, "owner");
    const bytes = readFileSync(join(dir, "delegate-leases.v1.json"), "utf8");
    expect(bytes).not.toContain(owner.sessionToken);
    expect(runtime.getDelegateLeaseRuntimeStatus().status).toBe("ACTIVE");
    core.releaseDelegateTarget(PROFILE, TAB, "owner", owner.sessionToken);
    expect(runtime.retireDelegateLeaseRuntime().status).toBe("BLOCKED");
    expect(existsSync(join(dir, "delegate-core-owner.v1.lock"))).toBe(false);
    expect(() => core.claimDelegateTarget(PROFILE, TAB, "owner")).toThrow(/unavailable|retired/i);
  });

  it("refuses simultaneous Core instances, including two claimants with same epoch", async () => {
    const old = await load();
    expect(old.runtime.activateDelegateLeaseRuntime(options(evidence(), true)).status).toBe("ACTIVE");
    old.core.claimDelegateTarget(PROFILE, TAB, "owner");
    vi.resetModules(); // Different Core process simulation sharing the same on-disk state.
    const contender = await load();
    const denied = contender.runtime.activateDelegateLeaseRuntime(options(evidence(A)));
    expect(denied.status).toBe("BLOCKED");
    expect(denied.reason).toMatch(/COLLISION|owned|epoch/i);
    expect(() => contender.core.claimDelegateTarget(PROFILE, TAB, "intruder")).toThrow();
    expect(old.runtime.getDelegateLeaseRuntimeStatus().status).toBe("ACTIVE");
  });

  it("does not accept an unfenced prior generation, even with a changed epoch", async () => {
    const old = await load();
    expect(old.runtime.activateDelegateLeaseRuntime(options(evidence(), true)).status).toBe("ACTIVE");
    old.core.claimDelegateTarget(PROFILE, TAB, "owner");
    vi.resetModules();
    const next = await load();
    const status = next.runtime.activateDelegateLeaseRuntime(options(evidence(B)));
    expect(status.status).toBe("BLOCKED");
    expect(status.reason).toMatch(/COLLISION|retired/i);
  });

  it("recovers only the exact tab/profile, original owner token and retired writer; no attach/replay", async () => {
    let oldCurrent = true;
    const old = await load();
    const oldProof = evidence(A, { live: () => oldCurrent });
    expect(old.runtime.activateDelegateLeaseRuntime(options(oldProof, true)).status).toBe("ACTIVE");
    const claimed = old.core.claimDelegateTarget(PROFILE, TAB, "owner");
    const previousSequence = JSON.parse(readFileSync(join(dir, "delegate-leases.v1.json"), "utf8")).sequence;
    oldCurrent = false; // External supervisor fences the old Core before successor starts.
    vi.resetModules();
    const next = await load();
    const newProof = evidence(B, { retired: epoch => epoch === A });
    expect(next.runtime.activateDelegateLeaseRuntime(options(newProof)).status).toBe("ACTIVE");
    // Recover the stored lease only, not a browser command or old pending operation.
    await expect(next.core.withDelegateTargetLock(OTHER_PROFILE, TAB, async () =>
      next.core.recoverDelegateTarget(OTHER_PROFILE, TAB, "owner", claimed.sessionToken), true)).rejects.toThrow(/matching|recovery/i);
    await expect(next.core.withDelegateTargetLock(PROFILE, TAB, async () =>
      next.core.recoverDelegateTarget(PROFILE, TAB, "owner", "wrong-owner-token"), true)).rejects.toThrow(/capability/i);
    await expect(next.core.withDelegateTargetLock(PROFILE, TAB, async () =>
      next.core.recoverDelegateTarget(PROFILE, TAB, "intruder", claimed.sessionToken), true)).rejects.toThrow(/capability/i);
    const recovered = await next.core.withDelegateTargetLock(PROFILE, TAB, async () =>
      next.core.recoverDelegateTarget(PROFILE, TAB, "owner", claimed.sessionToken), true);
    expect(recovered.recoveryRequired).toBe(false);
    expect(recovered.revision).toBeGreaterThan(claimed.revision);
    expect(next.core.authorizeDelegateTarget(PROFILE, TAB, "owner", claimed.sessionToken)).toBeUndefined();
    expect(() => old.core.authorizeDelegateTarget(PROFILE, TAB, "owner", claimed.sessionToken))
      .toThrow(/fenc|unavailable|stale/i);
    expect(JSON.parse(readFileSync(join(dir, "delegate-leases.v1.json"), "utf8")).sequence)
      .toBeGreaterThan(previousSequence);
    next.core.releaseDelegateTarget(PROFILE, TAB, "owner", claimed.sessionToken);
    await expect(next.core.withDelegateTargetLock(PROFILE, TAB, async () =>
      next.core.recoverDelegateTarget(PROFILE, TAB, "owner", claimed.sessionToken), true))
      .rejects.toThrow(/matching|recovery/i);
  });

  it("preserves a crash/timeout operation marker and blocks the next epoch rather than replaying it", async () => {
    const old = await load();
    expect(old.runtime.activateDelegateLeaseRuntime(options(evidence(), true)).status).toBe("ACTIVE");
    await expect(old.core.withDelegateTargetLock(PROFILE, TAB, async () => {
      throw Error("DELEGATE_TIMEOUT: unknown browser write outcome");
    })).rejects.toThrow(/TIMEOUT/);
    expect(old.runtime.getDelegateLeaseRuntimeStatus().status).toBe("BLOCKED");
    expect(existsSync(join(dir, "delegate-core-operation.v1.lock"))).toBe(true);
    vi.resetModules();
    const next = await load();
    const denied = next.runtime.activateDelegateLeaseRuntime(options(
      evidence(B, { retired: () => true }),
    ));
    expect(denied.status).toBe("BLOCKED");
    expect(denied.reason).toMatch(/PENDING_WRITE|operation/i);
  });

  it("does not take over an interrupted/tampered HMAC journal", async () => {
    const old = await load();
    expect(old.runtime.activateDelegateLeaseRuntime(options(evidence(), true)).status).toBe("ACTIVE");
    old.core.claimDelegateTarget(PROFILE, TAB, "owner");
    const journal = join(dir, "delegate-leases.v1.json");
    const record = JSON.parse(readFileSync(journal, "utf8"));
    record.leases[0].agentId = "imposter";
    writeFileSync(journal, JSON.stringify(record), "utf8"); // Isolated fixture only.
    vi.resetModules();
    const next = await load();
    const denied = next.runtime.activateDelegateLeaseRuntime(options(evidence(B, { retired: () => true })));
    expect(denied.status).toBe("BLOCKED");
    expect(denied.reason).toMatch(/CORRUPT|integrity/i);
  });

  it("denies expired token recovery even after the previous writer is retired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-11-06T01:00:00.000Z"));
    const old = await load();
    expect(old.runtime.activateDelegateLeaseRuntime(options(evidence(), true)).status).toBe("ACTIVE");
    const claimed = old.core.claimDelegateTarget(PROFILE, TAB, "owner");
    vi.setSystemTime(Date.now() + 91_000);
    vi.resetModules();
    const next = await load();
    expect(next.runtime.activateDelegateLeaseRuntime(options(evidence(B, { retired: () => true }))).status).toBe("ACTIVE");
    await expect(next.core.withDelegateTargetLock(PROFILE, TAB, async () =>
      next.core.recoverDelegateTarget(PROFILE, TAB, "owner", claimed.sessionToken), true))
      .rejects.toThrow(/unexpired|capability/i);
    expect(next.core.retireExpiredDelegateLeases()).toBeUndefined();
    expect(next.core.listDelegateSessions()).toHaveLength(0);
  });

  it("routes explicit recover_session without debugger attach and refuses repeated token replay", async () => {
    let firstOwned = true;
    const first = await load();
    expect(first.runtime.activateDelegateLeaseRuntime(options(evidence(A, { live: () => firstOwned }), true)).status).toBe("ACTIVE");
    const owner = first.core.claimDelegateTarget(PROFILE, TAB, "owner");
    firstOwned = false;
    vi.resetModules();
    const next = await load();
    expect(next.runtime.activateDelegateLeaseRuntime(options(evidence(B, { retired: old => old === A }))).status).toBe("ACTIVE");
    const cdp = await import("../src/core/delegate/cdpTransport.js");
    const attach = vi.spyOn(cdp.delegateCdpTransport, "attach");
    await expect(cdp.executeDelegateChromeCommand("recover_session",
      { agentId: "owner", sessionToken: owner.sessionToken }, {}))
      .rejects.toThrow(/explicit exact/i);
    const recovered = JSON.parse(await cdp.executeDelegateChromeCommand("recover_session",
      { agentId: "owner", sessionToken: owner.sessionToken,
        delegateClientId: PROFILE, delegateTabId: TAB }, {}));
    expect(recovered.status).toBe("recovered");
    expect(recovered.recoveryRequired).toBe(false);
    expect(attach).not.toHaveBeenCalled();
    await expect(cdp.executeDelegateChromeCommand("recover_session",
      { agentId: "owner", sessionToken: owner.sessionToken,
        delegateClientId: PROFILE, delegateTabId: TAB }, {}))
      .rejects.toThrow(/already recovered|replay/i);
    expect(next.core.authorizeDelegateTarget(PROFILE, TAB, "owner", owner.sessionToken)).toBeUndefined();
  });

  it("does not permit a previously used epoch to return after successive Core owners", async () => {
    let firstOwned = true;
    const first = await load();
    expect(first.runtime.activateDelegateLeaseRuntime(options(evidence(A, { live: () => firstOwned }), true)).status).toBe("ACTIVE");
    const owner = first.core.claimDelegateTarget(PROFILE, TAB, "owner");
    firstOwned = false;
    vi.resetModules();
    let secondOwned = true;
    const second = await load();
    expect(second.runtime.activateDelegateLeaseRuntime(options(evidence(B, {
      live: () => secondOwned, retired: epoch => epoch === A,
    }))).status).toBe("ACTIVE");
    await second.core.withDelegateTargetLock(PROFILE, TAB, async () =>
      second.core.recoverDelegateTarget(PROFILE, TAB, "owner", owner.sessionToken), true);
    secondOwned = false;
    vi.resetModules();
    const replayed = await load();
    const status = replayed.runtime.activateDelegateLeaseRuntime(options(evidence(A, {
      retired: epoch => epoch === B,
    })));
    expect(status.status).toBe("BLOCKED");
    expect(status.reason).toMatch(/EPOCH_REPLAY|already been used/i);
  });

  it("blocks bootstrap gate collisions and refuses to break ambiguous prior locks", async () => {
    writeFileSync(join(dir, "delegate-core-bootstrap.v1.lock"), "simulated-other-process");
    const first = await load();
    const rejected = first.runtime.activateDelegateLeaseRuntime(options(evidence(), true));
    expect(rejected.status).toBe("BLOCKED");
    expect(existsSync(join(dir, "delegate-leases.v1.json"))).toBe(false);
    expect(existsSync(join(dir, "delegate-core-bootstrap.v1.lock"))).toBe(true);
  });

  it("fails closed on interrupted partial journal state, even with proven prior Core retirement", async () => {
    const first = await load();
    expect(first.runtime.activateDelegateLeaseRuntime(options(evidence(), true)).status).toBe("ACTIVE");
    first.core.claimDelegateTarget(PROFILE, TAB, "owner");
    writeFileSync(join(dir, "delegate-leases.v1.json"), "{\"schema\":1,\"sequence\":");
    vi.resetModules();
    const second = await load();
    const result = second.runtime.activateDelegateLeaseRuntime(options(evidence(B, { retired: () => true })));
    expect(result.status).toBe("BLOCKED");
    expect(result.reason).toMatch(/CORRUPT/i);
  });

  it("denies a Core generation whose supervisor owner attestation fails", async () => {
    const first = await load();
    const proof = evidence(A, { live: () => false });
    const rejected = first.runtime.activateDelegateLeaseRuntime(options(proof, true));
    expect(rejected.status).toBe("BLOCKED");
    expect(rejected.reason).toMatch(/ownership|evidence/i);
    expect(existsSync(join(dir, "delegate-leases.v1.json"))).toBe(false);
  });

  it("blocks direct low-level mutating RPCs outside a fenced coordinator operation", async () => {
    const { runtime } = await load();
    expect(runtime.activateDelegateLeaseRuntime(options(evidence(), true)).status).toBe("ACTIVE");
    const cdp = await import("../src/core/delegate/cdpTransport.js");
    await expect(cdp.delegateCdpTransport.rpc("delegate.cdp.command", { tabId: TAB }, undefined, PROFILE))
      .rejects.toThrow(/active fenced coordinator operation/i);
    await expect(cdp.delegateCdpTransport.rpc("delegate.cdp.attach", { tabId: TAB }, undefined, PROFILE))
      .rejects.toThrow(/active fenced coordinator operation/i);
    await expect(cdp.delegateCdpTransport.rpc("delegate.cdp.detach", { tabId: TAB }, undefined, PROFILE))
      .rejects.toThrow(/active fenced coordinator operation/i);
  });

  it("retains pending marker when a coordinator returns with an orphaned in-flight RPC", async () => {
    const { runtime, core } = await load();
    expect(runtime.activateDelegateLeaseRuntime(options(evidence(), true)).status).toBe("ACTIVE");
    await expect(core.withDelegateTargetLock(PROFILE, TAB, async () => {
      core.enterDelegateProtectedCdpRpc(); // Fake forgotten async RPC; no live extension.
      return "returned before the RPC completed";
    })).rejects.toThrow(/still in flight/i);
    expect(runtime.getDelegateLeaseRuntimeStatus().status).toBe("BLOCKED");
    expect(existsSync(join(dir, "delegate-core-operation.v1.lock"))).toBe(true);
  });
});
