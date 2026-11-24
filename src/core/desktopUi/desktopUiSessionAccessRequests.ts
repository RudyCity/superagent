import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DesktopUiError } from "./errors.js";
import { readNativeDesktopApprovalKey } from "./nativeApprovalProof.js";

export type DesktopUiSessionAccessMode = "view" | "input";
export type DesktopUiSessionAccessStatus = "pending" | "approved" | "denied" | "consumed" | "expired";

export interface DesktopUiSessionAccessRequest {
  requestId: string;
  principalId: string;
  pid: number;
  nativeId: string;
  title: string;
  application: string;
  accessMode: DesktopUiSessionAccessMode;
  ttlMs: number;
  reason: string;
  createdAt: number;
  expiresAt: number;
  status: DesktopUiSessionAccessStatus;
  decidedAt?: number;
  consumedAt?: number;
}

export interface CreateDesktopUiSessionAccessRequest {
  principalId: string;
  pid: number;
  nativeId: string;
  title: string;
  application: string;
  accessMode: DesktopUiSessionAccessMode;
  ttlMs: number;
  reason?: string;
}

export interface DesktopUiSessionAccessChallenge {
  request: DesktopUiSessionAccessRequest;
  decision: "approve" | "deny";
  nonce: string;
  expiresAt: number;
}

const REQUEST_TTL_MS = 5 * 60_000;
const CHALLENGE_TTL_MS = 30_000;
const MAX_PENDING = 32;
const MAX_HISTORY = 96;

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value ||
      value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DesktopUiError("INVALID_ACTION", `${field} is invalid.`);
  }
  return value;
}

function approvalMessage(request: DesktopUiSessionAccessRequest, decision: "approve" | "deny", nonce: string): string {
  return [
    "superagent-desktop-ui-session-approval-v1",
    nonce,
    request.requestId,
    request.principalId,
    String(request.pid),
    request.nativeId,
    request.title,
    request.application,
    request.accessMode,
    String(request.ttlMs),
    request.reason,
    decision,
  ].join("\n");
}

function cloneRequest(request: DesktopUiSessionAccessRequest): DesktopUiSessionAccessRequest {
  return { ...request };
}

export class DesktopUiSessionAccessRequestManager {
  private readonly requests = new Map<string, DesktopUiSessionAccessRequest>();
  private readonly challenges = new Map<string, {
    requestId: string;
    decision: "approve" | "deny";
    expiresAt: number;
  }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly key: () => Uint8Array = readNativeDesktopApprovalKey,
  ) {}

  private prune(): void {
    const now = this.now();
    for (const request of this.requests.values()) {
      if ((request.status === "pending" || request.status === "approved") &&
          request.expiresAt <= now) {
        request.status = "expired";
        request.decidedAt = now;
      }
    }
    for (const [nonce, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(nonce);
    }
    const all = [...this.requests.values()];
    if (all.length > MAX_HISTORY) {
      for (const request of all.sort((a, b) => a.createdAt - b.createdAt).slice(0, all.length - MAX_HISTORY)) {
        this.requests.delete(request.requestId);
      }
    }
  }

  create(input: CreateDesktopUiSessionAccessRequest): DesktopUiSessionAccessRequest {
    this.prune();
    const principalId = boundedText(input.principalId, "principalId", 256);
    if (!Number.isSafeInteger(input.pid) || input.pid <= 0 || input.pid > 0xffff_ffff) {
      throw new DesktopUiError("INVALID_ACTION", "Desktop window PID is invalid.");
    }
    const nativeId = boundedText(input.nativeId, "nativeId", 256);
    const title = boundedText(input.title, "title", 512);
    const application = boundedText(input.application, "application", 256);
    if (input.accessMode !== "view" && input.accessMode !== "input") {
      throw new DesktopUiError("INVALID_ACTION", "accessMode must be view or input.");
    }
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 60_000 || input.ttlMs > 30 * 60_000) {
      throw new DesktopUiError("INVALID_ACTION", "ttlMs must be between one and thirty minutes.");
    }
    const reason = input.reason === undefined
      ? "Local SuperAgent agent requested a desktop session."
      : boundedText(input.reason, "reason", 240);
    const existing = [...this.requests.values()].find(request =>
      request.status === "pending" &&
      request.principalId === principalId &&
      request.pid === input.pid &&
      request.nativeId === nativeId &&
      request.accessMode === input.accessMode &&
      request.ttlMs === input.ttlMs
    );
    if (existing) return cloneRequest(existing);
    if ([...this.requests.values()].filter(request => request.status === "pending").length >= MAX_PENDING) {
      throw new DesktopUiError("DESKTOP_UI_UNAVAILABLE", "Too many pending Desktop UI session requests.");
    }
    const now = this.now();
    const request: DesktopUiSessionAccessRequest = {
      requestId: "desktop_req_" + randomBytes(16).toString("hex"),
      principalId,
      pid: input.pid,
      nativeId,
      title,
      application,
      accessMode: input.accessMode,
      ttlMs: input.ttlMs,
      reason,
      createdAt: now,
      expiresAt: now + REQUEST_TTL_MS,
      status: "pending",
    };
    this.requests.set(request.requestId, request);
    return cloneRequest(request);
  }

  list(): DesktopUiSessionAccessRequest[] {
    this.prune();
    return [...this.requests.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(cloneRequest);
  }

  issueChallenge(requestId: unknown, decision: unknown): DesktopUiSessionAccessChallenge {
    this.prune();
    const id = boundedText(requestId, "requestId", 96);
    if (decision !== "approve" && decision !== "deny") {
      throw new DesktopUiError("INVALID_ACTION", "Decision must be approve or deny.");
    }
    const request = this.requests.get(id);
    if (!request || request.status !== "pending" || request.expiresAt <= this.now()) {
      throw new DesktopUiError("INPUT_DISABLED", "Desktop UI request is missing, expired, or already decided.");
    }
    // Fail closed if the private native approval key cannot be read.
    this.key();
    const nonce = randomBytes(24).toString("hex");
    const expiresAt = this.now() + CHALLENGE_TTL_MS;
    this.challenges.set(nonce, { requestId: id, decision, expiresAt });
    return { request: cloneRequest(request), decision, nonce, expiresAt };
  }

  decide(input: {
    requestId: unknown;
    decision: unknown;
    nonce: unknown;
    mac: unknown;
  }): DesktopUiSessionAccessRequest {
    this.prune();
    const requestId = boundedText(input.requestId, "requestId", 96);
    if (input.decision !== "approve" && input.decision !== "deny") {
      throw new DesktopUiError("INVALID_ACTION", "Decision must be approve or deny.");
    }
    const nonce = typeof input.nonce === "string" ? input.nonce : "";
    const mac = typeof input.mac === "string" ? input.mac : "";
    if (!/^[a-f0-9]{48}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(mac)) {
      throw new DesktopUiError("INPUT_DISABLED", "Native Desktop UI approval proof is invalid.");
    }
    const challenge = this.challenges.get(nonce);
    this.challenges.delete(nonce); // Burn before verifying; a proof is never replayable.
    const request = this.requests.get(requestId);
    if (!challenge || challenge.requestId !== requestId ||
        challenge.decision !== input.decision || challenge.expiresAt <= this.now() ||
        !request || request.status !== "pending" || request.expiresAt <= this.now()) {
      throw new DesktopUiError("INPUT_DISABLED", "Native Desktop UI approval challenge is missing or expired.");
    }
    const expected = createHmac("sha256", this.key())
      .update(approvalMessage(request, input.decision, nonce), "utf8")
      .digest();
    const presented = Buffer.from(mac, "hex");
    if (!timingSafeEqual(expected, presented)) {
      throw new DesktopUiError("INPUT_DISABLED", "Native Desktop UI approval proof does not match the exact request.");
    }
    request.status = input.decision === "approve" ? "approved" : "denied";
    request.decidedAt = this.now();
    return cloneRequest(request);
  }

  consumeApproved(
    requestId: unknown,
    principalId: unknown,
    expected?: { pid?: number; nativeId?: string; accessMode?: DesktopUiSessionAccessMode },
  ): DesktopUiSessionAccessRequest {
    this.prune();
    const id = boundedText(requestId, "approvalRequestId", 96);
    const principal = boundedText(principalId, "principalId", 256);
    const request = this.requests.get(id);
    if (!request || request.status !== "approved" || request.expiresAt <= this.now() ||
        request.principalId !== principal ||
        (expected?.pid !== undefined && request.pid !== expected.pid) ||
        (expected?.nativeId !== undefined && request.nativeId !== expected.nativeId) ||
        (expected?.accessMode !== undefined && request.accessMode !== expected.accessMode)) {
      throw new DesktopUiError("INPUT_DISABLED", "Desktop UI request is not approved, has expired, or does not match this exact target and scope.");
    }
    request.status = "consumed";
    request.consumedAt = this.now();
    return cloneRequest(request);
  }
}

export const desktopUiSessionAccessRequests = new DesktopUiSessionAccessRequestManager();

/** Stable helper shared with the native Tray proof implementation and tests. */
export function desktopUiSessionApprovalMessage(
  request: DesktopUiSessionAccessRequest,
  decision: "approve" | "deny",
  nonce: string,
): string {
  if (!/^[a-f0-9]{48}$/.test(nonce)) {
    throw new DesktopUiError("INVALID_ACTION", "Invalid Desktop UI approval nonce.");
  }
  return approvalMessage(request, decision, nonce);
}
