import crypto from "crypto";

export interface CloudflareAccessHeaders {
  clientId?: string;
  clientSecret?: string;
}

export interface ReplayValidatorOptions {
  maxClockDriftMs?: number;
  maxSeenNonces?: number;
}

/**
 * Performs a constant-time comparison of two strings to prevent timing side-channel attacks.
 */
export function timingSafeCompare(a?: string | null, b?: string | null): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validates Cloudflare Access Service Token headers (CF-Access-Client-Id and CF-Access-Client-Secret)
 * using timing-safe comparisons.
 */
export function validateCloudflareAccess(
  headers: Record<string, string | string[] | undefined>,
  expectedClientId?: string,
  expectedClientSecret?: string
): { ok: boolean; reason?: string } {
  if (!expectedClientId && !expectedClientSecret) {
    return { ok: true };
  }

  const rawId = headers["cf-access-client-id"] || headers["CF-Access-Client-Id"];
  const rawSecret = headers["cf-access-client-secret"] || headers["CF-Access-Client-Secret"];

  const receivedId = Array.isArray(rawId) ? rawId[0] : rawId;
  const receivedSecret = Array.isArray(rawSecret) ? rawSecret[0] : rawSecret;

  if (expectedClientId && !timingSafeCompare(receivedId, expectedClientId)) {
    return { ok: false, reason: "Invalid or missing CF-Access-Client-Id" };
  }

  if (expectedClientSecret && !timingSafeCompare(receivedSecret, expectedClientSecret)) {
    return { ok: false, reason: "Invalid or missing CF-Access-Client-Secret" };
  }

  return { ok: true };
}

/**
 * Extracts a Bearer token from HTTP Authorization headers or WebSocket upgrade request URL parameters.
 */
export function extractBearerToken(
  authHeader?: string | string[],
  urlPath?: string
): string | undefined {
  if (authHeader) {
    const headerStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (typeof headerStr === "string") {
      const match = headerStr.match(/^Bearer\s+(.+)$/i);
      if (match) {
        return match[1].trim();
      }
    }
  }

  if (urlPath) {
    try {
      const url = new URL(urlPath, "http://127.0.0.1");
      const token = url.searchParams.get("token") || url.searchParams.get("auth");
      if (token && typeof token === "string") {
        return token.trim();
      }
    } catch {}
  }

  return undefined;
}

/**
 * Validates a received bearer token against the expected configured token using timing-safe comparison.
 */
export function validateBearerToken(
  receivedToken?: string | null,
  expectedToken?: string | null
): boolean {
  if (!expectedToken) return true;
  return timingSafeCompare(receivedToken, expectedToken);
}

/**
 * Validates incoming message frames against clock drift and replay attacks.
 * Tracks nonces with automatic TTL pruning.
 */
export class ReplayValidator {
  private seenNonces = new Map<string, number>();
  private readonly maxClockDriftMs: number;
  private readonly maxSeenNonces: number;

  constructor(options: ReplayValidatorOptions = {}) {
    this.maxClockDriftMs = options.maxClockDriftMs ?? 60_000;
    this.maxSeenNonces = options.maxSeenNonces ?? 5_000;
  }

  public validate(envelope: { ts?: number; nonce?: string }): { ok: boolean; reason?: string } {
    const now = Date.now();

    // Timestamp TTL check
    if (typeof envelope.ts === "number") {
      const delta = Math.abs(now - envelope.ts);
      if (delta > this.maxClockDriftMs) {
        return {
          ok: false,
          reason: `Timestamp drift exceeded: delta ${delta}ms exceeds limit ${this.maxClockDriftMs}ms`,
        };
      }
    }

    // Monotonic nonce uniqueness check
    if (typeof envelope.nonce === "string" && envelope.nonce.trim()) {
      const nonce = envelope.nonce.trim();
      if (this.seenNonces.has(nonce)) {
        return { ok: false, reason: `Replay attack detected: duplicate nonce ${nonce}` };
      }
      this.seenNonces.set(nonce, now);
      this.prune();
    }

    return { ok: true };
  }

  private prune(): void {
    if (this.seenNonces.size <= this.maxSeenNonces) return;
    const cutoff = Date.now() - this.maxClockDriftMs * 2;
    for (const [nonce, ts] of this.seenNonces) {
      if (ts < cutoff) {
        this.seenNonces.delete(nonce);
      }
    }
  }

  public reset(): void {
    this.seenNonces.clear();
  }

  public getSeenCount(): number {
    return this.seenNonces.size;
  }
}
