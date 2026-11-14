import { describe, expect, it, vi } from "vitest";
import {
  RemoteLiveSessionPolicy, REMOTE_HOST_CHALLENGE_TTL_MS,
  REMOTE_SESSION_TTL_MS, REMOTE_VIEWER_CHALLENGE_TTL_MS,
  type RemoteHostIntent, type RemoteLiveVerifiers, type RemoteTransportEvidence,
} from "../../src/core/desktopUi/remoteSessionPolicy.js";

export const intent: RemoteHostIntent = {
  hostId: "owner-host-01", viewerId: "owner-viewer-01",
  expectedOrigin: "https://private.example.test",
  window: {
    pid: 2411, nativeId: "hwnd:0xabc", title: "Private editor",
    application: "Editor", bounds: { x: -120, y: 20, width: 1100, height: 700 },
  },
};
export const transport: RemoteTransportEvidence = {
  connectionId: "private-socket-123", authenticatedViewerId: intent.viewerId,
  origin: intent.expectedOrigin, tlsVerified: true,
  privateIngressVerified: true, publicTunnelDetected: false,
  forwardedHeadersPresent: false,
};

export function fixture() {
  let now = 10_000;
  const verifyHostApproval = vi.fn(async () => true);
  const verifyViewerProof = vi.fn(async () => true);
  const closed = vi.fn();
  const policy = new RemoteLiveSessionPolicy(
    { verifyHostApproval, verifyViewerProof } satisfies RemoteLiveVerifiers,
    () => now, closed,
  );
  return {
    policy, verifyHostApproval, verifyViewerProof, closed,
    time: () => now, advance: (ms: number) => { now += ms; },
    async approved() {
      const challenge = policy.beginNativeApproval(intent);
      const approved = await policy.approveNative({ nonce: challenge.nonce, proof: "native-proof" });
      return approved;
    },
    async attached() {
      const approved = await this.approved();
      const viewer = await policy.attachViewer({
        sessionId: approved.sessionId, proof: "viewer-signed-proof", transport,
      });
      return { ...approved, ...viewer, transport };
    },
  };
}

describe("remote desktop live — separately approved host and viewer", () => {
  it("requires a complete exact-window pin and private HTTPS origin", () => {
    const { policy } = fixture();
    for (const origin of [
      "http://private.example.test", "https://private.example.test/path",
      "https://localhost", "https://127.0.0.1", "https://private.example.test/",
      "https://private.example.test?token=secret",
    ]) expect(() => policy.beginNativeApproval({ ...intent, expectedOrigin: origin }))
      .toThrow();
    expect(() => policy.beginNativeApproval({
      ...intent, window: { ...intent.window, bounds: { ...intent.window.bounds, width: 0 } },
    })).toThrow();
    expect(() => policy.beginNativeApproval({
      ...intent, window: { ...intent.window, nativeId: "" },
    })).toThrow();
  });

  it("burns native nonce even on fabricated consent and refuses replay", async () => {
    const { policy, verifyHostApproval } = fixture();
    const challenge = policy.beginNativeApproval(intent);
    expect(challenge.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(challenge.expiresAt).toBe(10_000 + REMOTE_HOST_CHALLENGE_TTL_MS);
    await expect(policy.approveNative({ nonce: "0".repeat(64), proof: "fake-native-proof" }))
      .rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    await expect(policy.approveNative({ nonce: challenge.nonce, proof: "native-proof" }))
      .rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    expect(verifyHostApproval).not.toHaveBeenCalled();
  });

  it("only independent native verification mints a short-lived host token", async () => {
    const f = fixture();
    f.verifyHostApproval.mockResolvedValue(false);
    const first = f.policy.beginNativeApproval(intent);
    await expect(f.policy.approveNative({ nonce: first.nonce, proof: "native-proof" }))
      .rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
    f.verifyHostApproval.mockResolvedValue(true);
    const second = f.policy.beginNativeApproval(intent);
    const approved = await f.policy.approveNative({ nonce: second.nonce, proof: "native-proof" });
    expect(approved.hostToken).toMatch(/^[a-f0-9]{64}$/);
    expect(approved.viewerChallenge).toMatch(/^[a-f0-9]{64}$/);
    expect(approved.sessionId).not.toBe(approved.hostToken);
    expect(approved.hostToken).not.toBe(approved.viewerChallenge);
    expect(approved.expiresAt).toBe(f.time() + REMOTE_SESSION_TTL_MS);
    expect(f.verifyHostApproval).toHaveBeenCalledWith(expect.objectContaining({
      hostId: intent.hostId, viewerId: intent.viewerId, expectedOrigin: intent.expectedOrigin,
      window: intent.window, nonce: second.nonce,
    }));
    await expect(f.policy.approveNative({ nonce: second.nonce, proof: "native-proof" }))
      .rejects.toMatchObject({ code: "BUSY" });
  });

  it("burns viewer proof once and binds the authenticated connection and CSRF", async () => {
    const f = fixture();
    const approved = await f.approved();
    expect(() => f.policy.authorizeViewer({
      sessionId: approved.sessionId, csrfToken: approved.hostToken, transport,
    })).toThrow();
    const viewer = await f.policy.attachViewer({
      sessionId: approved.sessionId, proof: "viewer-signed-proof", transport,
    });
    expect(viewer.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    expect(viewer.csrfToken).not.toBe(approved.hostToken);
    expect(f.verifyViewerProof).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: approved.sessionId, nonce: approved.viewerChallenge,
      viewerId: intent.viewerId, hostId: intent.hostId,
      expectedOrigin: intent.expectedOrigin, connectionId: transport.connectionId,
    }));
    expect(f.policy.authorizeViewer({
      sessionId: approved.sessionId, csrfToken: viewer.csrfToken, transport,
    }).window).toEqual(intent.window);
    await expect(f.policy.attachViewer({
      sessionId: approved.sessionId, proof: "viewer-signed-proof", transport,
    })).rejects.toMatchObject({ code: "SESSION_DENIED" });
    for (const invalid of [
      { ...transport, connectionId: "private-socket-321" },
      { ...transport, origin: "https://evil.example" },
      { ...transport, authenticatedViewerId: "another-viewer" },
      { ...transport, tlsVerified: false },
      { ...transport, privateIngressVerified: false },
      { ...transport, publicTunnelDetected: true },
      { ...transport, forwardedHeadersPresent: true },
    ]) expect(() => f.policy.authorizeViewer({
      sessionId: approved.sessionId, csrfToken: viewer.csrfToken, transport: invalid,
    })).toThrow();
    expect(() => f.policy.authorizeViewer({
      sessionId: approved.sessionId, csrfToken: approved.hostToken, transport,
    })).toThrow();
  });

  it("never permits public tunnel, forwarded headers, plaintext, or unpaired viewer", async () => {
    for (const overrides of [
      { privateIngressVerified: false }, { publicTunnelDetected: true },
      { forwardedHeadersPresent: true },
      { tlsVerified: false }, { authenticatedViewerId: "attacker-001" },
      { origin: "https://another.example" },
    ]) {
      const f = fixture();
      const approved = await f.approved();
      await expect(f.policy.attachViewer({
        sessionId: approved.sessionId, proof: "viewer-signed-proof",
        transport: { ...transport, ...overrides },
      })).rejects.toMatchObject({ code: "TRANSPORT_DENIED" });
      expect(f.verifyViewerProof).not.toHaveBeenCalled();
    }
  });

  it("fails closed if viewer proof fails, with no second chance", async () => {
    const f = fixture();
    f.verifyViewerProof.mockResolvedValue(false);
    const approved = await f.approved();
    await expect(f.policy.attachViewer({
      sessionId: approved.sessionId, proof: "fake-viewer", transport,
    })).rejects.toMatchObject({ code: "VIEWER_PROOF_REQUIRED" });
    expect(f.closed).toHaveBeenCalledTimes(1);
    await expect(f.policy.attachViewer({
      sessionId: approved.sessionId, proof: "real-viewer", transport,
    })).rejects.toMatchObject({ code: "SESSION_DENIED" });
  });

  it("one owner-viewer session at a time, host-only revoke, no reattach", async () => {
    const f = fixture();
    const attached = await f.attached();
    expect(() => f.policy.beginNativeApproval(intent)).toThrow();
    expect(() => f.policy.revokeByHost({
      sessionId: attached.sessionId, hostToken: attached.csrfToken,
    })).toThrow();
    f.policy.revokeByHost({ sessionId: attached.sessionId, hostToken: attached.hostToken });
    expect(f.closed).toHaveBeenCalledTimes(1);
    expect(() => f.policy.authorizeViewer({
      sessionId: attached.sessionId, csrfToken: attached.csrfToken, transport,
    })).toThrow();
    expect(() => f.policy.revokeByHost({
      sessionId: attached.sessionId, hostToken: attached.hostToken,
    })).toThrow();
    const restarted = await f.approved();
    expect(restarted.sessionId).not.toBe(attached.sessionId);
  });

  it("expires host challenge, viewer challenge, and active session", async () => {
    const host = fixture();
    const challenge = host.policy.beginNativeApproval(intent);
    host.advance(REMOTE_HOST_CHALLENGE_TTL_MS);
    await expect(host.policy.approveNative({
      nonce: challenge.nonce, proof: "native-proof",
    })).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });

    const viewer = fixture();
    const approved = await viewer.approved();
    viewer.advance(REMOTE_VIEWER_CHALLENGE_TTL_MS);
    await expect(viewer.policy.attachViewer({
      sessionId: approved.sessionId, proof: "viewer-signed-proof", transport,
    })).rejects.toMatchObject({ code: "SESSION_DENIED" });
    expect(viewer.closed).toHaveBeenCalledOnce();

    const active = fixture();
    const connected = await active.attached();
    active.advance(REMOTE_SESSION_TTL_MS);
    expect(() => active.policy.authorizeViewer({
      sessionId: connected.sessionId, csrfToken: connected.csrfToken, transport,
    })).toThrow();
    expect(active.closed).toHaveBeenCalledOnce();
  });

  it("revocation while native or viewer verification is pending never revives consent", async () => {
    const f = fixture();
    let finish!: (ok: boolean) => void;
    f.verifyViewerProof.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const approved = await f.approved();
    const pending = f.policy.attachViewer({
      sessionId: approved.sessionId, proof: "viewer-signed-proof", transport,
    });
    f.policy.revokeByHost({ sessionId: approved.sessionId, hostToken: approved.hostToken });
    finish(true);
    await expect(pending).rejects.toMatchObject({ code: "VIEWER_PROOF_REQUIRED" });
    expect(f.closed).toHaveBeenCalledOnce();
  });
});
