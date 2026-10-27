/**
 * mcpOAuthPersistentStore.ts - issuer-scoped persistent OAuth state for the
 * production MCP tunnel owner.
 *
 * Why this exists: the tunnel owner used to create an in-memory `McpOAuthStore`,
 * so every owner restart destroyed every access/refresh token. Connected clients
 * (ChatGPT, Gemini, ...) kept presenting their cached token, received 401 on
 * `/mcp`, and reported "authentication succeeded, tool discovery failed" until
 * they were removed and re-authorized.
 *
 * This module reuses the existing R2 durable store (`McpDurableOAuthStore`)
 * instead of inventing another state format. State lives in a directory derived
 * from the issuer URL, so a rotated public URL never collides with the previous
 * issuer. Raw tokens are never written: only SHA-256 hashes are persisted and
 * the HMAC key is protected with Windows DPAPI (CurrentUser).
 *
 * Persistence is best effort by design:
 * - Non-Windows hosts have no DPAPI, so they keep the previous in-memory
 *   behavior instead of writing a plaintext issuer key.
 * - An unusable state directory falls back to in-memory and reports a reason,
 *   because refusing to start would take the whole MCP endpoint offline.
 *   The durable store itself still fails closed once loaded (tamper detection,
 *   stale writer, integrity mismatch).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpOAuthStore } from "./mcpOAuthStore.js";
import { McpDurableOAuthStore } from "./mcpDurableOAuthStore.js";

/** Why production persistence is not active. Never contains credentials. */
export type McpOAuthPersistenceFallback = "unsupported-issuer" | "dpapi-unavailable" | "init-failed";

/** Human-readable operator hint for a fallback reason. */
export const MCP_OAUTH_PERSISTENCE_HINT: Record<McpOAuthPersistenceFallback, string> = {
  "unsupported-issuer": "issuer is not a public HTTPS origin",
  "dpapi-unavailable": "Windows DPAPI is unavailable on this platform",
  "init-failed": "issuer state directory could not be loaded",
};

export interface McpOAuthStoreSelection {
  store: McpOAuthStore;
  /** True when tokens survive an owner restart for the same issuer. */
  persistent: boolean;
  /** Issuer-scoped state directory (set when persistence is active). */
  profileDir?: string;
  /** Set when the store fell back to in-memory. */
  reason?: McpOAuthPersistenceFallback;
}

export interface CreateMcpOAuthStoreOptions {
  /** Public OAuth issuer (no trailing slash required). */
  issuer: string;
  /** Root directory for issuer-scoped state; defaults to ~/.superagent-r/mcp-oauth. */
  rootDir?: string;
  /** Platform override for tests. */
  platform?: NodeJS.Platform;
}

/** Mirrors McpDurableOAuthStore's issuer contract: public HTTPS or loopback. */
export function isPersistableMcpOAuthIssuer(issuer: string): boolean {
  const value = issuer.trim();
  return /^https:\/\/[^\s/#?]+/.test(value) || /^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(value);
}

/** Stable issuer-scoped state directory. Different issuers never share state. */
export function issuerOAuthStateDir(issuer: string, rootDir?: string): string {
  const base = rootDir && rootDir.trim()
    ? rootDir
    : path.join(os.homedir(), ".superagent-r", "mcp-oauth");
  const digest = crypto.createHash("sha256").update(issuer.trim().replace(/\/$/, "")).digest("hex").slice(0, 16);
  return path.join(base, `issuer-${digest}`);
}

/**
 * Choose the OAuth store for a production owner: issuer-scoped durable state
 * when the platform can protect it, otherwise the previous in-memory store.
 */
export function createPersistentMcpOAuthStore(opts: CreateMcpOAuthStoreOptions): McpOAuthStoreSelection {
  const issuer = opts.issuer.trim().replace(/\/$/, "");
  if (!isPersistableMcpOAuthIssuer(issuer)) {
    return { store: new McpOAuthStore(), persistent: false, reason: "unsupported-issuer" };
  }
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") {
    return { store: new McpOAuthStore(), persistent: false, reason: "dpapi-unavailable" };
  }
  const profileDir = issuerOAuthStateDir(issuer, opts.rootDir);
  try {
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(profileDir, 0o700); } catch { /* best effort on non-POSIX filesystems */ }
    const store = new McpDurableOAuthStore(profileDir, issuer);
    // Bounded growth: drop records that expired while the owner was offline.
    try { store.cleanupExpired(); } catch { /* the durable store fails closed on its own */ }
    return { store, persistent: true, profileDir };
  } catch {
    return {
      store: new McpOAuthStore(),
      persistent: false,
      reason: "init-failed",
      profileDir,
    };
  }
}

/** Short operator-facing description of the selected OAuth state backend. */
export function describeMcpOAuthStore(selection: Pick<McpOAuthStoreSelection, "persistent" | "reason">): string {
  if (selection.persistent) return "persistent (issuer-scoped)";
  if (selection.reason) return `in-memory (${MCP_OAUTH_PERSISTENCE_HINT[selection.reason]})`;
  return "in-memory";
}
