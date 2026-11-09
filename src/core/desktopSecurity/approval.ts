import crypto from "node:crypto";
import { DesktopUiError } from "../desktopUi/errors.js";

export interface HumanApprovalBinding {
  operationDigest: string;
  principalId: string;
  target: string;
}

export interface HumanApprovalRequest {
  requestId: string;
  invocationId: string;
  operationDigest: string;
  principalId: string;
  target: string;
  expiresAt: number;
  approvedAt?: number;
  approvedBy?: string;
}

export interface CreateHumanApprovalRequest extends HumanApprovalBinding {
  ttlMs?: number;
}

const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;
const MAX_APPROVAL_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_APPROVALS = 64;

function requireText(value: string, field: string, maxLength: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength) {
    throw new DesktopUiError("INVALID_ACTION", `${field} must contain 1-${maxLength} characters.`);
  }
  return normalized;
}

function requireDigest(value: string): string {
  const normalized = requireText(value, "operationDigest", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new DesktopUiError("INVALID_ACTION", "operationDigest must be a SHA-256 hexadecimal digest.");
  }
  return normalized;
}

export class DesktopHumanApprovalManager {
  private readonly requests = new Map<string, HumanApprovalRequest>();

  private prune(now = Date.now()): void {
    for (const [requestId, request] of this.requests.entries()) {
      if (request.expiresAt <= now) this.requests.delete(requestId);
    }
  }

  createRequest(binding: CreateHumanApprovalRequest): HumanApprovalRequest {
    this.prune();
    if (this.requests.size >= MAX_PENDING_APPROVALS) {
      throw new DesktopUiError("DESKTOP_UI_UNAVAILABLE", "Too many pending desktop approval requests.");
    }
    const ttlMs = binding.ttlMs ?? DEFAULT_APPROVAL_TTL_MS;
    if (!Number.isInteger(ttlMs) || ttlMs < 30_000 || ttlMs > MAX_APPROVAL_TTL_MS) {
      throw new DesktopUiError("INVALID_ACTION", "Approval ttlMs must be between 30000 and 900000 milliseconds.");
    }
    const request: HumanApprovalRequest = {
      requestId: `approval_${crypto.randomUUID()}`,
      invocationId: `invoke_${crypto.randomUUID()}`,
      operationDigest: requireDigest(binding.operationDigest),
      principalId: requireText(binding.principalId, "principalId", 256),
      target: requireText(binding.target, "target", 512),
      expiresAt: Date.now() + ttlMs,
    };
    this.requests.set(request.requestId, request);
    return { ...request };
  }

  getRequest(requestId: string): HumanApprovalRequest | null {
    this.prune();
    const request = this.requests.get(requestId);
    return request ? { ...request } : null;
  }

  cancelRequest(requestId: string): boolean {
    return this.requests.delete(requestId);
  }

  approveHostRequest(input: {
    requestId: string;
    operationDigest: string;
    operatorId: string;
  }): HumanApprovalRequest {
    this.prune();
    const requestId = requireText(input.requestId, "requestId", 128);
    const request = this.requests.get(requestId);
    if (!request) {
      throw new DesktopUiError("INPUT_DISABLED", "Approval request is missing or expired.");
    }
    if (request.operationDigest !== requireDigest(input.operationDigest)) {
      throw new DesktopUiError("INPUT_DISABLED", "Approval digest does not match the pending operation.");
    }
    const operatorId = requireText(input.operatorId, "operatorId", 128);
    request.approvedAt = Date.now();
    request.approvedBy = operatorId;
    return { ...request };
  }

  consumeApprovedRequest(input: HumanApprovalBinding & {
    requestId: string;
    invocationId: string;
  }): HumanApprovalRequest {
    this.prune();
    const requestId = requireText(input.requestId, "requestId", 128);
    const request = this.requests.get(requestId);
    if (!request || !request.approvedAt || !request.approvedBy) {
      throw new DesktopUiError(
        "INPUT_DISABLED",
        "Package mutation requires a separate host-operator approval. Model arguments cannot create approval.",
      );
    }
    const matches = request.operationDigest === requireDigest(input.operationDigest)
      && request.principalId === requireText(input.principalId, "principalId", 256)
      && request.target === requireText(input.target, "target", 512)
      && request.invocationId === requireText(input.invocationId, "invocationId", 128);
    if (!matches) {
      throw new DesktopUiError("INPUT_DISABLED", "Approval binding does not match this package operation.");
    }
    this.requests.delete(requestId);
    return { ...request };
  }

  clear(): void {
    this.requests.clear();
  }
}

export const desktopPackageApprovalManager = new DesktopHumanApprovalManager();
