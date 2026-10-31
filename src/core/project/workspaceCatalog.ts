import crypto from "node:crypto";
import path from "node:path";
import { getHistoryDb, getWorkspacesFromDb, type WorkspaceRecord } from "../storage/historyDb.js";
import { listProjects, type RegisteredProject } from "./projectRegistry.js";
import { getTrustedDirectories } from "../config/trustedDirs.js";
import { getWorkspaceChains } from "../workspace/WorkspaceChainConfig.js";
import type { WorkspaceChain } from "../workspace/WorkspaceChainTypes.js";
import {
  classifyWorkspaceTarget,
  normalizeLocalPath,
  pathKey,
  type WorkspaceClassification,
} from "./workspaceCatalogClassifier.js";

export {
  classifyWorkspaceTarget,
  normalizeLocalPath,
  pathKey,
  type WorkspaceClassification,
};
import { isSshTarget, sanitizeSshTarget } from "./sshTargetSanitizer.js";

export type WorkspaceCatalogSource = "registry" | "history" | "trusted" | "active" | "chain";

export interface WorkspaceCatalogEntry {
  catalogId: string;
  canonicalTarget: string;
  displayName: string;
  type: "local" | "ssh" | "chain";
  sources: WorkspaceCatalogSource[];
  registeredProjectId?: string;
  registered: boolean;
  trusted: boolean;
  active: boolean;
  available: boolean;
  sessionCount: number;
  firstSeenAt?: number;
  lastUsedAt?: number;
  gitRoot?: string;
  repositoryIdentity?: string;
  classification: WorkspaceClassification;
  importable: boolean;
  rejectionReasons: string[];
  sanitizedCredentials?: boolean;
  requiresManualProfile?: boolean;
}

export type ActiveSessionSnapshot = {
  workspace?: string;
  sessionId?: string;
  lastActiveTime?: number;
};

export type ActiveSessionProvider = () => ActiveSessionSnapshot[];

let runtimeActiveSessionProvider: ActiveSessionProvider | null = null;

export function registerActiveSessionProvider(provider: ActiveSessionProvider | null): void {
  runtimeActiveSessionProvider = provider;
}

export function getActiveSessionSnapshots(): ActiveSessionSnapshot[] {
  if (runtimeActiveSessionProvider) {
    try {
      return runtimeActiveSessionProvider() || [];
    } catch {
      return [];
    }
  }
  return [];
}

export interface BuildWorkspaceCatalogOptions {
  registryPath?: string;
  historyDb?: any;
  activeSessions?: ActiveSessionSnapshot[];
  includeChains?: boolean;
  allowTempAsProjectRoot?: boolean;
  explicitlyTrustedNamed?: string[] | Set<string>;
}

export interface WorkspaceCatalogFilter {
  classification?: WorkspaceClassification | WorkspaceClassification[];
  registered?: boolean;
  available?: boolean;
  trusted?: boolean;
  active?: boolean;
  type?: "local" | "ssh" | "chain";
  source?: WorkspaceCatalogSource;
  importableOnly?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface WorkspaceCatalogResult {
  entries: WorkspaceCatalogEntry[];
  total: number;
  limit?: number;
  offset?: number;
}

/**
 * Deterministic catalog ID generator based on type and canonical target.
 */
export function deriveCatalogId(canonicalTarget: string, type: string): string {
  const norm = type === "local" ? pathKey(canonicalTarget) : canonicalTarget.trim().toLowerCase();
  const hash = crypto.createHash("sha256").update(`${type}:${norm}`).digest("hex").slice(0, 16);
  return `cat_${hash}`;
}

interface IntermediateCandidate {
  rawTarget: string;
  canonicalTarget: string;
  type: "local" | "ssh" | "chain";
  displayName?: string;
  sources: Set<WorkspaceCatalogSource>;
  registeredProjectId?: string;
  registered: boolean;
  trusted: boolean;
  active: boolean;
  sessionCount: number;
  sessionIds: Set<string>;
  firstSeenAt?: number;
  lastUsedAt?: number;
  sanitizedCredentials?: boolean;
  requiresManualProfile?: boolean;
}

/**
 * Queries session history statistics grouped by workspace_id and working_directory.
 * Collects distinct session IDs to prevent double counting during parent collapse.
 */
function querySessionStats(db: any): {
  byWorkspaceId: Map<string, { count: number; firstSeen?: number; lastUsed?: number; sessionIds: Set<string> }>;
  byPathKey: Map<string, { count: number; firstSeen?: number; lastUsed?: number; sessionIds: Set<string> }>;
} {
  const byWorkspaceId = new Map<string, { count: number; firstSeen?: number; lastUsed?: number; sessionIds: Set<string> }>();
  const byPathKey = new Map<string, { count: number; firstSeen?: number; lastUsed?: number; sessionIds: Set<string> }>();

  if (!db || typeof db.prepare !== "function") {
    return { byWorkspaceId, byPathKey };
  }

  try {
    const stmt = db.prepare(`
      SELECT
        COALESCE(id, '') AS id,
        COALESCE(workspace_id, '') AS ws_id,
        COALESCE(working_directory, '') AS wd,
        COALESCE(created_at, last_modified) AS first_seen,
        COALESCE(last_modified, updated_at, created_at) AS last_used
      FROM sessions
    `);
    const rows = stmt.all() || [];

    for (const row of rows) {
      const sid = String(row.id || "");
      const firstSeen = row.first_seen ? Number(row.first_seen) : undefined;
      const lastUsed = row.last_used ? Number(row.last_used) : undefined;

      if (row.ws_id) {
        let entry = byWorkspaceId.get(row.ws_id);
        if (!entry) {
          entry = { count: 0, sessionIds: new Set<string>() };
          byWorkspaceId.set(row.ws_id, entry);
        }
        if (sid) entry.sessionIds.add(sid);
        entry.count = entry.sessionIds.size;
        if (firstSeen && (!entry.firstSeen || firstSeen < entry.firstSeen)) entry.firstSeen = firstSeen;
        if (lastUsed && (!entry.lastUsed || lastUsed > entry.lastUsed)) entry.lastUsed = lastUsed;
      }

      if (row.wd) {
        const wdStr = String(row.wd).trim();
        let key: string;
        if (isSshTarget(wdStr)) {
          const sanitized = sanitizeSshTarget(wdStr);
          key = sanitized.valid && sanitized.sanitized ? sanitized.sanitized.toLowerCase() : wdStr.toLowerCase();
        } else if (wdStr.startsWith("chain:")) {
          key = wdStr.toLowerCase();
        } else {
          key = pathKey(wdStr);
        }

        let entry = byPathKey.get(key);
        if (!entry) {
          entry = { count: 0, sessionIds: new Set<string>() };
          byPathKey.set(key, entry);
        }
        if (sid) entry.sessionIds.add(sid);
        entry.count = entry.sessionIds.size;
        if (firstSeen && (!entry.firstSeen || firstSeen < entry.firstSeen)) entry.firstSeen = firstSeen;
        if (lastUsed && (!entry.lastUsed || lastUsed > entry.lastUsed)) entry.lastUsed = lastUsed;
      }
    }
  } catch {}

  return { byWorkspaceId, byPathKey };
}

/**
 * Builds the canonical Workspace Catalog derived from:
 * 1. projects.json (registered MCP projects)
 * 2. history.db workspaces & sessions (with self-contained custom DB injection)
 * 3. trusted directories
 * 4. active runtime sessions (via runtime provider fallback)
 * 5. workspace chains
 */
export function buildWorkspaceCatalog(options?: BuildWorkspaceCatalogOptions): WorkspaceCatalogEntry[] {
  const candidates = new Map<string, IntermediateCandidate>();

  function getCandidateKey(raw: string): {
    key: string;
    type: "local" | "ssh" | "chain";
    canonical: string;
    hadCredentials?: boolean;
    requiresManualProfile?: boolean;
  } {
    const trimmed = raw.trim();
    if (isSshTarget(trimmed)) {
      const sanitized = sanitizeSshTarget(trimmed);
      const canonical = sanitized.valid && sanitized.sanitized ? sanitized.sanitized : trimmed;
      return {
        key: `ssh:${canonical.toLowerCase()}`,
        type: "ssh",
        canonical,
        hadCredentials: sanitized.hasStrippedCredentials,
        requiresManualProfile: sanitized.requiresManualProfile,
      };
    }
    if (trimmed.startsWith("chain:")) {
      const canonical = `chain:${trimmed.slice("chain:".length).toLowerCase()}`;
      return { key: canonical, type: "chain", canonical };
    }
    const canonical = normalizeLocalPath(trimmed);
    return { key: `local:${pathKey(canonical)}`, type: "local", canonical };
  }

  function getOrCreateCandidate(raw: string, typeHint?: "local" | "ssh" | "chain"): IntermediateCandidate {
    const { key, type, canonical, hadCredentials, requiresManualProfile } = getCandidateKey(raw);
    let candidate = candidates.get(key);
    if (!candidate) {
      candidate = {
        rawTarget: raw,
        canonicalTarget: canonical,
        type: typeHint || type,
        sources: new Set<WorkspaceCatalogSource>(),
        registered: false,
        trusted: false,
        active: false,
        sessionCount: 0,
        sessionIds: new Set<string>(),
        sanitizedCredentials: hadCredentials,
        requiresManualProfile,
      };
      candidates.set(key, candidate);
    } else {
      if (hadCredentials) candidate.sanitizedCredentials = true;
      if (requiresManualProfile) candidate.requiresManualProfile = true;
    }
    return candidate;
  }

  // 1. Ingest registered MCP projects from projects.json
  const registeredRoots = new Set<string>();
  try {
    const registeredProjects: RegisteredProject[] = listProjects(options?.registryPath);
    for (const project of registeredProjects) {
      let target: string;
      if (project.type === "local") {
        target = project.root || "";
        if (target) registeredRoots.add(pathKey(target));
      } else {
        target = project.target || "";
      }
      if (!target) continue;

      const candidate = getOrCreateCandidate(target, project.type);
      candidate.sources.add("registry");
      candidate.registered = true;
      candidate.registeredProjectId = project.id;
      candidate.displayName = project.name || candidate.displayName;
    }
  } catch {}

  // 2. Resolve history database (self-contained injection support)
  let db: any = null;
  try {
    db = options?.historyDb !== undefined ? options.historyDb : getHistoryDb();
  } catch {}

  // 3. Ingest trusted directories (using injected db if provided)
  try {
    const trusted = getTrustedDirectories(db);
    for (const tPath of trusted) {
      if (!tPath) continue;
      const candidate = getOrCreateCandidate(tPath);
      candidate.sources.add("trusted");
      candidate.trusted = true;
    }
  } catch {}

  // 4. Ingest workspaces and sessions from history.db
  const explicitlyTrustedNamed = new Set<string>();
  if (options?.explicitlyTrustedNamed) {
    for (const item of options.explicitlyTrustedNamed) {
      if (item) explicitlyTrustedNamed.add(pathKey(item));
    }
  }

  const { byWorkspaceId, byPathKey } = querySessionStats(db);

  try {
    const wsRecords: WorkspaceRecord[] = db ? getWorkspacesFromDb(db) : [];
    for (const ws of wsRecords) {
      if (!ws.path) continue;
      const candidate = getOrCreateCandidate(ws.path);
      candidate.sources.add("history");
      if (ws.isTrusted) {
        candidate.sources.add("trusted");
        candidate.trusted = true;
      }
      if (!candidate.displayName && ws.name && ws.name !== path.basename(ws.path)) {
        candidate.displayName = ws.name;
      }
      // Populate explicitlyTrustedNamed: trusted workspace with custom/deliberate name
      if (ws.isTrusted && ws.name) {
        const trimmedName = ws.name.trim();
        const baseName = path.basename(ws.path).trim();
        if (trimmedName && trimmedName.toLowerCase() !== baseName.toLowerCase()) {
          explicitlyTrustedNamed.add(pathKey(ws.path));
        }
      }
      if (ws.createdAt && (!candidate.firstSeenAt || ws.createdAt < candidate.firstSeenAt)) {
        candidate.firstSeenAt = ws.createdAt;
      }
      if (ws.updatedAt && (!candidate.lastUsedAt || ws.updatedAt > candidate.lastUsedAt)) {
        candidate.lastUsedAt = ws.updatedAt;
      }

      // Attach session stats by workspace_id
      const statsByWsId = byWorkspaceId.get(ws.id);
      if (statsByWsId) {
        for (const sid of statsByWsId.sessionIds) candidate.sessionIds.add(sid);
        candidate.sessionCount = Math.max(candidate.sessionCount, candidate.sessionIds.size);
        if (statsByWsId.firstSeen && (!candidate.firstSeenAt || statsByWsId.firstSeen < candidate.firstSeenAt)) {
          candidate.firstSeenAt = statsByWsId.firstSeen;
        }
        if (statsByWsId.lastUsed && (!candidate.lastUsedAt || statsByWsId.lastUsed > candidate.lastUsedAt)) {
          candidate.lastUsedAt = statsByWsId.lastUsed;
        }
      }
    }
  } catch {}

  // Ingest any session paths that weren't in workspaces table
  for (const [key, stats] of byPathKey.entries()) {
    let target = key;
    if (key.startsWith("ssh:") || key.startsWith("chain:")) {
      target = key;
    }
    const candidate = getOrCreateCandidate(target);
    candidate.sources.add("history");
    for (const sid of stats.sessionIds) candidate.sessionIds.add(sid);
    candidate.sessionCount = Math.max(candidate.sessionCount, candidate.sessionIds.size);
    if (stats.firstSeen && (!candidate.firstSeenAt || stats.firstSeen < candidate.firstSeenAt)) {
      candidate.firstSeenAt = stats.firstSeen;
    }
    if (stats.lastUsed && (!candidate.lastUsedAt || stats.lastUsed > candidate.lastUsedAt)) {
      candidate.lastUsedAt = stats.lastUsed;
    }
  }

  // 5. Ingest active runtime sessions (use injected options, or fall back to registered provider)
  const activeSessionsList = options?.activeSessions !== undefined
    ? options.activeSessions
    : getActiveSessionSnapshots();

  for (const session of activeSessionsList) {
    if (!session.workspace) continue;
    const candidate = getOrCreateCandidate(session.workspace);
    candidate.sources.add("active");
    candidate.active = true;
    if (session.lastActiveTime && (!candidate.lastUsedAt || session.lastActiveTime > candidate.lastUsedAt)) {
      candidate.lastUsedAt = session.lastActiveTime;
    }
  }

  // 6. Ingest Workspace Chains
  if (options?.includeChains !== false) {
    try {
      const chains: WorkspaceChain[] = getWorkspaceChains(undefined, false);
      for (const chain of chains) {
        if (!chain.id) continue;
        const candidate = getOrCreateCandidate(`chain:${chain.id}`, "chain");
        candidate.sources.add("chain");
        if (!candidate.displayName && chain.name) {
          candidate.displayName = chain.name;
        }
      }
    } catch {}
  }

  // 7. Parent Collapse & Usage Aggregation Pass:
  // Non-independent nested workspaces roll their usage into their parent Git repository
  // to avoid artificial fragmentation, while preserving independent projects.
  const initialCandidates = Array.from(candidates.values());
  for (const candidate of initialCandidates) {
    if (candidate.type !== "local") continue;

    const classificationRes = classifyWorkspaceTarget(candidate.canonicalTarget, {
      registeredRoots,
      explicitlyTrustedNamed,
      allowTempAsProjectRoot: options?.allowTempAsProjectRoot,
    });

    if (classificationRes.classification === "nested-project" && !classificationRes.importable) {
      const parentRoot = classificationRes.gitRoot;
      if (parentRoot && typeof parentRoot === "string") {
        const parentCanonical = normalizeLocalPath(parentRoot);
        if (pathKey(parentCanonical) !== pathKey(candidate.canonicalTarget)) {
          const parentCandidate = getOrCreateCandidate(parentCanonical, "local");
          parentCandidate.sources.add("history");
          for (const sid of candidate.sessionIds) {
            parentCandidate.sessionIds.add(sid);
          }
          parentCandidate.sessionCount = Math.max(parentCandidate.sessionCount, parentCandidate.sessionIds.size);
          if (candidate.firstSeenAt) {
            parentCandidate.firstSeenAt = parentCandidate.firstSeenAt
              ? Math.min(parentCandidate.firstSeenAt, candidate.firstSeenAt)
              : candidate.firstSeenAt;
          }
          if (candidate.lastUsedAt) {
            parentCandidate.lastUsedAt = parentCandidate.lastUsedAt
              ? Math.max(parentCandidate.lastUsedAt, candidate.lastUsedAt)
              : candidate.lastUsedAt;
          }
        }
      }
    }
  }

  // 8. Classify and transform intermediate candidates into WorkspaceCatalogEntry
  const entries: WorkspaceCatalogEntry[] = [];

  for (const candidate of candidates.values()) {
    const classificationRes = classifyWorkspaceTarget(candidate.canonicalTarget, {
      registeredRoots,
      explicitlyTrustedNamed,
      allowTempAsProjectRoot: options?.allowTempAsProjectRoot,
    });

    const catalogId = deriveCatalogId(candidate.canonicalTarget, candidate.type);

    let displayName = candidate.displayName;
    if (!displayName) {
      if (candidate.type === "local") {
        displayName = path.basename(candidate.canonicalTarget) || candidate.canonicalTarget;
      } else if (candidate.type === "ssh") {
        try {
          const parsed = new URL(candidate.canonicalTarget);
          displayName = path.posix.basename(parsed.pathname) || parsed.hostname;
        } catch {
          displayName = candidate.canonicalTarget;
        }
      } else {
        displayName = candidate.canonicalTarget;
      }
    }

    // Determine importable:
    // Only valid candidates that are NOT yet registered can be imported.
    const isAlreadyRegistered = candidate.registered;
    const importable = classificationRes.importable && !isAlreadyRegistered && classificationRes.available;

    const rejectionReasons = [...classificationRes.rejectionReasons];
    if (isAlreadyRegistered && !rejectionReasons.includes("Already registered in MCP project registry.")) {
      rejectionReasons.push("Already registered in MCP project registry.");
    }

    entries.push({
      catalogId,
      canonicalTarget: classificationRes.canonicalTarget,
      displayName,
      type: candidate.type,
      sources: Array.from(candidate.sources),
      registeredProjectId: candidate.registeredProjectId,
      registered: candidate.registered,
      trusted: candidate.trusted,
      active: candidate.active,
      available: classificationRes.available,
      sessionCount: candidate.sessionCount,
      firstSeenAt: candidate.firstSeenAt,
      lastUsedAt: candidate.lastUsedAt,
      gitRoot: classificationRes.gitRoot,
      repositoryIdentity: classificationRes.repositoryIdentity,
      classification: classificationRes.classification,
      importable,
      rejectionReasons,
      sanitizedCredentials: candidate.sanitizedCredentials,
      requiresManualProfile: candidate.requiresManualProfile,
    });
  }

  // 9. Deterministic sorting:
  // 1. Registered first
  // 2. Last used descending
  // 3. Session count descending
  // 4. Display name ascending
  // 5. Canonical target ascending
  entries.sort((a, b) => {
    if (a.registered !== b.registered) {
      return a.registered ? -1 : 1;
    }
    const aUsed = a.lastUsedAt || 0;
    const bUsed = b.lastUsedAt || 0;
    if (bUsed !== aUsed) {
      return bUsed - aUsed;
    }
    if (b.sessionCount !== a.sessionCount) {
      return b.sessionCount - a.sessionCount;
    }
    const nameDiff = a.displayName.localeCompare(b.displayName);
    if (nameDiff !== 0) return nameDiff;
    return a.canonicalTarget.localeCompare(b.canonicalTarget);
  });

  return entries;
}

/**
 * Filters and paginates catalog entries based on query/criteria.
 */
export function queryWorkspaceCatalog(
  filter?: WorkspaceCatalogFilter,
  options?: BuildWorkspaceCatalogOptions,
): WorkspaceCatalogResult {
  const allEntries = buildWorkspaceCatalog(options);

  let filtered = allEntries;

  if (filter) {
    if (filter.classification !== undefined) {
      const allowed = Array.isArray(filter.classification)
        ? new Set(filter.classification)
        : new Set([filter.classification]);
      filtered = filtered.filter((entry) => allowed.has(entry.classification));
    }

    if (filter.registered !== undefined) {
      filtered = filtered.filter((entry) => entry.registered === filter.registered);
    }

    if (filter.available !== undefined) {
      filtered = filtered.filter((entry) => entry.available === filter.available);
    }

    if (filter.trusted !== undefined) {
      filtered = filtered.filter((entry) => entry.trusted === filter.trusted);
    }

    if (filter.active !== undefined) {
      filtered = filtered.filter((entry) => entry.active === filter.active);
    }

    if (filter.type !== undefined) {
      filtered = filtered.filter((entry) => entry.type === filter.type);
    }

    if (filter.source !== undefined) {
      filtered = filtered.filter((entry) => entry.sources.includes(filter.source!));
    }

    if (filter.importableOnly) {
      filtered = filtered.filter((entry) => entry.importable === true);
    }

    if (filter.query) {
      const q = filter.query.trim().toLowerCase();
      filtered = filtered.filter((entry) => {
        return (
          entry.displayName.toLowerCase().includes(q) ||
          entry.canonicalTarget.toLowerCase().includes(q) ||
          (entry.registeredProjectId && entry.registeredProjectId.toLowerCase().includes(q)) ||
          entry.catalogId.toLowerCase().includes(q)
        );
      });
    }
  }

  const total = filtered.length;
  const offset = filter?.offset && filter.offset > 0 ? filter.offset : 0;
  const limit = filter?.limit && filter.limit > 0 ? filter.limit : undefined;

  const entries = limit ? filtered.slice(offset, offset + limit) : filtered.slice(offset);

  return {
    entries,
    total,
    limit,
    offset,
  };
}

/**
 * Finds a single catalog entry by catalogId, registeredProjectId, or canonicalTarget.
 */
export function getWorkspaceCatalogEntry(
  catalogIdOrTarget: string,
  options?: BuildWorkspaceCatalogOptions,
): WorkspaceCatalogEntry | null {
  if (!catalogIdOrTarget || typeof catalogIdOrTarget !== "string") return null;
  const needle = catalogIdOrTarget.trim();
  const lowerNeedle = needle.toLowerCase();
  const normPathKey = pathKey(needle);

  const allEntries = buildWorkspaceCatalog(options);

  return (
    allEntries.find((entry) => {
      if (entry.catalogId === needle || entry.catalogId.toLowerCase() === lowerNeedle) return true;
      if (entry.registeredProjectId && entry.registeredProjectId.toLowerCase() === lowerNeedle) return true;
      if (entry.canonicalTarget === needle) return true;
      if (entry.type === "local" && pathKey(entry.canonicalTarget) === normPathKey) return true;
      if (entry.canonicalTarget.toLowerCase() === lowerNeedle) return true;
      return false;
    }) || null
  );
}
