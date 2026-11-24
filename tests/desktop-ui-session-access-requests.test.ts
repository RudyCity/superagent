import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  desktopUiSessionApprovalMessage,
  DesktopUiSessionAccessRequestManager,
} from "../src/core/desktopUi/desktopUiSessionAccessRequests.js";

const key = Buffer.alloc(32, 7);
const target = {
  principalId: "local-agent",
  pid: 1234,
  nativeId: "hwnd-1234",
  title: "Editor",
  application: "Code Editor",
  accessMode: "view" as const,
  ttlMs: 300_000,
  reason: "Review the active project window",
};

function proof(
  request: ReturnType<DesktopUiSessionAccessRequestManager["create"]>,
  nonce: string,
  decision: "approve" | "deny",
): string {
  return createHmac("sha256", key)
    .update(desktopUiSessionApprovalMessage(request, decision, nonce), "utf8")
    .digest("hex");
}

describe("Desktop UI session access requests", () => {
  it("keeps agent requests pending until an exact native proof is submitted", () => {
    const manager = new DesktopUiSessionAccessRequestManager(() => 1_000, () => key);
    const request = manager.create(target);

    expect(request.status).toBe("pending");
    expect(manager.list()).toHaveLength(1);

    const challenge = manager.issueChallenge(request.requestId, "approve");
    const approved = manager.decide({
      requestId: request.requestId,
      decision: "approve",
      nonce: challenge.nonce,
      mac: proof(request, challenge.nonce, "approve"),
    });
    expect(approved.status).toBe("approved");
    expect(manager.list()[0].status).toBe("approved");
  });

  it("burns challenges and rejects a proof bound to changed scope or target", () => {
    const manager = new DesktopUiSessionAccessRequestManager(() => 2_000, () => key);
    const request = manager.create(target);
    const challenge = manager.issueChallenge(request.requestId, "approve");
    const changed = { ...request, title: "Different window" };
    const forgedMac = createHmac("sha256", key)
      .update(desktopUiSessionApprovalMessage(changed, "approve", challenge.nonce), "utf8")
      .digest("hex");

    expect(() => manager.decide({
      requestId: request.requestId,
      decision: "approve",
      nonce: challenge.nonce,
      mac: forgedMac,
    })).toThrow();
    expect(() => manager.decide({
      requestId: request.requestId,
      decision: "approve",
      nonce: challenge.nonce,
      mac: proof(request, challenge.nonce, "approve"),
    })).toThrow();
    expect(manager.list()[0].status).toBe("pending");
  });

  it("allows exactly one consumption by the requesting principal", () => {
    const manager = new DesktopUiSessionAccessRequestManager(() => 3_000, () => key);
    const request = manager.create(target);
    const challenge = manager.issueChallenge(request.requestId, "approve");
    manager.decide({
      requestId: request.requestId,
      decision: "approve",
      nonce: challenge.nonce,
      mac: proof(request, challenge.nonce, "approve"),
    });

    expect(() => manager.consumeApproved(request.requestId, "other-agent")).toThrow();
    expect(manager.consumeApproved(request.requestId, "local-agent").status).toBe("consumed");
    expect(() => manager.consumeApproved(request.requestId, "local-agent")).toThrow();
  });

  it("records denial and expires requests without granting access", () => {
    let now = 4_000;
    const manager = new DesktopUiSessionAccessRequestManager(() => now, () => key);
    const denied = manager.create(target);
    const denyChallenge = manager.issueChallenge(denied.requestId, "deny");
    manager.decide({
      requestId: denied.requestId,
      decision: "deny",
      nonce: denyChallenge.nonce,
      mac: proof(denied, denyChallenge.nonce, "deny"),
    });
    expect(manager.list()[0].status).toBe("denied");

    const expiring = manager.create({ ...target, nativeId: "hwnd-5678" });
    now += 5 * 60_000 + 1;
    expect(manager.list().find(item => item.requestId === expiring.requestId)?.status).toBe("expired");
  });

  it("expires an approved request at its original request deadline", () => {
    let now = 10_000;
    const manager = new DesktopUiSessionAccessRequestManager(() => now, () => key);
    const request = manager.create(target);
    const challenge = manager.issueChallenge(request.requestId, "approve");
    manager.decide({
      requestId: request.requestId,
      decision: "approve",
      nonce: challenge.nonce,
      mac: proof(request, challenge.nonce, "approve"),
    });

    now += 5 * 60_000 + 1;
    expect(manager.list()[0].status).toBe("expired");
    expect(() => manager.consumeApproved(request.requestId, "local-agent")).toThrow();
  });

  it("deduplicates identical pending requests and validates scopes and bounds", () => {
    const manager = new DesktopUiSessionAccessRequestManager(() => 5_000, () => key);
    const request = manager.create(target);
    expect(manager.create(target).requestId).toBe(request.requestId);
    expect(() => manager.create({ ...target, accessMode: "admin" as any })).toThrow();
    expect(() => manager.create({ ...target, ttlMs: 31 * 60_000 })).toThrow();
    expect(() => manager.create({ ...target, nativeId: "bad\nwindow" })).toThrow();
  });
});
