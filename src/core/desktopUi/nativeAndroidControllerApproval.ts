/**
 * Host-native Android controller grants. View, mouse, and keyboard are three
 * distinct permissions. An attended main-Tray dialog signs a one-use challenge
 * specific to one input kind and one exact paired Android support session.
 * Controller tokens never enter the WebView, MCP, or the viewer connection.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readNativeDesktopApprovalKey } from "./nativeApprovalProof.js";
import { listLanDevices, currentAndroidLanSupportSessionProof,
  type LanDevice } from "../lanRemote/controller.js";

export const ANDROID_CONTROL_CHALLENGE_TTL_MS = 30_000;
export const ANDROID_CONTROL_LEASE_TTL_MS = 120_000;
export type AndroidControlKind = "mouse" | "keyboard";
const CONTROLLER_DOMAIN = "superagent-desktop-live-android-controller-v2";
type Device = { deviceId: string; fingerprint: string; sessionProof: string };
type Pending = Device & { nonce: string; kind: AndroidControlKind; expiresAt: number };
type Grant = Device & { kind: AndroidControlKind; digest: Buffer; expiresAt: number };

function deny(code: string): never { throw Error(code); }
function validId(id: unknown): id is string {
  return typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
function validHex(value: unknown, length: number): value is string {
  return typeof value === "string" && value.length === length && /^[0-9a-f]+$/.test(value);
}
function validKind(kind: unknown): kind is AndroidControlKind {
  return kind === "mouse" || kind === "keyboard";
}
function equalDigest(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
function proofMessage(nonce: string, id: string, fingerprint: string, kind: AndroidControlKind): string {
  return [CONTROLLER_DOMAIN,nonce,id,fingerprint,kind].join(":");
}

export class NativeAndroidControllerApproval {
  private pending: Pending | null = null;
  private readonly grants = new Map<AndroidControlKind, Grant>();
  private lastClock: number | null = null;
  constructor(
    private readonly key: () => Buffer = readNativeDesktopApprovalKey,
    private readonly list: () => readonly LanDevice[] = listLanDevices,
    private readonly now: () => number = Date.now,
    private readonly sessionProof: (id: string) => string | null =
      currentAndroidLanSupportSessionProof,
  ) {}

  private clock(): number {
    const time = this.now();
    if (!Number.isSafeInteger(time) || time < 0 ||
        (this.lastClock !== null && time < this.lastClock)) {
      this.revoke();
      deny("ANDROID_CONTROLLER_HOST_CLOCK_INVALID");
    }
    this.lastClock = time;
    return time;
  }

  private exactDevice(id: string): Device {
    const matching = this.list().filter(d => d.id === id &&
      d.platform === "android" && d.paired === true && d.connected === true &&
      typeof d.fingerprint === "string" && /^[a-f0-9]{64}$/i.test(d.fingerprint));
    if (matching.length !== 1) {
      this.revokeDevice(id);
      deny("ANDROID_CONTROLLER_DEVICE_SESSION_UNAVAILABLE");
    }
    const proof = this.sessionProof(id);
    if (!validHex(proof, 64)) {
      this.revokeDevice(id);
      deny("ANDROID_CONTROLLER_SUPPORT_SESSION_INVALID");
    }
    return { deviceId:id, fingerprint: matching[0].fingerprint.toLowerCase(), sessionProof: proof };
  }

  /** Opening a challenge for one kind never elevates the other kind. */
  challenge(rawId: unknown, rawKind: unknown): {
    nonce:string;deviceId:string;fingerprint:string;kind:AndroidControlKind;expiresAt:number;
  } {
    if (!validId(rawId) || !validKind(rawKind))
      deny("ANDROID_CONTROLLER_INVALID_SCOPE");
    const device = this.exactDevice(rawId);
    const now = this.clock();
    this.pending = null;
    this.grants.delete(rawKind);
    this.key(); // Fail closed if the protected native key does not exist.
    const nonce = randomBytes(24).toString("hex");
    const expiresAt = now + ANDROID_CONTROL_CHALLENGE_TTL_MS;
    this.pending = { ...device,nonce,kind:rawKind,expiresAt };
    return {nonce,deviceId:device.deviceId,fingerprint:device.fingerprint,
      kind:rawKind,expiresAt};
  }

  /** Burn even forged/replayed challenges; the scope is covered by the HMAC. */
  confirm(raw: unknown): {controllerToken:string;kind:AndroidControlKind;expiresAt:number} {
    const pending = this.pending;
    this.pending = null;
    if (!pending || !raw || typeof raw !== "object" || Array.isArray(raw))
      deny("ANDROID_CONTROLLER_NATIVE_PROOF_REQUIRED");
    const data = raw as Record<string,unknown>;
    if (Object.keys(data).sort().join(",") !== "deviceId,fingerprint,kind,mac,nonce" ||
        data.deviceId !== pending.deviceId ||
        data.fingerprint !== pending.fingerprint ||
        data.kind !== pending.kind ||
        data.nonce !== pending.nonce || !validHex(data.mac,64) ||
        this.clock() >= pending.expiresAt)
      deny("ANDROID_CONTROLLER_NATIVE_PROOF_INVALID");
    const current = this.exactDevice(pending.deviceId);
    if (current.fingerprint !== pending.fingerprint ||
        current.sessionProof !== pending.sessionProof)
      deny("ANDROID_CONTROLLER_DEVICE_CHANGED");
    const mac = createHmac("sha256",this.key())
      .update(proofMessage(pending.nonce,pending.deviceId,pending.fingerprint,pending.kind))
      .digest();
    if (!equalDigest(mac,Buffer.from(data.mac,"hex")))
      deny("ANDROID_CONTROLLER_NATIVE_PROOF_INVALID");
    const token = randomBytes(32).toString("hex");
    const expiresAt = this.clock()+ANDROID_CONTROL_LEASE_TTL_MS;
    this.grants.set(pending.kind, {
      deviceId:pending.deviceId, fingerprint:pending.fingerprint,
      sessionProof:pending.sessionProof,kind:pending.kind,
      digest:createHash("sha256").update(token,"ascii").digest(),expiresAt,
    });
    return {controllerToken:token,kind:pending.kind,expiresAt};
  }

  authorize(rawId: unknown, rawToken: unknown, rawKind: unknown): void {
    if (!validKind(rawKind)) deny("ANDROID_CONTROLLER_INVALID_SCOPE");
    const grant = this.grants.get(rawKind);
    if (!grant || !validId(rawId) || !validHex(rawToken,64) ||
        grant.deviceId !== rawId ||
        !equalDigest(grant.digest,createHash("sha256").update(rawToken,"ascii").digest()))
      deny("ANDROID_CONTROLLER_APPROVAL_REQUIRED");
    if (this.clock() >= grant.expiresAt) {
      this.grants.delete(rawKind);
      deny("ANDROID_CONTROLLER_APPROVAL_EXPIRED");
    }
    const current = this.exactDevice(grant.deviceId);
    if (current.fingerprint !== grant.fingerprint ||
        current.sessionProof !== grant.sessionProof) {
      this.revokeDevice(grant.deviceId);
      deny("ANDROID_CONTROLLER_DEVICE_CHANGED");
    }
  }

  status(rawId: unknown,rawToken: unknown,rawKind: unknown): {
    approved:boolean;kind:AndroidControlKind|null;secondsRemaining:number;
  } {
    if (!validKind(rawKind)) return {approved:false,kind:null,secondsRemaining:0};
    try {
      this.authorize(rawId,rawToken,rawKind);
      const grant = this.grants.get(rawKind)!;
      return {approved:true,kind:rawKind,
        secondsRemaining:Math.max(1,Math.ceil((grant.expiresAt-this.clock())/1000))};
    } catch {return {approved:false,kind:rawKind,secondsRemaining:0};}
  }

  /** Revoke one scope with its own native bearer, or all only for trusted host shutdown. */
  revoke(rawToken?: unknown,rawKind?: unknown): void {
    if (rawToken === undefined && rawKind === undefined) {
      this.grants.clear(); this.pending = null; return;
    }
    if (!validKind(rawKind)) deny("ANDROID_CONTROLLER_REVOKE_SCOPE_REQUIRED");
    const grant = this.grants.get(rawKind);
    if (!grant || !validHex(rawToken,64) ||
        !equalDigest(grant.digest,createHash("sha256").update(rawToken,"ascii").digest()))
      deny("ANDROID_CONTROLLER_REVOKE_PROOF_REQUIRED");
    this.grants.delete(rawKind);
    if (this.pending?.kind === rawKind) this.pending = null;
  }

  revokeDevice(id: string): void {
    for (const [kind,grant] of this.grants)
      if (grant.deviceId === id) this.grants.delete(kind);
    if (this.pending?.deviceId === id) this.pending = null;
  }

  static computeProofForTest(key: Buffer,nonce:string,id:string,fingerprint:string,
    kind:AndroidControlKind):string {
    return createHmac("sha256",key).update(proofMessage(nonce,id,fingerprint,kind)).digest("hex");
  }
}
export const nativeAndroidControllerApproval = new NativeAndroidControllerApproval();
