import { getDelegateMcpPrincipalId } from "../browserTransport/delegatePrincipalPolicy.js";

export type DelegateSemanticAffinitySource = "explicit" | "created" | "observed";
export type DelegateSemanticAffinity = Readonly<{
  clientId: string;
  tabId: number;
  source: DelegateSemanticAffinitySource;
  expiresAt: number;
}>;

const TTL_MS = 2 * 60 * 60_000;
const entries = new Map<string, DelegateSemanticAffinity>();

function validClientId(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,80}$/.test(value);
}
function validTabId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
function key(clientId: string): string | null {
  const principal = getDelegateMcpPrincipalId();
  if (!principal) return null;
  return principal + "|" + clientId;
}
function purge(now = Date.now()): void {
  for (const [id, entry] of entries) if (entry.expiresAt <= now) entries.delete(id);
}

export function bindDelegateSemanticAffinity(
  clientId: string,
  tabId: number,
  source: DelegateSemanticAffinitySource,
  now = Date.now(),
): DelegateSemanticAffinity | null {
  if (!validClientId(clientId) || !validTabId(tabId)) {
    throw new Error("DELEGATE_AFFINITY_TARGET_INVALID");
  }
  const id = key(clientId);
  if (!id) return null;
  purge(now);
  const next = Object.freeze({ clientId, tabId, source, expiresAt: now + TTL_MS });
  entries.set(id, next);
  return next;
}

export function resolveDelegateSemanticAffinity(
  clientId: string,
  options: { write?: boolean; now?: number } = {},
): DelegateSemanticAffinity | null {
  if (!validClientId(clientId)) return null;
  const id = key(clientId);
  if (!id) return null;
  const now = options.now ?? Date.now();
  purge(now);
  const entry = entries.get(id) ?? null;
  if (!entry) return null;
  if (options.write && entry.source === "observed") return null;
  if (entry.expiresAt <= now) {
    entries.delete(id);
    return null;
  }
  return entry;
}

export function clearDelegateSemanticAffinity(clientId: string, tabId?: number): void {
  const id = key(clientId);
  if (!id) return;
  const existing = entries.get(id);
  if (!existing) return;
  if (tabId === undefined || existing.tabId === tabId) entries.delete(id);
}

export function inspectDelegateSemanticAffinity(clientId: string): DelegateSemanticAffinity | null {
  return resolveDelegateSemanticAffinity(clientId);
}
