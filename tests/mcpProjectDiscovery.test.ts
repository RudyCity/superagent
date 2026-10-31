import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROJECT_MCP_TOOL_CLASSIFICATIONS,
  dispatchProjectMcpTool,
} from "../src/core/mcp/tools/projectTools.js";
import { getProject, listProjects } from "../src/core/project/projectRegistry.js";
import { registerActiveSessionProvider } from "../src/core/project/workspaceCatalog.js";
import { saveWorkspaceToDb, closeHistoryDb, getHistoryDb } from "../src/core/storage/historyDb.js";
import { hasProjectAccess } from "../src/core/project/projectAccessPolicy.js";

let configDir: string;
let previousConfigDir: string | undefined;
let testRoot: string;

function textOf(result: any): string {
  return result?.content?.[0]?.text ?? "";
}

beforeEach(() => {
  previousConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-discovery-config-"));
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-discovery-root-"));
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

describe("MCP Project Discovery & Controlled Import (M3 & M4)", () => {
  it("classifies discovery as safe and import/sync as dangerous", () => {
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_discover_projects).toBe("safe");
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_import_discovered_project).toBe("dangerous");
    expect(PROJECT_MCP_TOOL_CLASSIFICATIONS.superagent_sync_projects).toBe("dangerous");
  });

  it("discovers historical workspaces without modifying registry or granting access", async () => {
    const historicalDir = path.join(testRoot, "real-app");
    fs.mkdirSync(path.join(historicalDir, ".git"), { recursive: true });

    saveWorkspaceToDb({
      id: "ws-hist-1",
      path: historicalDir,
      name: "Real App",
      isTrusted: true,
    });

    const res = await dispatchProjectMcpTool("superagent_discover_projects", { query: "real-app" });
    expect(res.isError).toBeUndefined();
    const data = JSON.parse(textOf(res));
    expect(data.projects.length).toBe(1);
    const proj = data.projects[0];
    expect(proj.name).toBe("Real App");
    expect(proj.registered).toBe(false);
    expect(proj.trusted).toBe(true);

    // Security invariant: registry must remain untouched
    expect(listProjects()).toHaveLength(0);
    // Security invariant: no capabilities granted
    expect(hasProjectAccess({ mode: "anonymous", subject: "anon" }, "real-app", "read")).toBe(false);
  });

  it("supports dry-run mode for project import", async () => {
    const candidateDir = path.join(testRoot, "dry-run-app");
    fs.mkdirSync(path.join(candidateDir, ".git"), { recursive: true });

    saveWorkspaceToDb({
      id: "ws-dry-1",
      path: candidateDir,
      name: "Dry Run App",
      isTrusted: true,
    });

    const res = await dispatchProjectMcpTool("superagent_import_discovered_project", {
      target: candidateDir,
      dryRun: true,
    });
    expect(res.isError).toBeUndefined();
    const data = JSON.parse(textOf(res));
    expect(data.dryRun).toBe(true);
    expect(data.capabilitiesGranted).toBe(false);
    expect(data.wouldRegister.name).toBe("Dry Run App");

    // Must not be registered in registry
    expect(listProjects()).toHaveLength(0);
  });

  it("imports a discovered project explicitly without granting capabilities", async () => {
    const candidateDir = path.join(testRoot, "importable-app");
    fs.mkdirSync(path.join(candidateDir, ".git"), { recursive: true });

    saveWorkspaceToDb({
      id: "ws-imp-1",
      path: candidateDir,
      name: "Importable App",
      isTrusted: true,
    });

    const res = await dispatchProjectMcpTool("superagent_import_discovered_project", {
      target: candidateDir,
      projectId: "importable-mcp",
    });
    expect(res.isError).toBeUndefined();
    const data = JSON.parse(textOf(res));
    expect(data.capabilitiesGranted).toBe(false);
    expect(data.imported.id).toBe("importable-mcp");

    // Project is now in registry
    const reg = getProject("importable-mcp");
    expect(reg).not.toBeNull();
    expect(reg?.name).toBe("Importable App");

    // SECURITY CHECK: project registration NEVER grants capabilities
    const identity = { mode: "oauth" as const, subject: "test-client" };
    expect(hasProjectAccess(identity, "importable-mcp", "read")).toBe(false);
    expect(hasProjectAccess(identity, "importable-mcp", "write")).toBe(false);
    expect(hasProjectAccess(identity, "importable-mcp", "execute")).toBe(false);
  });

  it("fails closed when attempting to import worktrees, temporary paths, or missing paths", async () => {
    // Missing directory in history
    const missing = path.join(testRoot, "missing-app");
    saveWorkspaceToDb({ id: "ws-missing-1", path: missing, name: "Missing App", isTrusted: true });
    const resMissing = await dispatchProjectMcpTool("superagent_import_discovered_project", {
      target: missing,
    });
    expect(resMissing.isError).toBe(true);
    expect(textOf(resMissing)).toContain("Cannot import unavailable workspace");

    // Completely unknown target not in catalog
    const resUnknown = await dispatchProjectMcpTool("superagent_import_discovered_project", {
      target: path.join(testRoot, "never-heard-of-this"),
    });
    expect(resUnknown.isError).toBe(true);
    expect(textOf(resUnknown)).toContain("Catalog entry not found");

    // Worktree directory
    const wtDir = path.join(testRoot, ".worktrees", "wt-job");
    fs.mkdirSync(wtDir, { recursive: true });
    saveWorkspaceToDb({ id: "ws-wt-1", path: wtDir, name: "WT Job", isTrusted: true });

    const resWt = await dispatchProjectMcpTool("superagent_import_discovered_project", {
      target: wtDir,
    });
    expect(resWt.isError).toBe(true);
    expect(textOf(resWt)).toContain("Cannot import worktree");
  });

  it("supports controlled bulk sync in dry-run and apply mode", async () => {
    const p1 = path.join(testRoot, "bulk-1");
    const p2 = path.join(testRoot, "bulk-2");
    fs.mkdirSync(path.join(p1, ".git"), { recursive: true });
    fs.mkdirSync(path.join(p2, ".git"), { recursive: true });

    saveWorkspaceToDb({ id: "ws-b1", path: p1, name: "Bulk One", isTrusted: true });
    saveWorkspaceToDb({ id: "ws-b2", path: p2, name: "Bulk Two", isTrusted: true });

    // Dry-run mode
    const dryRes = await dispatchProjectMcpTool("superagent_sync_projects", { mode: "dry-run" });
    expect(dryRes.isError).toBeUndefined();
    const dryData = JSON.parse(textOf(dryRes));
    expect(dryData.mode).toBe("dry-run");
    expect(dryData.totalImportable).toBeGreaterThanOrEqual(2);

    const catIds = dryData.candidates.map((c: any) => c.catalogId);

    // Apply mode
    const applyRes = await dispatchProjectMcpTool("superagent_sync_projects", {
      mode: "apply",
      catalogIds: catIds,
    });
    expect(applyRes.isError).toBeUndefined();
    const applyData = JSON.parse(textOf(applyRes));
    expect(applyData.mode).toBe("apply");
    expect(applyData.importedCount).toBeGreaterThanOrEqual(2);
    expect(applyData.capabilitiesGranted).toBe(false);

    expect(listProjects().length).toBeGreaterThanOrEqual(2);
  });

  it("discovers runtime active sessions through registered provider without explicit options (Finding A)", async () => {
    const activeDir = path.join(testRoot, "active-mcp-app");
    fs.mkdirSync(path.join(activeDir, ".git"), { recursive: true });

    registerActiveSessionProvider(() => [
      { workspace: activeDir, sessionId: "sess-active-mcp", lastActiveTime: Date.now() },
    ]);

    try {
      const res = await dispatchProjectMcpTool("superagent_discover_projects", { active: true });
      expect(res.isError).toBeUndefined();
      const data = JSON.parse(textOf(res));
      const match = data.projects.find((p: any) => p.name.includes("active-mcp-app") || p.target.includes("active-mcp-app"));
      expect(match).toBeDefined();
      expect(match.active).toBe(true);
    } finally {
      registerActiveSessionProvider(null);
    }
  });

  it("preserves requiresManualProfile signal for legacy SSH in discovery and does not leak secrets (Finding F)", async () => {
    const rawSsh = "ssh://ubuntu@10.20.30.40:2222/var/app?key=C:\\Users\\USER\\id_rsa.pem";
    saveWorkspaceToDb({
      id: "ws-legacy-mcp",
      path: rawSsh,
      name: "Legacy Remote App",
      isTrusted: true,
    });

    const res = await dispatchProjectMcpTool("superagent_discover_projects", { type: "ssh" });
    expect(res.isError).toBeUndefined();
    const data = JSON.parse(textOf(res));
    const match = data.projects.find((p: any) => p.type === "ssh");
    expect(match).toBeDefined();
    expect(match.requiresManualProfile).toBe(true);
    expect(match.target).toBe("ssh://ubuntu@10.20.30.40:2222/var/app");

    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("id_rsa.pem");
    expect(serialized).not.toContain("key=");
  });

  it("enforces catalogIds validation, deduplication, and max bounds on superagent_sync_projects apply mode (Finding K)", async () => {
    // 1. Empty catalogIds array
    const emptyRes = await dispatchProjectMcpTool("superagent_sync_projects", {
      mode: "apply",
      catalogIds: [],
    });
    expect(emptyRes.isError).toBe(true);
    expect(textOf(emptyRes)).toContain("mode 'apply' requires a non-empty array of catalogIds");

    // 2. Over 100 catalogIds
    const tooMany = Array.from({ length: 101 }, (_, i) => `cat_${i}`);
    const tooManyRes = await dispatchProjectMcpTool("superagent_sync_projects", {
      mode: "apply",
      catalogIds: tooMany,
    });
    expect(tooManyRes.isError).toBe(true);
    expect(textOf(tooManyRes)).toContain("Too many catalogIds");
  });
});
