/**
 * Separate, host-native Android controller proof. A paired/viewing Android
 * support session NEVER authorizes input. Core issues a short-lived bearer
 * ONLY after a signed, attended native Tray confirmation of exact device ID
 * and pinned TLS fingerprint. The controller bearer stays in native Rust,
 * never in the WebView, a screenshot URL, MCP, or device discovery.
 *
 * Same-local-user key-file trust limitations match NativeDesktopApprovalGuard.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readNativeDesktopApprovalKey } from "./nativeApprovalProof.js";
import { listLanDevices, currentAndroidLanSupportSessionProof,
  type LanDevice } from "../lanRemote/controller.js";

export const ANDROID_CONTROL_CHALLENGE_TTL_MS = 30_000;
export const ANDROID_CONTROL_LEASE_TTL_MS = 120_000;
const CONTROLLER_DOMAIN = "superagent-desktop-live-android-controller-v1";
type Pending = {nonce:string;deviceId:string;fingerprint:string;sessionProof:string;expiresAt:number};
type Grant = {deviceId:string;fingerprint:string;sessionProof:string;digest:Buffer;expiresAt:number};

function deny(code: string): never { throw Error(code); }
function validId(id: unknown): id is string {
  return typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
function validHex(value: unknown, length: number): value is string {
  return typeof value === "string" &&
    value.length === length && /^[0-9a-f]+$/.test(value);
}
function equalDigest(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
function proofMessage(nonce: string, id: string, fingerprint: string): string {
  return [CONTROLLER_DOMAIN,nonce,id,fingerprint].join(":");
}

export class NativeAndroidControllerApproval {
  private pending: Pending | null = null;
  private active: Grant | null = null;
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

  private exactDevice(id: string): {deviceId:string; fingerprint:string;sessionProof:string} {
    const matching = this.list().filter(d => d.id === id &&
      d.platform === "android" && d.paired === true && d.connected === true &&
      validHex(d.fingerprint, 64));
    if (matching.length !== 1) {
      this.revoke();
      deny("ANDROID_CONTROLLER_DEVICE_SESSION_UNAVAILABLE");
    }
    const proof=this.sessionProof(id);
    if (!validHex(proof,64)) {
      this.revoke();
      deny("ANDROID_CONTROLLER_SUPPORT_SESSION_INVALID");
    }
    return { deviceId:id, fingerprint:matching[0].fingerprint.toLowerCase(),
      sessionProof:proof };
  }

  /** Challenge is NOT permission and contains no input bearer. */
  challenge(rawId: unknown): {nonce:string;deviceId:string;fingerprint:string;expiresAt:number} {
    if (!validId(rawId)) deny("ANDROID_CONTROLLER_INVALID_DEVICE");
    const device = this.exactDevice(rawId);
    const now = this.clock();
    // Starting a new attended challenge invalidates the prior controller.
    // Viewing is left untouched.
    this.revoke();
    this.key();
    const nonce = randomBytes(24).toString("hex");
    this.pending = {...device,nonce,expiresAt:now+ANDROID_CONTROL_CHALLENGE_TTL_MS};
    return {...this.pending};
  }

  /** Consume every challenge once, including invalid signatures. */
  confirm(raw: unknown): {controllerToken:string;expiresAt:number} {
    const pending = this.pending;
    this.pending = null;
    if (!pending || !raw || typeof raw !== "object" || Array.isArray(raw))
      deny("ANDROID_CONTROLLER_NATIVE_PROOF_REQUIRED");
    const data = raw as Record<string,unknown>;
    if (Object.keys(data).sort().join(",") !== "deviceId,fingerprint,mac,nonce" ||
        data.deviceId !== pending.deviceId ||
        data.fingerprint !== pending.fingerprint ||
        data.nonce !== pending.nonce ||
        !validHex(data.mac,64) ||
        this.clock() >= pending.expiresAt)
      deny("ANDROID_CONTROLLER_NATIVE_PROOF_INVALID");
    const current = this.exactDevice(pending.deviceId);
    if (current.fingerprint !== pending.fingerprint ||
        current.sessionProof !== pending.sessionProof)
      deny("ANDROID_CONTROLLER_DEVICE_CHANGED");
    const mac = createHmac("sha256", this.key())
      .update(proofMessage(pending.nonce,pending.deviceId,pending.fingerprint))
      .digest();
    if (!equalDigest(mac,Buffer.from(data.mac,"hex")))
      deny("ANDROID_CONTROLLER_NATIVE_PROOF_INVALID");
    const token = randomBytes(32).toString("hex");
    this.active = {
      deviceId: pending.deviceId,
      fingerprint: pending.fingerprint,
      sessionProof: pending.sessionProof,
      digest: createHash("sha256").update(token,"ascii").digest(),
      expiresAt: this.clock()+ANDROID_CONTROL_LEASE_TTL_MS,
    };
    return { controllerToken:token, expiresAt:this.active.expiresAt };
  }

  /** Require the unrelated controller bearer for every input and element. */
  authorize(rawId: unknown, rawToken: unknown): void {
    const grant = this.active;
    if (!grant || !validId(rawId) || !validHex(rawToken,64) ||
        grant.deviceId !== rawId ||
        !equalDigest(grant.digest,createHash("sha256").update(rawToken,"ascii").digest())) {
      deny("ANDROID_CONTROLLER_APPROVAL_REQUIRED");
    }
    if (this.clock() >= grant.expiresAt) {
      this.revoke();
      deny("ANDROID_CONTROLLER_APPROVAL_EXPIRED");
    }
    const current = this.exactDevice(grant.deviceId);
    if (current.fingerprint !== grant.fingerprint ||
        current.sessionProof !== grant.sessionProof) {
      this.revoke();
      deny("ANDROID_CONTROLLER_DEVICE_CHANGED");
    }
  }

  status(rawId: unknown, rawToken: unknown): {approved:boolean;secondsRemaining:number} {
    try {
      this.authorize(rawId,rawToken);
      return {approved:true,secondsRemaining:Math.max(1,
        Math.ceil((this.active!.expiresAt-this.clock())/1000))};
    } catch {return {approved:false,secondsRemaining:0};}
  }

  /** Native host closes a controller without closing the view session. */
  revoke(rawToken?: unknown): void {
    if (rawToken !== undefined && this.active) {
      if (!validHex(rawToken,64) ||
          !equalDigest(this.active.digest,
            createHash("sha256").update(rawToken,"ascii").digest()))
        deny("ANDROID_CONTROLLER_REVOKE_PROOF_REQUIRED");
    }
    this.active = null;
    this.pending = null;
  }

  revokeDevice(id: string): void {
    if (this.active?.deviceId === id || this.pending?.deviceId === id) this.revoke();
  }

  /** For isolated deterministic tests; never return the actual host key. */
  static computeProofForTest(key: Buffer,nonce:string,id:string,fingerprint:string):string {
    return createHmac("sha256",key).update(proofMessage(nonce,id,fingerprint)).digest("hex");
  }
}
export const nativeAndroidControllerApproval = new NativeAndroidControllerApproval();
