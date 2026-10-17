import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerProject, updateProject } from "../src/core/project/projectRegistry.js";
import { resolveProjectTarget } from "../src/core/project/projectRouter.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-project-router-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("MCP project target resolver", () => {
  it("resolves an explicit project ID to the registered canonical root", () => {
    const dir = tempDir();
    const root = path.join(dir, "repo");
    fs.mkdirSync(root);
    const registryPath = path.join(dir, "projects.json");
    registerProject({ id: "repo", name: "Repo", type: "local", root }, registryPath);

    expect(resolveProjectTarget({ projectId: "repo", sessionWorkspace: dir, registryPath })).toMatchObject({
      projectId: "repo",
      workspace: fs.realpathSync(root),
      source: "projectId",
      explicit: true,
    });
  });

  it("maps a nested path to exactly one registered project but preserves the requested directory", () => {
    const dir = tempDir();
    const root = path.join(dir, "repo");
    const nested = path.join(root, "packages", "api");
    fs.mkdirSync(nested, { recursive: true });
    const registryPath = path.join(dir, "projects.json");
    registerProject({ id: "repo", name: "Repo", type: "local", root }, registryPath);

    expect(resolveProjectTarget({ workspace: nested, sessionWorkspace: dir, registryPath })).toMatchObject({
      projectId: "repo",
      workspace: fs.realpathSync(nested),
      source: "workspace",
    });
  });

  it("allows a subdirectory under projectId but rejects a mismatched outside path", () => {
    const dir = tempDir();
    const root = path.join(dir, "repo");
    const nested = path.join(root, "packages", "api");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(outside);
    const registryPath = path.join(dir, "projects.json");
    registerProject({ id: "repo", name: "Repo", type: "local", root }, registryPath);

    expect(resolveProjectTarget({ projectId: "repo", cwd: "packages/api", sessionWorkspace: dir, registryPath })).toMatchObject({
      projectId: "repo",
      workspace: fs.realpathSync(nested),
      source: "projectId",
    });
    expect(() => resolveProjectTarget({ projectId: "repo", workspace: outside, sessionWorkspace: dir, registryPath })).toThrow(/escapes registered project/i);
  });

  it("rejects unregistered and ambiguous local targets", () => {
    const dir = tempDir();
    const root = path.join(dir, "repo");
    const nestedRoot = path.join(root, "nested");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(nestedRoot, { recursive: true });
    fs.mkdirSync(outside);
    const registryPath = path.join(dir, "projects.json");
    registerProject({ id: "repo", name: "Repo", type: "local", root }, registryPath);
    registerProject({ id: "nested", name: "Nested", type: "local", root: nestedRoot }, registryPath);

    expect(() => resolveProjectTarget({ workspace: outside, sessionWorkspace: root, registryPath })).toThrow(/not registered/i);
    expect(() => resolveProjectTarget({ workspace: nestedRoot, sessionWorkspace: root, registryPath })).toThrow(/ambiguous/i);
  });

  it("rejects disabled projects by ID and keeps an unregistered ambient session workspace usable", () => {
    const dir = tempDir();
    const root = path.join(dir, "repo");
    fs.mkdirSync(root);
    const registryPath = path.join(dir, "projects.json");
    registerProject({ id: "repo", name: "Repo", type: "local", root }, registryPath);
    updateProject("repo", { enabled: false }, registryPath);

    expect(() => resolveProjectTarget({ projectId: "repo", sessionWorkspace: dir, registryPath })).toThrow(/disabled/i);
    expect(resolveProjectTarget({ sessionWorkspace: dir, registryPath })).toMatchObject({
      projectId: null,
      workspace: path.resolve(dir),
      source: "session",
      explicit: false,
    });
  });

  it("rejects path traversal through a symlink outside the registered project", () => {
    const dir = tempDir();
    const root = path.join(dir, "repo");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    const link = path.join(root, "escape");
    try {
      fs.symlinkSync(outside, link, "junction");
    } catch {
      return; // Symlink creation may be unavailable in a restricted Windows environment.
    }
    const registryPath = path.join(dir, "projects.json");
    registerProject({ id: "repo", name: "Repo", type: "local", root }, registryPath);
    expect(() => resolveProjectTarget({ workspace: link, sessionWorkspace: root, registryPath })).toThrow(/outside|registered|ambiguous/i);
  });
});
