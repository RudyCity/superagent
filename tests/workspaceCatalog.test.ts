import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildWorkspaceCatalog,
  queryWorkspaceCatalog,
  getWorkspaceCatalogEntry,
  deriveCatalogId,
  registerActiveSessionProvider,
} from "../src/core/project/workspaceCatalog.js";
import { registerProject } from "../src/core/project/projectRegistry.js";
import { addTrustedDirectory } from "../src/core/config/trustedDirs.js";
import { saveWorkspaceToDb, getHistoryDb, closeHistoryDb, createSqliteDb } from "../src/core/storage/historyDb.js";
import { pathKey } from "../src/core/project/workspaceCatalogClassifier.js";

let configDir: string;
let previousConfigDir: string | undefined;
let testRoot: string;

beforeEach(() => {
  previousConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-test-config-"));
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-test-root-"));
  process.env.SUPERAGENT_CONFIG_DIR = configDir;
});

afterEach(() => {
  closeHistoryDb();
  if (previousConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = previousConfigDir;
  try {
    fs.rmSync(configDir, { recursive: true, force: true });
  } catch {}
  try {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } catch {}
  vi.unstubAllEnvs();
});

describe("Workspace Catalog Core (M1)", () => {
  it("derives deterministic stable catalogId", () => {
    const id1 = deriveCatalogId("D:\\Projects\\App", "local");
    const id2 = deriveCatalogId("d:\\projects\\app", "local");
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^cat_[a-f0-9]{16}$/);
  });

  it("merges registered projects from projects.json", () => {
    const projectDir = path.join(testRoot, "my-registered-proj");
    fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });

    registerProject({
      id: "registered-one",
      name: "Registered One",
      type: "local",
      root: projectDir,
      tags: ["core"],
    });

    const entries = buildWorkspaceCatalog({ allowTempAsProjectRoot: true });
    const match = entries.find((e) => e.registeredProjectId === "registered-one");

    expect(match).toBeDefined();
    expect(match?.registered).toBe(true);
    expect(match?.displayName).toBe("Registered One");
    expect(match?.sources).toContain("registry");
    expect(match?.classification).toBe("project");
    expect(match?.available).toBe(true);
    // Already registered projects should not be importable (importable = false)
    expect(match?.importable).toBe(false);
  });

  it("discovers historical workspaces from SQLite with session statistics", () => {
    const historicalDir = path.join(testRoot, "history-proj");
    fs.mkdirSync(path.join(historicalDir, ".git"), { recursive: true });

    const db = getHistoryDb();
    saveWorkspaceToDb({
      id: "hist-ws-1",
      path: historicalDir,
      name: "History Project",
      isTrusted: true,
    });

    // Insert dummy session
    const now = Date.now();
    db.prepare(`
      INSERT INTO sessions (id, display_name, workspace_id, working_directory, message_count, last_modified, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("sess-1", "Chat 1", "hist-ws-1", historicalDir, 5, now, now - 10000);

    const entries = buildWorkspaceCatalog({ allowTempAsProjectRoot: true });
    const match = entries.find((e) => pathKey(e.canonicalTarget) === pathKey(historicalDir));

    expect(match).toBeDefined();
    expect(match?.registered).toBe(false);
    expect(match?.trusted).toBe(true);
    expect(match?.sources).toContain("history");
    expect(match?.sources).toContain("trusted");
    expect(match?.sessionCount).toBeGreaterThanOrEqual(1);
    expect(match?.importable).toBe(true);
    expect(match?.classification).toBe("project");
  });

  it("merges active sessions from runtime", () => {
    const activeDir = path.join(testRoot, "active-proj");
    fs.mkdirSync(path.join(activeDir, ".git"), { recursive: true });

    const entries = buildWorkspaceCatalog({
      allowTempAsProjectRoot: true,
      activeSessions: [
        { workspace: activeDir, sessionId: "active-s1", lastActiveTime: Date.now() },
      ],
    });

    const match = entries.find((e) => pathKey(e.canonicalTarget) === pathKey(activeDir));
    expect(match).toBeDefined();
    expect(match?.active).toBe(true);
    expect(match?.sources).toContain("active");
  });

  it("deduplicates Windows path case variants into a single entry", () => {
    const projDir = path.join(testRoot, "case-proj");
    fs.mkdirSync(path.join(projDir, ".git"), { recursive: true });

    const lowerPath = projDir.toLowerCase();
    const upperPath = projDir.toUpperCase();

    addTrustedDirectory(lowerPath, "Lower Project");
    addTrustedDirectory(upperPath, "Upper Project");

    const entries = buildWorkspaceCatalog({ allowTempAsProjectRoot: true });
    const matches = entries.filter((e) => pathKey(e.canonicalTarget) === pathKey(projDir));

    expect(matches.length).toBe(1);
    expect(matches[0].trusted).toBe(true);
  });

  it("filters and paginates catalog results cleanly", () => {
    const p1 = path.join(testRoot, "filter-alpha");
    const p2 = path.join(testRoot, "filter-beta");
    fs.mkdirSync(path.join(p1, ".git"), { recursive: true });
    fs.mkdirSync(path.join(p2, ".git"), { recursive: true });

    addTrustedDirectory(p1, "Alpha Project");
    addTrustedDirectory(p2, "Beta Project");

    const res = queryWorkspaceCatalog(
      { query: "alpha", allowTempAsProjectRoot: true } as any,
      { allowTempAsProjectRoot: true },
    );
    expect(res.total).toBe(1);
    expect(res.entries[0].displayName).toBe("Alpha Project");
  });

  it("retrieves a catalog entry by catalogId, registeredProjectId, or canonical path", () => {
    const projDir = path.join(testRoot, "lookup-proj");
    fs.mkdirSync(path.join(projDir, ".git"), { recursive: true });

    registerProject({
      id: "lookup-id",
      name: "Lookup Proj",
      type: "local",
      root: projDir,
    });

    const byId = getWorkspaceCatalogEntry("lookup-id", { allowTempAsProjectRoot: true });
    expect(byId).not.toBeNull();
    expect(byId?.registeredProjectId).toBe("lookup-id");

    const byPath = getWorkspaceCatalogEntry(projDir, { allowTempAsProjectRoot: true });
    expect(byPath).not.toBeNull();
    expect(byPath?.registeredProjectId).toBe("lookup-id");

    const byCatalogId = getWorkspaceCatalogEntry(byId!.catalogId, { allowTempAsProjectRoot: true });
    expect(byCatalogId).not.toBeNull();
    expect(byCatalogId?.registeredProjectId).toBe("lookup-id");
  });

  it("preserves safety: catalog building never grants MCP capabilities", () => {
    const projDir = path.join(testRoot, "safety-proj");
    fs.mkdirSync(path.join(projDir, ".git"), { recursive: true });
    addTrustedDirectory(projDir, "Safety Project");

    const entries = buildWorkspaceCatalog({ allowTempAsProjectRoot: true });
    const match = entries.find((e) => pathKey(e.canonicalTarget) === pathKey(projDir));

    expect(match).toBeDefined();
    // Being trusted in history does NOT mean registered or authorized
    expect(match?.registered).toBe(false);
    expect(match?.registeredProjectId).toBeUndefined();
  });

  it("merges active sessions from runtime provider without explicit options (Finding A)", () => {
    const activeDir = path.join(testRoot, "runtime-active-proj");
    fs.mkdirSync(path.join(activeDir, ".git"), { recursive: true });

    registerActiveSessionProvider(() => [
      { workspace: activeDir, sessionId: "runtime-s1", lastActiveTime: 123456789 },
    ]);

    try {
      const entries = buildWorkspaceCatalog({ allowTempAsProjectRoot: true });
      const match = entries.find((e) => pathKey(e.canonicalTarget) === pathKey(activeDir));

      expect(match).toBeDefined();
      expect(match?.active).toBe(true);
      expect(match?.sources).toContain("active");
      expect(match?.lastUsedAt).toBe(123456789);
    } finally {
      registerActiveSessionProvider(null);
    }
  });

  it("preserves explicitly trusted and custom-named nested workspace as independent candidate (Finding B)", () => {
    const parentRepo = path.join(testRoot, "monorepo-b");
    fs.mkdirSync(path.join(parentRepo, ".git"), { recursive: true });

    const customNamedNested = path.join(parentRepo, "packages", "custom-service");
    fs.mkdirSync(customNamedNested, { recursive: true });

    const arbitraryNested = path.join(parentRepo, "packages", "arbitrary-service");
    fs.mkdirSync(arbitraryNested, { recursive: true });

    const db = getHistoryDb();
    saveWorkspaceToDb({
      id: "ws-parent",
      path: parentRepo,
      name: "Monorepo Parent",
      isTrusted: true,
    });
    // Explicit custom name different from basename
    saveWorkspaceToDb({
      id: "ws-custom-nested",
      path: customNamedNested,
      name: "Custom Service Product",
      isTrusted: true,
    });
    // Arbitrary nested with default basename name
    saveWorkspaceToDb({
      id: "ws-arbitrary-nested",
      path: arbitraryNested,
      name: "arbitrary-service",
      isTrusted: true,
    });

    const entries = buildWorkspaceCatalog({ allowTempAsProjectRoot: true });
    const customMatch = entries.find((e) => pathKey(e.canonicalTarget) === pathKey(customNamedNested));
    const arbitraryMatch = entries.find((e) => pathKey(e.canonicalTarget) === pathKey(arbitraryNested));

    expect(customMatch).toBeDefined();
    expect(customMatch?.classification).toBe("nested-project");
    expect(customMatch?.importable).toBe(true);
    expect(customMatch?.displayName).toBe("Custom Service Product");

    expect(arbitraryMatch).toBeDefined();
    expect(arbitraryMatch?.classification).toBe("nested-project");
    expect(arbitraryMatch?.importable).toBe(false);
  });

  it("safely aggregates historical usage from non-independent nested projects into parent repo without duplicating sessions (Finding C)", () => {
    const parentRepo = path.join(testRoot, "monorepo-c");
    fs.mkdirSync(path.join(parentRepo, ".git"), { recursive: true });

    const nestedSubApp = path.join(parentRepo, "apps", "sub-app");
    fs.mkdirSync(nestedSubApp, { recursive: true });

    const db = getHistoryDb();
    saveWorkspaceToDb({
      id: "ws-parent-c",
      path: parentRepo,
      name: "Parent Monorepo C",
      isTrusted: true,
    });
    saveWorkspaceToDb({
      id: "ws-nested-c",
      path: nestedSubApp,
      name: "sub-app", // default name
      isTrusted: true,
    });

    // Session 1: logged on parent repo
    db.prepare(`
      INSERT INTO sessions (id, display_name, workspace_id, working_directory, message_count, last_modified, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("sess-1", "Chat 1", "ws-parent-c", parentRepo, 2, 1000, 1000);

    // Session 2: logged on nested folder but with parent workspace_id (shared session)
    db.prepare(`
      INSERT INTO sessions (id, display_name, workspace_id, working_directory, message_count, last_modified, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("sess-2", "Chat 2", "ws-parent-c", nestedSubApp, 4, 3000, 2000);

    // Session 3: logged strictly on nested workspace
    db.prepare(`
      INSERT INTO sessions (id, display_name, workspace_id, working_directory, message_count, last_modified, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("sess-3", "Chat 3", "ws-nested-c", nestedSubApp, 3, 5000, 4000);

    const entries = buildWorkspaceCatalog({ allowTempAsProjectRoot: true });
    const parentEntry = entries.find((e) => pathKey(e.canonicalTarget) === pathKey(parentRepo));
    const nestedEntry = entries.find((e) => pathKey(e.canonicalTarget) === pathKey(nestedSubApp));

    expect(parentEntry).toBeDefined();
    // Distinct sessions: sess-1, sess-2, sess-3 = 3 sessions (NOT 4)
    expect(parentEntry?.sessionCount).toBe(3);
    expect(parentEntry?.firstSeenAt).toBe(1000);
    expect(parentEntry?.lastUsedAt).toBeGreaterThanOrEqual(5000);

    // Nested entry is still cataloged with its non-independent classification
    expect(nestedEntry).toBeDefined();
    expect(nestedEntry?.classification).toBe("nested-project");
    expect(nestedEntry?.importable).toBe(false);
  });

  it("ensures custom historyDb injection is self-contained and does not mix with global DB (Finding E)", () => {
    // 1. Populate global DB with a distinct workspace
    const globalWs = path.join(testRoot, "global-only-ws");
    fs.mkdirSync(path.join(globalWs, ".git"), { recursive: true });
    saveWorkspaceToDb({
      id: "global-only-id",
      path: globalWs,
      name: "Global Workspace",
      isTrusted: true,
    });

    // 2. Create custom SQLite DB in a separate temp path
    const customDbFile = path.join(testRoot, "custom-history.db");
    const customDb = createSqliteDb(customDbFile);
    customDb.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        name TEXT,
        is_trusted INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT 100,
        updated_at INTEGER NOT NULL DEFAULT 200
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        working_directory TEXT,
        display_name TEXT,
        message_count INTEGER DEFAULT 0,
        last_modified INTEGER,
        created_at INTEGER
      );
    `);

    const customWs = path.join(testRoot, "custom-only-ws");
    fs.mkdirSync(path.join(customWs, ".git"), { recursive: true });
    customDb.prepare(`
      INSERT INTO workspaces (id, path, name, is_trusted, created_at, updated_at)
      VALUES (?, ?, ?, 1, 100, 200)
    `).run("custom-id", customWs, "Custom DB Project");

    customDb.prepare(`
      INSERT INTO sessions (id, workspace_id, working_directory, display_name, last_modified, created_at)
      VALUES (?, ?, ?, ?, 200, 100)
    `).run("custom-sess", "custom-id", customWs, "Custom Session");

    const entries = buildWorkspaceCatalog({
      historyDb: customDb,
      allowTempAsProjectRoot: true,
    });

    const hasCustom = entries.some((e) => pathKey(e.canonicalTarget) === pathKey(customWs));
    const hasGlobal = entries.some((e) => pathKey(e.canonicalTarget) === pathKey(globalWs));

    expect(hasCustom).toBe(true);
    expect(hasGlobal).toBe(false);
  });

  it("preserves requiresManualProfile diagnostic signal for legacy SSH without secret leakage (Finding F)", () => {
    const rawSsh = "ssh://ubuntu@43.134.226.18:2345/home/ubuntu?key=C:\\Users\\USER\\Downloads\\RudyNuzi.pem";
    const db = getHistoryDb();
    saveWorkspaceToDb({
      id: "ws-legacy-ssh",
      path: rawSsh,
      name: "Legacy Ubuntu Box",
      isTrusted: true,
    });

    const entries = buildWorkspaceCatalog();
    const sshEntry = entries.find((e) => e.type === "ssh");

    expect(sshEntry).toBeDefined();
    expect(sshEntry?.canonicalTarget).toBe("ssh://ubuntu@43.134.226.18:2345/home/ubuntu");
    expect(sshEntry?.sanitizedCredentials).toBe(true);
    expect(sshEntry?.requiresManualProfile).toBe(true);

    const serialized = JSON.stringify(sshEntry);
    expect(serialized).not.toContain("RudyNuzi.pem");
    expect(serialized).not.toContain("key=");
  });
});
