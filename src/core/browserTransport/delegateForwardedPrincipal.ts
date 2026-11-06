/**
 * MCP -> Core Delegate forwarding attestation (v1).
 *
 * A Core API bearer is NOT evidence of the originating MCP transport. Only a
 * lifecycle-provisioned, process-private 256-bit bridge key can sign requests.
 * This module NEVER performs key exchange over the Core API, reads secrets from
 * files/env, or implicitly creates a key for the forwarding client.
 *
 * Lifecycle owner must provision the SAME randomly generated channel material
 * into the trusted MCP signer and Core verifier via an authenticated private
 * bootstrap path (e.g. a verified supervisor IPC pipe). Until then, forwarding
 * fails closed. A replacement Core generation needs fresh material.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  getDelegateMcpPrincipalId,
  runWithAuthenticatedDelegatePrincipal,
  type AuthenticatedDelegateMcpConnection,
} from "./delegatePrincipalPolicy.js";

const AUDIENCE = "superagent-core-delegate-mcp-dispatch:v1" as const;
const MAX_AGE_MS = 30_000;
const MAX_FUTURE_MS = 10_000;
const MAX_REPLAY_ENTRIES = 4096;
const MAX_ARGS_BYTES = 105_000;
const SESSION_RE = /^[A-Za-z0-9_-]{16,128}$/;
const CHANNEL_RE = /^[A-Za-z0-9_-]{22,64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{32,64}$/;
const MAC_RE = /^[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const ACTOR_RE = /^mcp-[a-f0-9]{32}$/;

function denied(code = "DELEGATE_FORWARD_ATTESTATION_INVALID"): never {
  // Do not interpolate request material, signatures, identities, or secrets.
  throw new Error(code);
}

type JsonRecord = Record<string, unknown>;
export type DelegateForwardedTarget = Readonly<{
  command: string;
  clientId: string | null;
  tabId: number | null;
  targetId: string | null;
  transport: string | null;
}>;

export type DelegateForwardedAttestation = Readonly<{
  version: 1;
  audience: typeof AUDIENCE;
  channelId: string;
  issuedAt: number;
  nonce: string;
  sessionId: string;
  mode: "oauth" | "static-bearer";
  subjectHash: string;
  principalId: string;
  name: string;
  target: DelegateForwardedTarget;
  payloadHash: string;
  mac: string;
}>;

export type DelegateForwardedRequest = Readonly<{
  name: string;
  arguments: JsonRecord;
  attestation: DelegateForwardedAttestation;
}>;

export type VerifiedDelegateForwardedPrincipal = Readonly<{
  name: string;
  arguments: JsonRecord;
  principalId: string;
  connectionSessionId: string;
  mode: "oauth" | "static-bearer";
  subjectHash: string;
  target: DelegateForwardedTarget;
}>;

export type DelegateForwardedChannelMaterial = Readonly<{
  key: Uint8Array;
  channelId: string;
}>;

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
}

/** Exact deterministic JSON bytes; rejects ambiguous/non-JSON inputs. */
export function canonicalDelegateForwardedJson(value: unknown): string {
  const ancestors = new Set<object>();
  const normalize = (v: unknown, depth: number): string => {
    if (depth > 32) denied("DELEGATE_FORWARD_INVALID_PAYLOAD");
    if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== "object") denied("DELEGATE_FORWARD_INVALID_PAYLOAD");
    if (ancestors.has(v as object)) denied("DELEGATE_FORWARD_INVALID_PAYLOAD");
    ancestors.add(v as object);
    try {
      if (Array.isArray(v)) return "[" + v.map(item => normalize(item, depth + 1)).join(",") + "]";
      if (!record(v)) denied("DELEGATE_FORWARD_INVALID_PAYLOAD");
      const entries = Object.keys(v);
      if (entries.some(k => k === "__proto__" || k === "constructor" || k === "prototype"))
        denied("DELEGATE_FORWARD_INVALID_PAYLOAD");
      return "{" + entries.sort().map(k => JSON.stringify(k) + ":" +
        normalize(v[k], depth + 1)).join(",") + "}";
    } finally {
      ancestors.delete(v as object);
    }
  };
  return normalize(value, 0);
}

function hash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function actorForSession(sessionId: string): string {
  return "mcp-" + hash("superagent:delegate-mcp:v1\0" + sessionId).slice(0, 32);
}

function subjectHashFor(key: Buffer, mode: string, subject: string): string {
  // Keyed pseudonym; avoid exposing a brute-forceable digest of OAuth subjects.
  return createHmac("sha256", key).update(
    "superagent:delegate-mcp-subject:v1\0" + mode + "\0" + subject,
    "utf8",
  ).digest("hex");
}

function pickConsistent(candidates: unknown[], kind: "string" | "tab"): string | number | null {
  const defined = candidates.filter(x => x !== undefined && x !== null);
  if (!defined.length) return null;
  for (const item of defined) {
    if (kind === "tab" ? !Number.isSafeInteger(item) || (item as number) < 1
      : typeof item !== "string" || !(item as string).trim() || (item as string).length > 200)
      denied("DELEGATE_FORWARD_TARGET_INVALID");
    if (item !== defined[0]) denied("DELEGATE_FORWARD_TARGET_CONFLICT");
  }
  return defined[0] as string | number;
}

/** Derive target only from the EXACT request which is MAC/hash-bound. */
export function delegateForwardedTarget(name: string, args: JsonRecord): DelegateForwardedTarget {
  if (typeof name !== "string" ||
      !(/^(superagent_delegate_[a-z_]+|superagent_chrome_(cdp|vision))$/.test(name)))
    denied("DELEGATE_FORWARD_TOOL_DENIED");
  if (!record(args)) denied("DELEGATE_FORWARD_INVALID_PAYLOAD");
  let nested: JsonRecord = {};
  if (args.payload !== undefined) {
    try {
      nested = typeof args.payload === "string" ? JSON.parse(args.payload) : args.payload as JsonRecord;
    } catch { denied("DELEGATE_FORWARD_INVALID_PAYLOAD"); }
    if (!record(nested)) denied("DELEGATE_FORWARD_INVALID_PAYLOAD");
  }
  const command = pickConsistent([args.command, nested.command], "string");
  const clientId = pickConsistent([
    args.clientId, args.delegateClientId, args.connectionId,
    nested.clientId, nested.delegateClientId, nested.connectionId,
  ], "string");
  const tabId = pickConsistent([
    args.tabId, args.delegateTabId, nested.tabId, nested.delegateTabId,
  ], "tab");
  const targetId = pickConsistent([args.targetId, nested.targetId], "string");
  const transport = pickConsistent([args.transport, nested.transport], "string");
  return Object.freeze({
    command: (command ?? name) as string,
    clientId: clientId as string | null,
    tabId: tabId as number | null,
    targetId: targetId as string | null,
    transport: transport as string | null,
  });
}

function validateMaterial(material: DelegateForwardedChannelMaterial): { key: Buffer; channelId: string } {
  if (!material || !(material.key instanceof Uint8Array) || material.key.byteLength !== 32 ||
      typeof material.channelId !== "string" || !CHANNEL_RE.test(material.channelId))
    denied("DELEGATE_FORWARD_BRIDGE_NOT_PROVISIONED");
  const key = Buffer.from(material.key);
  if (key.every(b => b === 0)) denied("DELEGATE_FORWARD_BRIDGE_NOT_PROVISIONED");
  return { key, channelId: material.channelId };
}

/** Generate ONLY in a trusted lifecycle owner; never return this via HTTP. */
export function generateDelegateForwardedChannelMaterial(): DelegateForwardedChannelMaterial {
  return { key: randomBytes(32), channelId: randomBytes(24).toString("base64url") };
}

function signedFields(att: DelegateForwardedAttestation): Omit<DelegateForwardedAttestation, "mac"> {
  return {
    version: att.version, audience: att.audience, channelId: att.channelId,
    issuedAt: att.issuedAt, nonce: att.nonce, sessionId: att.sessionId,
    mode: att.mode, subjectHash: att.subjectHash, principalId: att.principalId,
    name: att.name, target: att.target, payloadHash: att.payloadHash,
  };
}

function macFor(key: Buffer, fields: Omit<DelegateForwardedAttestation, "mac">): string {
  return createHmac("sha256", key).update(
    "superagent:delegate-forwarded:v1\0" + canonicalDelegateForwardedJson(fields), "utf8",
  ).digest("base64url");
}

function validIdentity(identity: AuthenticatedDelegateMcpConnection): boolean {
  return !!identity && SESSION_RE.test(identity.sessionId) &&
    (identity.mode === "oauth" || identity.mode === "static-bearer") &&
    typeof identity.subject === "string" && !!identity.subject.trim();
}

export function createDelegateForwardedSigner(material: DelegateForwardedChannelMaterial) {
  const { key, channelId } = validateMaterial(material);
  return (name: string, args: JsonRecord, identity: AuthenticatedDelegateMcpConnection,
    now = Date.now()): DelegateForwardedRequest => {
    if (!validIdentity(identity) || !Number.isSafeInteger(now))
      denied("DELEGATE_FORWARD_PRINCIPAL_REQUIRED");
    // A purported identity argument alone is not proof of an authenticated MCP
    // connection. Assert it matches the principal in the trusted ALS scope.
    const principalId = actorForSession(identity.sessionId);
    if (getDelegateMcpPrincipalId() !== principalId)
      denied("DELEGATE_FORWARD_PRINCIPAL_REQUIRED");
    const payload = canonicalDelegateForwardedJson(args);
    if (!record(args) || Buffer.byteLength(payload, "utf8") > MAX_ARGS_BYTES)
      denied("DELEGATE_FORWARD_INVALID_PAYLOAD");
    const target = delegateForwardedTarget(name, args);
    const fields = {
      version: 1 as const, audience: AUDIENCE, channelId,
      issuedAt: now, nonce: randomBytes(24).toString("base64url"),
      sessionId: identity.sessionId, mode: identity.mode,
      subjectHash: subjectHashFor(key, identity.mode, identity.subject),
      principalId, name, target, payloadHash: hash(payload),
    };
    return { name, arguments: args, attestation: { ...fields, mac: macFor(key, fields) } };
  };
}

export function createDelegateForwardedVerifier(
  material: DelegateForwardedChannelMaterial,
  options: { maxReplayEntries?: number } = {},
) {
  const { key, channelId } = validateMaterial(material);
  const maxReplayEntries = options.maxReplayEntries ?? MAX_REPLAY_ENTRIES;
  if (!Number.isSafeInteger(maxReplayEntries) || maxReplayEntries < 1 ||
      maxReplayEntries > MAX_REPLAY_ENTRIES) denied("DELEGATE_FORWARD_REPLAY_CONFIG_INVALID");
  const seen = new Map<string, number>();
  return (body: unknown, now = Date.now()): VerifiedDelegateForwardedPrincipal => {
    if (!record(body) || Object.keys(body).sort().join(",") !== "arguments,attestation,name" ||
        !record(body.arguments) || !record(body.attestation) || !Number.isSafeInteger(now))
      denied();
    const att = body.attestation as unknown as DelegateForwardedAttestation;
    if (Object.keys(att).sort().join(",") !==
        "audience,channelId,issuedAt,mac,mode,name,nonce,payloadHash,principalId,sessionId,subjectHash,target,version" ||
        att.version !== 1 || att.audience !== AUDIENCE || att.channelId !== channelId ||
        typeof att.name !== "string" || body.name !== att.name ||
        !SESSION_RE.test(att.sessionId) || !NONCE_RE.test(att.nonce) ||
        !(att.mode === "oauth" || att.mode === "static-bearer") ||
        !HASH_RE.test(att.subjectHash) || !HASH_RE.test(att.payloadHash) ||
        !ACTOR_RE.test(att.principalId) || att.principalId !== actorForSession(att.sessionId) ||
        !MAC_RE.test(att.mac) || !Number.isSafeInteger(att.issuedAt) ||
        att.issuedAt > now + MAX_FUTURE_MS || now - att.issuedAt > MAX_AGE_MS)
      denied();
    const payload = canonicalDelegateForwardedJson(body.arguments);
    if (Buffer.byteLength(payload, "utf8") > MAX_ARGS_BYTES ||
        hash(payload) !== att.payloadHash) denied();
    const target = delegateForwardedTarget(body.name as string, body.arguments);
    if (canonicalDelegateForwardedJson(target) !== canonicalDelegateForwardedJson(att.target)) denied();
    const candidate = macFor(key, signedFields(att));
    if (!timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(att.mac, "utf8"))) denied();
    // Do not evict unexpired nonces: saturation fails closed, not replay-open.
    for (const [nonce, deadline] of seen) {
      if (deadline < now) seen.delete(nonce);
    }
    if (seen.has(att.nonce)) denied("DELEGATE_FORWARD_REPLAY");
    if (seen.size >= maxReplayEntries) denied("DELEGATE_FORWARD_REPLAY_CACHE_FULL");
    seen.set(att.nonce, att.issuedAt + MAX_AGE_MS + MAX_FUTURE_MS);
    return Object.freeze({
      name: body.name as string, arguments: body.arguments,
      principalId: att.principalId, connectionSessionId: att.sessionId,
      mode: att.mode, subjectHash: att.subjectHash, target,
    });
  };
}

const forwardingIdentityScope = new AsyncLocalStorage<AuthenticatedDelegateMcpConnection>();

/** Called only from the verified MCP server dispatch, not HTTP/args. */
export function runWithTrustedDelegateForwardingConnection<T>(
  identity: AuthenticatedDelegateMcpConnection, callback: () => T,
): T {
  if (!validIdentity(identity)) denied("DELEGATE_FORWARD_PRINCIPAL_REQUIRED");
  return runWithAuthenticatedDelegatePrincipal(identity, () =>
    forwardingIdentityScope.run(Object.freeze({ ...identity }), callback));
}

type Signer = ReturnType<typeof createDelegateForwardedSigner>;
type Verifier = ReturnType<typeof createDelegateForwardedVerifier>;
let signingInstance: Signer | undefined;
let verificationInstance: Verifier | undefined;

/**
 * Called only by trusted lifecycle IPC bootstrap, never by an HTTP handler
 * accepting client keys. A process cannot silently replace a live key.
 */
export function installDelegateForwardedSigner(material: DelegateForwardedChannelMaterial): void {
  if (signingInstance) denied("DELEGATE_FORWARD_BRIDGE_ALREADY_PROVISIONED");
  signingInstance = createDelegateForwardedSigner(material);
}
export function installDelegateForwardedVerifier(material: DelegateForwardedChannelMaterial): void {
  if (verificationInstance) denied("DELEGATE_FORWARD_BRIDGE_ALREADY_PROVISIONED");
  verificationInstance = createDelegateForwardedVerifier(material);
}

export function signDelegateForwardedRequest(
  name: string, args: JsonRecord,
): DelegateForwardedRequest {
  const identity = forwardingIdentityScope.getStore();
  if (!identity || getDelegateMcpPrincipalId() !== actorForSession(identity.sessionId))
    denied("DELEGATE_FORWARD_PRINCIPAL_REQUIRED");
  if (!signingInstance) denied("DELEGATE_FORWARD_BRIDGE_NOT_PROVISIONED");
  return signingInstance(name, args, identity);
}

export function verifyDelegateForwardedRequest(body: unknown): VerifiedDelegateForwardedPrincipal {
  if (!verificationInstance) denied("DELEGATE_FORWARD_BRIDGE_NOT_PROVISIONED");
  return verificationInstance(body);
}

/**
 * Worker C route contract: before any host-owned tool dispatch, call this with
 * the parsed body. It consumes the nonce and restores the MCP principal scope.
 */
export function withVerifiedDelegateForwardedPrincipal<T>(
  body: unknown, callback: (verified: VerifiedDelegateForwardedPrincipal) => T,
): T {
  const verified = verifyDelegateForwardedRequest(body);
  return runWithAuthenticatedDelegatePrincipal({
    sessionId: verified.connectionSessionId,
    mode: verified.mode,
    // Pseudonymous digest, not an externally asserted OAuth subject.
    subject: verified.subjectHash,
  }, () => callback(verified));
}
