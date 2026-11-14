import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RemoteControlAuthority, REMOTE_CONTROL_TTL_MS,
  REMOTE_CONTROL_CHALLENGE_TTL_MS,
  type RemoteControlChallenge, type RemoteHostScope,
  type RemotePrincipal, type RemoteControlOperation,
} from "../../src/core/desktopUi/remoteControlAuthority.js";

const secret = Buffer.from("97".repeat(32), "hex");
const caller: RemotePrincipal = {
  principalId: "authenticated-person", connectionId: "wss-authenticated-1",
  viewSessionId: "host-pinned-viewer",
};
const other: RemotePrincipal = { ...caller, connectionId: "another-connection" };
const scope: RemoteHostScope = {
  platform: "win32", pid: 4192, nativeId: "hwnd:321",
  processBirthId: "windows-process-created-at-123",
  osUserId: "S-1-5-21-test-user", hostSessionId: "host-logon-session",
  hostGeneration: 77, viewSessionId: caller.viewSessionId,
};

function signature(challenge: RemoteControlChallenge): string {
  return createHmac("sha256", secret).update(JSON.stringify(challenge)).digest("hex");
}
function fixture() {
  let now = 1_800_000_000_000;
  let pinned: RemoteHostScope | null = { ...scope };
  let allow = true;
  const checks: RemoteControlOperation[] = [];
  const trust = {
    currentScope: () => pinned,
    authorizeCaller: (_caller: RemotePrincipal, operation: RemoteControlOperation) => {
      checks.push(operation);
      return allow;
    },
    verifyNativeControlApproval: (challenge: RemoteControlChallenge, proof: unknown) =>
      typeof proof === "string" && proof === signature(challenge),
  };
  const authority = new RemoteControlAuthority(trust, () => now);
  const approve = (remote: RemotePrincipal = caller) => {
    const challenge = authority.request(remote);
    return authority.confirmNativeApproval(challenge.nonce, signature(challenge));
  };
  return {
    authority, approve, checks, get now() { return now; },
    set now(value: number) { now = value; },
    get pinned() { return pinned; },
    set pinned(value: RemoteHostScope | null) { pinned = value; },
    set allow(value: boolean) { allow = value; },
  };
}

describe("Desktop Live remote control — host-only approval and scope", () => {
  it("keeps preview/viewing powerless until a separate native approval", () => {
    const f = fixture();
    expect(() => f.authority.beginAction(caller, "0".repeat(64), "click", 1))
      .toThrow(/not approved/i);
    const challenge = f.authority.request(caller);
    expect(challenge.scope).toEqual(scope);
    expect(challenge.kinds).toEqual(["click", "type", "key", "scroll"]);
    expect(() => f.authority.beginAction(caller, "0".repeat(64), "click", 1))
      .toThrow(/not approved/i);
    expect(() => f.authority.confirmNativeApproval(challenge.nonce, { consent: true }))
      .toThrow(/approval/i);
    expect(() => f.authority.confirmNativeApproval(challenge.nonce, signature(challenge)))
      .toThrow(/approval/i);
  });

  it("binds a single-use signed human approval to the exact host scope and caller", () => {
    const f = fixture();
    const challenge = f.authority.request(caller);
    expect(challenge.expiresAt - challenge.issuedAt)
      .toBe(REMOTE_CONTROL_CHALLENGE_TTL_MS);
    const grant = f.authority.confirmNativeApproval(challenge.nonce, signature(challenge));
    expect(grant.expiresAt - f.now).toBe(REMOTE_CONTROL_TTL_MS);
    expect(grant.token).toMatch(/^[a-f0-9]{64}$/);
    expect(() => f.authority.confirmNativeApproval(challenge.nonce, signature(challenge)))
      .toThrow(/approval/);
    expect(() => f.authority.request(other)).toThrow(/already exists/);
    expect(() => f.authority.beginAction(other, grant.token, "click", 1))
      .toThrow(/different authenticated controller/);
    const lease = f.authority.beginAction(caller, grant.token, "click", 1);
    lease.consumeForNativeDispatch();
    expect(() => lease.consumeForNativeDispatch()).toThrow(/single use/);
    lease.finish();
    expect(f.checks).toContain("click");
  });

  it("rejects replays, forged proofs and wrong challenges without resurrecting consent", () => {
    const f = fixture();
    const c = f.authority.request(caller);
    expect(() => f.authority.confirmNativeApproval("x".repeat(64), signature(c))).toThrow();
    expect(() => f.authority.confirmNativeApproval(c.nonce, signature(c))).toThrow();
    const f2 = fixture();
    const c2 = f2.authority.request(caller);
    const f3 = fixture();
    expect(() => f3.authority.confirmNativeApproval(c2.nonce, signature(c2))).toThrow();
    expect(() => f2.authority.confirmNativeApproval(c2.nonce, "0".repeat(64))).toThrow();
  });

  it("expires approval challenges and granted input after five minutes", () => {
    const f = fixture();
    const challenge = f.authority.request(caller);
    f.now = challenge.expiresAt;
    expect(() => f.authority.confirmNativeApproval(challenge.nonce, signature(challenge)))
      .toThrow(/expired/);
    const f2 = fixture();
    const grant = f2.approve();
    f2.now = grant.expiresAt;
    expect(() => f2.authority.beginAction(caller, grant.token, "key", 1))
      .toThrow(/expired/);
    expect(() => f2.authority.beginAction(caller, grant.token, "key", 1)).toThrow();
  });

  it.each([
    ["PID", { pid: 4000 }],
    ["native window", { nativeId: "hwnd:999" }],
    ["process birth (PID reuse)", { processBirthId: "recycled" }],
    ["OS user", { osUserId: "another-user" }],
    ["host session", { hostSessionId: "another-session" }],
    ["host generation", { hostGeneration: 78 }],
    ["viewer session", { viewSessionId: "different-viewer" }],
    ["platform", { platform: "linux" as const }],
  ])("denies changed %s during native approval", (_label, difference) => {
    const f = fixture();
    const challenge = f.authority.request(caller);
    f.pinned = { ...scope, ...difference };
    expect(() => f.authority.confirmNativeApproval(challenge.nonce, signature(challenge)))
      .toThrow(/does not match/);
  });

  it("revokes on host identity drift, RBAC denial, and disconnect", () => {
    const f = fixture();
    const grant = f.approve();
    f.pinned = { ...scope, processBirthId: "another-process" };
    expect(() => f.authority.beginAction(caller, grant.token, "scroll", 1))
      .toThrow(/identity changed/);
    f.pinned = { ...scope };
    expect(() => f.authority.beginAction(caller, grant.token, "scroll", 1)).toThrow();
    const next = f.approve();
    f.allow = false;
    expect(() => f.authority.beginAction(caller, next.token, "type", 1))
      .toThrow(/RBAC/);
    f.allow = true;
    const next2 = f.approve();
    f.authority.disconnect(caller.connectionId);
    expect(() => f.authority.beginAction(caller, next2.token, "key", 1)).toThrow();
    const next3 = f.approve();
    f.authority.viewerDisconnected(caller.viewSessionId);
    expect(() => f.authority.beginAction(caller, next3.token, "key", 1)).toThrow();
  });

  it("enforces one action in flight, strict sequence and immediate human takeover", () => {
    const f = fixture();
    const grant = f.approve();
    const first = f.authority.beginAction(caller, grant.token, "click", 1);
    expect(() => f.authority.beginAction(caller, grant.token, "click", 2))
      .toThrow(/in progress/);
    f.authority.humanTakeover();
    expect(first.signal.aborted).toBe(true);
    expect(() => first.consumeForNativeDispatch()).toThrow();
    first.finish();
    expect(() => f.authority.beginAction(caller, grant.token, "click", 2)).toThrow();
    expect(() => f.authority.request(caller)).toThrow(/takeover/);
  });

  it("never accepts repeated/malformed sequence, and aborts leases on host restart", () => {
    const f = fixture();
    const grant = f.approve();
    expect(() => f.authority.beginAction(caller, grant.token, "click", 2)).toThrow(/sequence/);
    const first = f.authority.beginAction(caller, grant.token, "click", 1);
    first.finish();
    expect(() => f.authority.beginAction(caller, grant.token, "click", 1)).toThrow(/sequence/);
    const second = f.authority.beginAction(caller, grant.token, "scroll", 2);
    f.authority.hostRestarted();
    expect(second.signal.aborted).toBe(true);
    expect(() => second.assertLive()).toThrow();
  });

  it("expires a stalled native-action lease without allowing replay", () => {
    const f = fixture();
    const grant = f.approve();
    const lease = f.authority.beginAction(caller, grant.token, "key", 1);
    f.now += 3_000;
    expect(() => lease.consumeForNativeDispatch()).toThrow(/expired/);
    lease.finish();
    expect(() => f.authority.beginAction(caller, grant.token, "key", 1)).toThrow(/sequence/);
  });

  it("reaps an expired, unused challenge and allows a new attended approval", () => {
    const f = fixture();
    const pending = f.authority.request(caller);
    f.now = pending.expiresAt;
    const renewed = f.authority.request(caller);
    expect(renewed.nonce).not.toBe(pending.nonce);
    expect(() => f.authority.confirmNativeApproval(pending.nonce, signature(pending)))
      .toThrow(/approval/);
  });

  it("revokes a previously approved token when the host clock moves backwards", () => {
    const f = fixture();
    const approved = f.approve();
    f.now -= 1;
    expect(() => f.authority.beginAction(caller, approved.token, "click", 1))
      .toThrow(/clock/);
    f.now += 1;
    expect(() => f.authority.beginAction(caller, approved.token, "click", 1))
      .toThrow(/not approved/);
  });

  it("aborts a stalled action and permits only the next sequence after lease expiry", () => {
    const f = fixture();
    const approved = f.approve();
    const stuck = f.authority.beginAction(caller, approved.token, "key", 1);
    f.now += 3_000;
    const successor = f.authority.beginAction(caller, approved.token, "key", 2);
    expect(stuck.signal.aborted).toBe(true);
    expect(() => stuck.consumeForNativeDispatch()).toThrow();
    successor.finish();
  });

  it("never grants control when takeover occurs during a native approval callback", () => {
    let authority!: RemoteControlAuthority;
    const host = {
      currentScope: () => scope,
      authorizeCaller: () => true,
      verifyNativeControlApproval: () => {
        authority.humanTakeover();
        return true;
      },
    };
    authority = new RemoteControlAuthority(host, () => 100_000);
    const pending = authority.request(caller);
    expect(() => authority.confirmNativeApproval(pending.nonce, "native-signed-proof"))
      .toThrow(/expired|changed/);
    expect(() => authority.request(caller)).toThrow(/takeover/);
  });

  it("does not issue a challenge when takeover happens during RBAC verification", () => {
    let authority!: RemoteControlAuthority;
    const host = {
      currentScope: () => scope,
      authorizeCaller: () => {
        authority.humanTakeover();
        return true;
      },
      verifyNativeControlApproval: () => true,
    };
    authority = new RemoteControlAuthority(host, () => 100_000);
    expect(() => authority.request(caller)).toThrow(/not authorized/);
    expect(() => authority.request(caller)).toThrow(/takeover/);
  });

  it("rejects unsupported direct action kinds even with an otherwise valid token", () => {
    const f = fixture();
    const approved = f.approve();
    expect(() => f.authority.beginAction(caller, approved.token,
      "clipboard" as "click", 1)).toThrow(/Unsupported/);
  });

  it("fails closed for missing host identity, bad caller, and RBAC denial", () => {
    const f = fixture();
    f.pinned = null;
    expect(() => f.authority.request(caller)).toThrow(/host/);
    f.pinned = scope;
    f.allow = false;
    expect(() => f.authority.request(caller)).toThrow(/not authorized/);
    f.allow = true;
    expect(() => f.authority.request({ ...caller, viewSessionId: "other-view" })).toThrow();
    expect(() => f.authority.request({ ...caller, connectionId: "" })).toThrow();
  });
});
