import { buildWorkspaceCatalog, type WorkspaceCatalogEntry, type BuildWorkspaceCatalogOptions } from "./workspaceCatalog.js";
import { registerProject, type RegisteredProject } from "./projectRegistry.js";
import { isSshTarget, sanitizeSshTarget } from "./sshTargetSanitizer.js";

export interface MigrationCandidateSummary {
  catalogId: string;
  name: string;
  target: string;
  type: "local" | "ssh" | "chain";
  sessionCount: number;
  lastUsedAt?: number;
}

export interface MigrationInventory {
  totalEntries: number;
  registeredCount: number;
  validCandidateCount: number;
  worktreesCount: number;
  testFixtureCount: number;
  temporaryCount: number;
  missingCount: number;
  unsafeCount: number;
  nestedMonorepoCount: number;
  sshSanitizedCount: number;
  details: {
    validCandidates: MigrationCandidateSummary[];
    worktrees: Array<{ target: string; reason: string }>;
    temporaryOrFixtures: Array<{ target: string; reason: string }>;
    missing: Array<{ target: string; reason?: string }>;
    unsafe: Array<{ target: string; reason: string }>;
    alreadyRegistered: Array<{ id?: string; target: string }>;
  };
}

export interface ReconcileOptions extends BuildWorkspaceCatalogOptions {
  dryRun?: boolean;
  selectedCatalogIds?: string[];
}

export interface ReconcileResult {
  mode: "dry-run" | "apply";
  inventory: MigrationInventory;
  imported: RegisteredProject[];
  errors: Array<{ catalogId: string; target: string; error: string }>;
  capabilitiesGranted: false;
}

/**
 * Inspects all Workspace Catalog entries and generates an audit inventory
 * breaking down valid candidates, worktrees, test fixtures, missing dirs, and unsafe targets.
 */
export function generateMigrationInventory(options?: BuildWorkspaceCatalogOptions): MigrationInventory {
  const allEntries = buildWorkspaceCatalog(options);

  const validCandidates: MigrationCandidateSummary[] = [];
  const worktrees: Array<{ target: string; reason: string }> = [];
  const temporaryOrFixtures: Array<{ target: string; reason: string }> = [];
  const missing: Array<{ target: string; reason?: string }> = [];
  const unsafe: Array<{ target: string; reason: string }> = [];
  const alreadyRegistered: Array<{ id?: string; target: string }> = [];

  let nestedMonorepoCount = 0;
  let sshSanitizedCount = 0;

  for (const entry of allEntries) {
    if (entry.registered) {
      alreadyRegistered.push({
        id: entry.registeredProjectId,
        target: entry.canonicalTarget,
      });
      continue;
    }

    if (entry.sanitizedCredentials) {
      sshSanitizedCount++;
    }

    switch (entry.classification) {
      case "worktree":
        worktrees.push({
          target: entry.canonicalTarget,
          reason: entry.rejectionReasons.join("; ") || "Worktree directory",
        });
        break;
      case "temporary":
      case "test-fixture":
        temporaryOrFixtures.push({
          target: entry.canonicalTarget,
          reason: entry.rejectionReasons.join("; ") || "Temporary or test directory",
        });
        break;
      case "missing":
        missing.push({
          target: entry.canonicalTarget,
          reason: entry.rejectionReasons.join("; ") || "Directory does not exist",
        });
        break;
      case "unsafe":
        unsafe.push({
          target: entry.canonicalTarget,
          reason: entry.rejectionReasons.join("; ") || "Unsafe target",
        });
        break;
      case "nested-project":
        nestedMonorepoCount++;
        if (entry.importable && entry.available) {
          validCandidates.push({
            catalogId: entry.catalogId,
            name: entry.displayName,
            target: entry.canonicalTarget,
            type: entry.type,
            sessionCount: entry.sessionCount,
            lastUsedAt: entry.lastUsedAt,
          });
        } else {
          temporaryOrFixtures.push({
            target: entry.canonicalTarget,
            reason: entry.rejectionReasons.join("; ") || "Monorepo nested directory",
          });
        }
        break;
      case "project":
        if (entry.importable && entry.available) {
          validCandidates.push({
            catalogId: entry.catalogId,
            name: entry.displayName,
            target: entry.canonicalTarget,
            type: entry.type,
            sessionCount: entry.sessionCount,
            lastUsedAt: entry.lastUsedAt,
          });
        } else if (!entry.available) {
          missing.push({
            target: entry.canonicalTarget,
            reason: entry.rejectionReasons.join("; ") || "Target not available",
          });
        }
        break;
      default:
        unsafe.push({
          target: entry.canonicalTarget,
          reason: entry.rejectionReasons.join("; ") || "Unknown classification",
        });
        break;
    }
  }

  return {
    totalEntries: allEntries.length,
    registeredCount: alreadyRegistered.length,
    validCandidateCount: validCandidates.length,
    worktreesCount: worktrees.length,
    testFixtureCount: temporaryOrFixtures.filter((t) => t.reason.toLowerCase().includes("fixture") || t.reason.toLowerCase().includes("test")).length,
    temporaryCount: temporaryOrFixtures.length,
    missingCount: missing.length,
    unsafeCount: unsafe.length,
    nestedMonorepoCount,
    sshSanitizedCount,
    details: {
      validCandidates,
      worktrees,
      temporaryOrFixtures,
      missing,
      unsafe,
      alreadyRegistered,
    },
  };
}

/**
 * Performs reconciliation of historical workspace candidates into MCP project registry.
 * Default mode is dry-run.
 * When apply is executed:
 * - Only valid candidates are registered.
 * - History rows are NEVER deleted.
 * - Capabilities are NEVER granted (registration != authorization).
 */
export function reconcileHistoricalWorkspaces(options?: ReconcileOptions): ReconcileResult {
  const isDryRun = options?.dryRun !== false;
  const inventory = generateMigrationInventory(options);

  if (isDryRun) {
    return {
      mode: "dry-run",
      inventory,
      imported: [],
      errors: [],
      capabilitiesGranted: false,
    };
  }

  // Apply mode: strictly require explicit selectedCatalogIds; blanket auto-import is prohibited
  if (!options?.selectedCatalogIds || options.selectedCatalogIds.length === 0) {
    throw new Error("Apply mode requires explicit selectedCatalogIds. Blanket auto-import is prohibited.");
  }
  const uniqueIds = Array.from(
    new Set(options.selectedCatalogIds.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean)),
  );
  if (uniqueIds.length === 0) {
    throw new Error("Apply mode requires explicit selectedCatalogIds. Blanket auto-import is prohibited.");
  }
  if (uniqueIds.length > 100) {
    throw new Error("Too many selectedCatalogIds in a single reconciliation (maximum 100).");
  }

  const imported: RegisteredProject[] = [];
  const errors: Array<{ catalogId: string; target: string; error: string }> = [];

  const selectedSet = new Set(uniqueIds);
  const candidatesToImport = inventory.details.validCandidates.filter((cand) =>
    selectedSet.has(cand.catalogId),
  );

  for (const cand of candidatesToImport) {
    try {
      const reg = registerProject(
        {
          name: cand.name,
          type: cand.type,
          root: cand.type === "local" ? cand.target : undefined,
          target: cand.type !== "local" ? cand.target : undefined,
          tags: ["catalog", "historical-import"],
        },
        options?.registryPath,
      );
      imported.push(reg);
    } catch (err) {
      errors.push({
        catalogId: cand.catalogId,
        target: cand.target,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    mode: "apply",
    inventory,
    imported,
    errors,
    capabilitiesGranted: false,
  };
}
