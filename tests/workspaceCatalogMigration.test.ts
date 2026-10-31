import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generateMigrationInventory,
  reconcileHistoricalWorkspaces,
} from "../src/core/project/workspaceCatalogMigration.js";
import { listProjects } from "../src/core/project/projectRegistry.js";
import { saveWorkspaceToDb, closeHistoryDb, getWorkspacesFromDb } from "../src/core/storage/historyDb.js";
import { hasProjectAccess } from "../src/core/project/projectAccessPolicy.js";

let configDir: string;
let previousConfigDir: string | undefined;
let testRoot: string;

beforeEach(() => {
  previousConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-mig-config-"));
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-mig-root-"));
  process.env.SUPERAGENT_CONFIG_DIR = configDir;
  process.env.SUPERAGENT_ALLOW_TEMP_WORKSPACE = "1";
});

afterEach(() => {
  closeHistoryDb();
  if (previousConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = previousConfigDir;
  delete process.env.SUPERAGENT_ALLOW_TEMP_WORKSPACE;
  try {
    fs.rmSync(configDir, { recursive: true, force: true });
  } catch {}
  try {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } catch {}
  vi.unstubAllEnvs();
});

describe("Workspace Catalog Historical Migration (M7)", () => {
  it("generates structured migration inventory categorizing history rows", () => {
    // 1. Valid project
    const validProj = path.join(testRoot, "valid-mig-proj");
    fs.mkdirSync(path.join(validProj, ".git"), { recursive: true });
    saveWorkspaceToDb({ id: "ws-valid", path: validProj, name: "Valid Project", isTrusted: true });

    // 2. Worktree
    const wtDir = path.join(testRoot, ".worktrees", "wt-mig");
    fs.mkdirSync(wtDir, { recursive: true });
    saveWorkspaceToDb({ id: "ws-wt", path: wtDir, name: "WT", isTrusted: true });

    // 3. Missing directory
    const missingDir = path.join(testRoot, "missing-mig-dir");
    saveWorkspaceToDb({ id: "ws-missing", path: missingDir, name: "Missing", isTrusted: true });

    // 4. SSH with credential query param
    const sshRaw = "ssh://root@192.168.1.50:22/opt/app?key=C:\\id_rsa";
    saveWorkspaceToDb({ id: "ws-ssh", path: sshRaw, name: "Remote SSH", isTrusted: true });

    const inventory = generateMigrationInventory();

    expect(inventory.totalEntries).toBeGreaterThanOrEqual(4);
    expect(inventory.validCandidateCount).toBeGreaterThanOrEqual(2); // validProj + sanitized ssh
    expect(inventory.worktreesCount).toBeGreaterThanOrEqual(1);
    expect(inventory.missingCount).toBeGreaterThanOrEqual(1);
    expect(inventory.sshSanitizedCount).toBe(1);

    const validTargets = inventory.details.validCandidates.map((c) => c.target);
    expect(validTargets).not.toContain(wtDir);
    expect(validTargets).not.toContain(missingDir);
  });

  it("performs dry-run reconciliation without writing to registry or deleting history", () => {
    const validProj = path.join(testRoot, "dry-run-proj");
    fs.mkdirSync(path.join(validProj, ".git"), { recursive: true });
    saveWorkspaceToDb({ id: "ws-dry", path: validProj, name: "Dry Run Project", isTrusted: true });

    const result = reconcileHistoricalWorkspaces({ dryRun: true });
    expect(result.mode).toBe("dry-run");
    expect(result.imported).toHaveLength(0);
    expect(result.capabilitiesGranted).toBe(false);

    // Registry remains empty
    expect(listProjects()).toHaveLength(0);

    // History rows preserved
    expect(getWorkspacesFromDb().length).toBeGreaterThanOrEqual(1);
  });

  it("applies reconciliation for selected candidates without auto-granting capabilities", () => {
    const p1 = path.join(testRoot, "apply-proj-1");
    const p2 = path.join(testRoot, "apply-proj-2");
    fs.mkdirSync(path.join(p1, ".git"), { recursive: true });
    fs.mkdirSync(path.join(p2, ".git"), { recursive: true });

    saveWorkspaceToDb({ id: "ws-a1", path: p1, name: "Apply Proj 1", isTrusted: true });
    saveWorkspaceToDb({ id: "ws-a2", path: p2, name: "Apply Proj 2", isTrusted: true });

    const inventory = generateMigrationInventory();
    const candidate1 = inventory.details.validCandidates.find((c) => c.target.includes("apply-proj-1"));
    expect(candidate1).toBeDefined();

    const result = reconcileHistoricalWorkspaces({
      dryRun: false,
      selectedCatalogIds: [candidate1!.catalogId],
    });

    expect(result.mode).toBe("apply");
    expect(result.imported).toHaveLength(1);
    expect(result.capabilitiesGranted).toBe(false);
    expect(result.imported[0].name).toBe("Apply Proj 1");

    // Projects.json has 1 imported project
    expect(listProjects()).toHaveLength(1);

    // Security invariant: NO capabilities are granted
    const identity = { mode: "oauth" as const, subject: "auditor" };
    expect(hasProjectAccess(identity, result.imported[0].id, "read")).toBe(false);

    // History database rows are never deleted
    expect(getWorkspacesFromDb().length).toBeGreaterThanOrEqual(2);
  });

  it("strictly prohibits blanket auto-import and requires explicit selectedCatalogIds in apply mode (Finding G)", () => {
    const p1 = path.join(testRoot, "blanket-proj-1");
    fs.mkdirSync(path.join(p1, ".git"), { recursive: true });
    saveWorkspaceToDb({ id: "ws-b1", path: p1, name: "Blanket Proj 1", isTrusted: true });

    // 1. Missing selectedCatalogIds in apply mode throws error
    expect(() => {
      reconcileHistoricalWorkspaces({ dryRun: false } as any);
    }).toThrow("Apply mode requires explicit selectedCatalogIds. Blanket auto-import is prohibited.");

    // 2. Empty selectedCatalogIds array throws error
    expect(() => {
      reconcileHistoricalWorkspaces({ dryRun: false, selectedCatalogIds: [] });
    }).toThrow("Apply mode requires explicit selectedCatalogIds. Blanket auto-import is prohibited.");

    // 3. Array with only empty strings throws error
    expect(() => {
      reconcileHistoricalWorkspaces({ dryRun: false, selectedCatalogIds: ["", "  "] });
    }).toThrow("Apply mode requires explicit selectedCatalogIds. Blanket auto-import is prohibited.");

    // 4. Exceeding 100 catalog IDs throws error
    const tooMany = Array.from({ length: 101 }, (_, i) => `cat_${i}`);
    expect(() => {
      reconcileHistoricalWorkspaces({ dryRun: false, selectedCatalogIds: tooMany });
    }).toThrow("Too many selectedCatalogIds");
  });
});
