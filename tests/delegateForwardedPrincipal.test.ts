import { describe, expect, it, vi } from "vitest";
import {
  canonicalDelegateForwardedJson,
  createDelegateForwardedSigner,
  createDelegateForwardedVerifier,
  delegateForwardedTarget,
  generateDelegateForwardedChannelMaterial,
  installDelegateForwardedVerifier,
  runWithTrustedDelegateForwardingConnection,
  signDelegateForwardedRequest,
  withVerifiedDelegateForwardedPrincipal,
  type DelegateForwardedRequest,
} from "../src/core/browserTransport/delegateForwardedPrincipal.js";
import {
  getDelegateMcpPrincipalId,
  runWithAuthenticatedDelegatePrincipal,
} from "../src/core/browserTransport/delegatePrincipalPolicy.js";

const sessionA = {
  sessionId: "6d699c47-5ab2-49dd-9d2e-6a015356a111",
  mode: "oauth" as const, subject: "user-a",
};
const sessionB = {
  sessionId: "7138fcbe-25e0-4ec6-a276-385688f6b222",
  mode: "oauth" as const, subject: "user-b",
};
const reconnectA = {
  sessionId: "7356e73e-18ab-4937-a723-3ca118b8c333",
  mode: "oauth" as const, subject: sessionA.subject,
};
const baseArgs = {
  command: "claim_target", transport: "delegate",
  delegateClientId: "profileAlpha123", delegateTabId: 91231,
  targetId: "delegate:profileAlpha123:91231",
  payload: { sessionToken: "opaque-token", revision: 7 },
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sign = (identity: typeof sessionA, name: string, args: Record<string, unknown>,
  now?: number, material = generateDelegateForwardedChannelMaterial()) => {
  const signer = createDelegateForwardedSigner(material);
  return {
    material,
    body: runWithAuthenticatedDelegatePrincipal(identity, () => signer(name, args, identity, now)),
  };
};

describe("secure MCP -> Core Delegate forwarded-principal protocol (pure, no live Core)", () => {
  it("signs only in an authenticated MCP principal scope, never from client arguments", () => {
    const material = generateDelegateForwardedChannelMaterial();
    const signer = createDelegateForwardedSigner(material);
    expect(() => signer("superagent_chrome_cdp", baseArgs, sessionA))
      .toThrow("DELEGATE_FORWARD_PRINCIPAL_REQUIRED");
    expect(() => runWithAuthenticatedDelegatePrincipal(sessionA, () =>
      signer("superagent_chrome_cdp", baseArgs, sessionB)))
      .toThrow("DELEGATE_FORWARD_PRINCIPAL_REQUIRED");
    const request = runWithAuthenticatedDelegatePrincipal(sessionA, () =>
      signer("superagent_chrome_cdp", baseArgs, sessionA));
    expect(request.attestation.principalId).toMatch(/^mcp-[a-f0-9]{32}$/);
    expect(JSON.stringify(request)).not.toContain(sessionA.subject);
    expect(JSON.stringify(request)).not.toContain(Buffer.from(material.key).toString("hex"));
    expect(createDelegateForwardedVerifier(material)(request).principalId)
      .toBe(request.attestation.principalId);
  });

  it("signs actual command, tab, profile, transport, target, subject and exact canonical payload", () => {
    const { material, body } = sign(sessionA, "superagent_chrome_cdp", baseArgs);
    const verified = createDelegateForwardedVerifier(material)(body);
    expect(verified.name).toBe("superagent_chrome_cdp");
    expect(verified.mode).toBe("oauth");
    expect(verified.connectionSessionId).toBe(sessionA.sessionId);
    expect(verified.target).toEqual({
      command: "claim_target", clientId: "profileAlpha123", tabId: 91231,
      targetId: "delegate:profileAlpha123:91231", transport: "delegate",
    });
    expect(verified.subjectHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.attestation.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.attestation.mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects replay including after the result is uncertain; separate fresh nonces succeed", () => {
    const material = generateDelegateForwardedChannelMaterial();
    const verifier = createDelegateForwardedVerifier(material);
    const signer = createDelegateForwardedSigner(material);
    const one = runWithAuthenticatedDelegatePrincipal(sessionA, () =>
      signer("superagent_chrome_cdp", baseArgs, sessionA));
    const two = runWithAuthenticatedDelegatePrincipal(sessionA, () =>
      signer("superagent_chrome_cdp", baseArgs, sessionA));
    expect(verifier(one).principalId).toBe(one.attestation.principalId);
    expect(() => verifier(one)).toThrow("DELEGATE_FORWARD_REPLAY");
    expect(verifier(two).principalId).toBe(two.attestation.principalId);
  });

  it("rejects unsigned request, fabricated identity, missing MAC and unsolicited envelope keys", () => {
    const { material, body } = sign(sessionA, "superagent_chrome_cdp", baseArgs);
    const verifier = createDelegateForwardedVerifier(material);
    expect(() => verifier({ name: body.name, arguments: body.arguments })).toThrow();
    const fabricated = clone(body);
    fabricated.attestation.principalId = "mcp-" + "f".repeat(32);
    expect(() => verifier(fabricated)).toThrow();
    const missingMac = clone(body) as any;
    delete missingMac.attestation.mac;
    expect(() => verifier(missingMac)).toThrow();
    const extra = { ...clone(body), agentId: "owner" };
    expect(() => verifier(extra)).toThrow();
    expect(verifier(body).principalId).toBe(body.attestation.principalId);
  });

  it("rejects substituted command, client profile, tab, targetId, transport, and payload content", () => {
    const { material, body } = sign(sessionA, "superagent_chrome_cdp", baseArgs);
    for (const mutate of [
      (x: any) => { x.arguments.command = "navigate"; },
      (x: any) => { x.arguments.delegateClientId = "profileBravo123"; },
      (x: any) => { x.arguments.delegateTabId = 91232; },
      (x: any) => { x.arguments.targetId = "delegate:profileBravo123:91231"; },
      (x: any) => { x.arguments.transport = "managed"; },
      (x: any) => { x.arguments.payload.sessionToken = "stolen"; },
      (x: any) => { x.arguments.payload.revision = 8; },
      (x: any) => { x.arguments.agentId = body.attestation.principalId; },
      (x: any) => { x.name = "superagent_chrome_vision"; },
    ]) {
      const tampered = clone(body);
      mutate(tampered);
      expect(() => createDelegateForwardedVerifier(material)(tampered)).toThrow();
    }
  });

  it("rejects attacker-modified authenticated principal, session, mode, timestamp and nonce", () => {
    const { material, body } = sign(sessionA, "superagent_chrome_cdp", baseArgs);
    for (const mutate of [
      (x: any) => { x.attestation.sessionId = sessionB.sessionId; },
      (x: any) => { x.attestation.subjectHash = "f".repeat(64); },
      (x: any) => { x.attestation.mode = "static-bearer"; },
      (x: any) => { x.attestation.issuedAt++; },
      (x: any) => { x.attestation.nonce = "a".repeat(32); },
      (x: any) => { x.attestation.mac = "A".repeat(43); },
      (x: any) => { x.attestation.target.clientId = "profileBravo123"; },
      (x: any) => { x.attestation.target.tabId = 91232; },
    ]) {
      const tampered = clone(body);
      mutate(tampered);
      expect(() => createDelegateForwardedVerifier(material)(tampered)).toThrow();
    }
  });

  it("keeps sessions separate for two orchestrators, and reconnect creates a new principal", () => {
    const material = generateDelegateForwardedChannelMaterial();
    const signer = createDelegateForwardedSigner(material);
    const verifier = createDelegateForwardedVerifier(material);
    const a = runWithAuthenticatedDelegatePrincipal(sessionA, () =>
      signer("superagent_chrome_cdp", baseArgs, sessionA));
    const b = runWithAuthenticatedDelegatePrincipal(sessionB, () =>
      signer("superagent_chrome_cdp", baseArgs, sessionB));
    const reconnect = runWithAuthenticatedDelegatePrincipal(reconnectA, () =>
      signer("superagent_chrome_cdp", baseArgs, reconnectA));
    expect(verifier(a).principalId).not.toBe(verifier(b).principalId);
    expect(verifier(reconnect).principalId).not.toBe(a.attestation.principalId);
    expect(reconnect.attestation.subjectHash).toBe(a.attestation.subjectHash);
    expect(() => verifier(a)).toThrow("DELEGATE_FORWARD_REPLAY");
  });

  it("separates ephemeral channel generations even if the same key is mistakenly reused", () => {
    const material = generateDelegateForwardedChannelMaterial();
    const { body } = sign(sessionA, "superagent_chrome_cdp", baseArgs, undefined, material);
    const rotated = generateDelegateForwardedChannelMaterial();
    expect(() => createDelegateForwardedVerifier(rotated)(body)).toThrow();
    expect(() => createDelegateForwardedVerifier({
      key: material.key, channelId: rotated.channelId,
    })(body)).toThrow();
  });

  it("rejects stale and excessive future clocks before consuming nonces", () => {
    const material = generateDelegateForwardedChannelMaterial();
    const issued = 1_793_931_300_000;
    const signer = createDelegateForwardedSigner(material);
    const body = runWithAuthenticatedDelegatePrincipal(sessionA, () =>
      signer("superagent_chrome_cdp", baseArgs, sessionA, issued));
    expect(() => createDelegateForwardedVerifier(material)(body, issued + 30_001)).toThrow();
    expect(() => createDelegateForwardedVerifier(material)(body, issued - 10_001)).toThrow();
    const verifier = createDelegateForwardedVerifier(material);
    expect(verifier(body, issued + 29_999).principalId).toBe(body.attestation.principalId);
  });

  it("fails closed if nonce cache is full, then permits a fresh operation after expiry", () => {
    const material = generateDelegateForwardedChannelMaterial();
    const signer = createDelegateForwardedSigner(material);
    const verifier = createDelegateForwardedVerifier(material, { maxReplayEntries: 1 });
    const t = 1_793_931_300_000;
    const make = (at: number) => runWithAuthenticatedDelegatePrincipal(sessionA, () =>
      signer("superagent_chrome_cdp", baseArgs, sessionA, at));
    expect(verifier(make(t), t).principalId).toMatch(/^mcp-/);
    expect(() => verifier(make(t + 1), t + 1)).toThrow("DELEGATE_FORWARD_REPLAY_CACHE_FULL");
    expect(verifier(make(t + 41_000), t + 41_000).principalId).toMatch(/^mcp-/);
  });

  it("requires genuinely private 256-bit nonzero channel material and strict target consistency", () => {
    const material = generateDelegateForwardedChannelMaterial();
    expect(material.key.byteLength).toBe(32);
    expect(() => createDelegateForwardedSigner({ ...material, key: new Uint8Array(16) })).toThrow();
    expect(() => createDelegateForwardedSigner({ ...material, key: new Uint8Array(32) })).toThrow();
    expect(() => delegateForwardedTarget("superagent_chrome_cdp", {
      ...baseArgs, payload: { delegateClientId: "profileBravo123" },
    })).toThrow("DELEGATE_FORWARD_TARGET_CONFLICT");
    expect(() => delegateForwardedTarget("superagent_chrome_cdp", {
      ...baseArgs, payload: { delegateTabId: 91232 },
    })).toThrow("DELEGATE_FORWARD_TARGET_CONFLICT");
    expect(() => delegateForwardedTarget("superagent_unknown_tool", baseArgs)).toThrow();
  });

  it("supports Delegate chat tool names but never forges browser target selectors", () => {
    const args = { clientId: "profileAlpha123", tabId: 91231, message: "hello" };
    const { material, body } = sign(sessionA, "superagent_delegate_send_message", args);
    const verified = createDelegateForwardedVerifier(material)(body);
    expect(verified.target).toEqual({
      command: "superagent_delegate_send_message", clientId: "profileAlpha123",
      tabId: 91231, targetId: null, transport: null,
    });
  });

  it("rejects ambiguous JSON, cyclic data, suspicious keys, non-finite numbers and oversized data", () => {
    const material = generateDelegateForwardedChannelMaterial();
    const signer = createDelegateForwardedSigner(material);
    const bad: any = { command: "snapshot", transport: "delegate" };
    bad.cycle = bad;
    expect(() => canonicalDelegateForwardedJson(bad)).toThrow();
    expect(() => canonicalDelegateForwardedJson({ x: NaN })).toThrow();
    const protoKey = JSON.parse('{"__proto__":"inject"}');
    expect(() => canonicalDelegateForwardedJson(protoKey)).toThrow();
    expect(() => runWithAuthenticatedDelegatePrincipal(sessionA, () =>
      signer("superagent_chrome_cdp", { message: "x".repeat(105_001) }, sessionA)))
      .toThrow("DELEGATE_FORWARD_INVALID_PAYLOAD");
  });

  it("canonicalizes key order but not changed values", () => {
    expect(canonicalDelegateForwardedJson({ z: 1, a: { b: 2, a: 3 } }))
      .toBe(canonicalDelegateForwardedJson({ a: { a: 3, b: 2 }, z: 1 }));
    const { material, body } = sign(sessionA, "superagent_delegate_read_chat",
      { connections: true, clientId: "profileAlpha123" });
    const shuffled = { attestation: body.attestation,
      name: body.name, arguments: { clientId: "profileAlpha123", connections: true } };
    expect(createDelegateForwardedVerifier(material)(shuffled).principalId)
      .toBe(body.attestation.principalId);
  });

  it("restores the original authenticated MCP actor at owner dispatch after verification", async () => {
    // In-process test fixture ONLY: actual Core/MCP processes need a trusted IPC bootstrap.
    const material = generateDelegateForwardedChannelMaterial();
    installDelegateForwardedVerifier(material);
    const signer = createDelegateForwardedSigner(material);
    const body = runWithAuthenticatedDelegatePrincipal(sessionA, () =>
      signer("superagent_chrome_cdp", baseArgs, sessionA));
    const fromMcp = runWithAuthenticatedDelegatePrincipal(sessionA, () => getDelegateMcpPrincipalId());
    const fromHost = await withVerifiedDelegateForwardedPrincipal(body, async verified => {
      expect(verified.principalId).toBe(fromMcp);
      await Promise.resolve();
      return getDelegateMcpPrincipalId();
    });
    expect(fromHost).toBe(fromMcp);
    expect(() => withVerifiedDelegateForwardedPrincipal(body, () => 1))
      .toThrow("DELEGATE_FORWARD_REPLAY");
  });

  it("requires explicit in-memory signer provisioning and a trusted transport-bound dispatch", () => {
    const id = { ...sessionA };
    const args = { command: "snapshot", transport: "delegate", delegateClientId: "profileAlpha123" };
    expect(() => signDelegateForwardedRequest("superagent_chrome_cdp", args))
      .toThrow("DELEGATE_FORWARD_PRINCIPAL_REQUIRED");
    expect(() => runWithTrustedDelegateForwardingConnection(id, () =>
      signDelegateForwardedRequest("superagent_chrome_cdp", args)))
      .toThrow("DELEGATE_FORWARD_BRIDGE_NOT_PROVISIONED");
    expect(() => runWithTrustedDelegateForwardingConnection(id, () =>
      signDelegateForwardedRequest("superagent_chrome_cdp", args))).toThrow();
  });
});
