/**
 * mcpIdentityPresence.ts - Ephemeral In-Memory MCP Identity Presence Registry.
 *
 * Tracks successfully authenticated MCP client identities observed by the MCP
 * HTTP transport. Provides sanitized metadata for UI and operator routing
 * without persisting credentials, tokens, or credential hashes to disk.
 *
 * SECURITY INVARIANTS:
 * - In-memory only. NEVER persist identities or tokens to disk.
 * - Sanitized metadata exposed to UI/operator endpoints contains ONLY:
 *   identityHandle, mode, subject, scopes, and lastSeenAt.
 * - credentialHash is retained internally strictly for projectAccessPolicy
 *   grant/revoke authorization and is NEVER returned in sanitized responses.
 * - Bounded capacity and TTL expiration (default 4 hours) prevent unbounded growth.
 */

import crypto from "node:crypto";
import type { McpAuthMode, McpIdentity } from "./mcpAuth.js";
import type { ProjectAccessIdentity } from "../project/projectAccessPolicy.js";

export const DEFAULT_MAX_IDENTITIES = 50;
export const DEFAULT_IDENTITY_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export interface SanitizedMcpIdentity {
  identityHandle: string;
  mode: McpAuthMode;
  subject: string;
  scopes: string[];
  lastSeenAt: number;
}

interface StoredMcpIdentityEntry {
  identityHandle: string;
  identity: ProjectAccessIdentity;
  scopes: string[];
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface McpIdentityPresenceOptions {
  now?: number;
  maxIdentities?: number;
  ttlMs?: number;
}

// In-memory store: identityHandle -> StoredMcpIdentityEntry
const presenceRegistry = new Map<string, StoredMcpIdentityEntry>();

/**
 * Derives a stable, opaque identityHandle for an authenticated identity.
 * Uses a SHA-256 digest slice over the tuple so the handle is deterministic
 * across repeat calls for the same identity without exposing the token or hash.
 */
export function deriveIdentityHandle(identity: Pick<McpIdentity, "mode" | "subject"> & { credentialHash?: string }): string {
  const rawTuple = `${identity.mode}:${identity.subject}:${identity.credentialHash || ""}`;
  const digest = crypto.createHash("sha256").update(rawTuple, "utf8").digest("hex");
  return `idh_${digest.slice(0, 16)}`;
}

/**
 * Removes identities that have exceeded the TTL window.
 */
export function pruneStaleIdentities(options?: McpIdentityPresenceOptions): number {
  const now = options?.now ?? Date.now();
  const ttlMs = options?.ttlMs ?? DEFAULT_IDENTITY_TTL_MS;
  let prunedCount = 0;

  for (const [handle, entry] of presenceRegistry.entries()) {
    if (now - entry.lastSeenAt > ttlMs) {
      presenceRegistry.delete(handle);
      prunedCount++;
    }
  }

  return prunedCount;
}

/**
 * Records an authenticated MCP identity upon successful transport authentication.
 * Returns the sanitized identity representation.
 */
export function recordMcpIdentityPresence(
  identity: (McpIdentity | ProjectAccessIdentity) & { scopes?: string[] },
  options?: McpIdentityPresenceOptions,
): SanitizedMcpIdentity {
  if (!identity || typeof identity.subject !== "string" || !identity.subject.trim()) {
    throw new Error("Cannot record MCP identity presence without a valid subject.");
  }

  const now = options?.now ?? Date.now();
  const maxIdentities = options?.maxIdentities ?? DEFAULT_MAX_IDENTITIES;
  pruneStaleIdentities(options);

  const handle = deriveIdentityHandle(identity);
  const existing = presenceRegistry.get(handle);

  if (existing) {
    existing.lastSeenAt = now;
    if (Array.isArray(identity.scopes) && identity.scopes.length > 0) {
      existing.scopes = [...new Set([...existing.scopes, ...identity.scopes])];
    }
    return toSanitizedIdentity(existing);
  }

  // Enforce bounded size: evict oldest if at capacity
  if (presenceRegistry.size >= maxIdentities) {
    let oldestHandle: string | null = null;
    let oldestTime = Infinity;
    for (const [h, item] of presenceRegistry.entries()) {
      if (item.lastSeenAt < oldestTime) {
        oldestTime = item.lastSeenAt;
        oldestHandle = h;
      }
    }
    if (oldestHandle) {
      presenceRegistry.delete(oldestHandle);
    }
  }

  const newEntry: StoredMcpIdentityEntry = {
    identityHandle: handle,
    identity: {
      mode: identity.mode,
      subject: identity.subject,
      credentialHash: identity.credentialHash,
    },
    scopes: Array.isArray(identity.scopes) ? [...identity.scopes] : [],
    firstSeenAt: now,
    lastSeenAt: now,
  };

  presenceRegistry.set(handle, newEntry);
  return toSanitizedIdentity(newEntry);
}

/**
 * Retrieves the internal ProjectAccessIdentity for a handle, needed by
 * projectAccessPolicy for grant/revoke operations.
 * Returns null if not found or expired.
 */
export function getMcpIdentityByHandle(
  handle: string,
  options?: McpIdentityPresenceOptions,
): ProjectAccessIdentity | null {
  if (!handle || typeof handle !== "string") return null;
  pruneStaleIdentities(options);
  const entry = presenceRegistry.get(handle);
  if (!entry) return null;
  return {
    mode: entry.identity.mode,
    subject: entry.identity.subject,
    credentialHash: entry.identity.credentialHash,
  };
}

/**
 * Retrieves a sanitized identity representation by handle.
 */
export function getSanitizedMcpIdentity(
  handle: string,
  options?: McpIdentityPresenceOptions,
): SanitizedMcpIdentity | null {
  if (!handle || typeof handle !== "string") return null;
  pruneStaleIdentities(options);
  const entry = presenceRegistry.get(handle);
  return entry ? toSanitizedIdentity(entry) : null;
}

/**
 * Lists all active sanitized MCP identities, ordered by most recently seen first.
 */
export function listSanitizedMcpIdentities(options?: McpIdentityPresenceOptions): SanitizedMcpIdentity[] {
  pruneStaleIdentities(options);
  return Array.from(presenceRegistry.values())
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map(toSanitizedIdentity);
}

/**
 * Returns the handle of the most recently seen active identity, or null if none.
 */
export function getMostRecentMcpIdentityHandle(options?: McpIdentityPresenceOptions): string | null {
  const list = listSanitizedMcpIdentities(options);
  return list.length > 0 ? list[0].identityHandle : null;
}

/**
 * Resets the in-memory presence registry. Used in tests and lifecycle restarts.
 */
export function clearMcpIdentityPresence(): void {
  presenceRegistry.clear();
}

/**
 * Returns the current active count of registered identities in memory.
 */
export function getMcpIdentityPresenceCount(options?: McpIdentityPresenceOptions): number {
  pruneStaleIdentities(options);
  return presenceRegistry.size;
}

function toSanitizedIdentity(entry: StoredMcpIdentityEntry): SanitizedMcpIdentity {
  return {
    identityHandle: entry.identityHandle,
    mode: entry.identity.mode,
    subject: entry.identity.subject,
    scopes: [...entry.scopes],
    lastSeenAt: entry.lastSeenAt,
  };
}
