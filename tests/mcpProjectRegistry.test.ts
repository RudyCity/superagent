import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getProject,
  listProjects,
  registerProject,
  removeProject,
  updateProject,
} from "../src/core/project/projectRegistry.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-project-registry-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("MCP project registry", () => {
  it("registers and lists a canonical local project without storing secrets", () => {
    const dir = tempDir();
    const projectRoot = path.join(dir, "app");
    fs.mkdirSync(projectRoot);
    const registryPath = path.join(dir, "projects.json");

    const project = registerProject({
      name: "API Service",
      type: "local",
      root: projectRoot,
      description: "API repository",
      tags: ["typescript", "api"],
    }, registryPath);

    expect(project.id).toBe("api-service");
    expect(project.root).toBe(fs.realpathSync(projectRoot));
    expect(listProjects(registryPath)).toEqual([project]);
    expect(getProject(project.id, registryPath)).toEqual(project);
    expect(fs.readFileSync(registryPath, "utf8")).not.toContain("password");
  });

  it("rejects duplicate IDs, duplicate roots, and missing local directories", () => {
    const dir = tempDir();
    const projectRoot = path.join(dir, "app");
    fs.mkdirSync(projectRoot);
    const registryPath = path.join(dir, "projects.json");
    registerProject({ id: "api", name: "API", type: "local", root: projectRoot }, registryPath);

    expect(() => registerProject({ id: "api", name: "Other", type: "local", root: path.join(dir, "other") }, registryPath)).toThrow(/already exists/i);
    expect(() => registerProject({ id: "other", name: "Other", type: "local", root: projectRoot }, registryPath)).toThrow(/already registered/i);
    expect(() => registerProject({ id: "missing", name: "Missing", type: "local", root: path.join(dir, "missing") }, registryPath)).toThrow(/directory/i);
  });

  it("requires chain project records to reference an existing Workspace Chain", () => {
    const dir = tempDir();
    const registryPath = path.join(dir, "projects.json");
    expect(() => registerProject({
      id: "missing-chain",
      name: "Missing Chain",
      type: "chain",
      target: "chain:project-that-does-not-exist",
    }, registryPath)).toThrow(/Workspace Chain does not exist/i);
    expect(listProjects(registryPath)).toEqual([]);
  });

  it("rejects malformed registry data instead of silently treating it as empty", () => {
    const dir = tempDir();
    const registryPath = path.join(dir, "projects.json");
    fs.writeFileSync(registryPath, "{broken", "utf8");
    expect(() => listProjects(registryPath)).toThrow(/invalid.*project registry/i);
  });

  it("rejects credential-bearing SSH targets and secret fields injected directly into the registry", () => {
    const dir = tempDir();
    const registryPath = path.join(dir, "projects.json");
    fs.writeFileSync(registryPath, JSON.stringify({
      schemaVersion: 1,
      projects: [{ id: "unsafe-ssh", name: "Unsafe SSH", type: "ssh", target: "ssh://user:password@example.test/srv/app", tags: [], enabled: true, createdAt: Date.now(), updatedAt: Date.now() }],
    }), "utf8");
    expect(() => listProjects(registryPath)).toThrow(/unsafe target URI/i);

    fs.writeFileSync(registryPath, JSON.stringify({
      schemaVersion: 1,
      projects: [{ id: "secret-field", name: "Secret Field", type: "chain", target: "chain:valid-chain", password: "do-not-return-this", tags: [], enabled: true, createdAt: Date.now(), updatedAt: Date.now() }],
    }), "utf8");
    expect(() => listProjects(registryPath)).toThrow(/unsupported fields/i);
  });

  it("supports safe metadata updates and stable-ID removal", () => {
    const dir = tempDir();
    const projectRoot = path.join(dir, "app");
    fs.mkdirSync(projectRoot);
    const registryPath = path.join(dir, "projects.json");
    registerProject({ id: "api", name: "API", type: "local", root: projectRoot }, registryPath);

    const updated = updateProject("api", { name: "API v2", enabled: false, tags: ["backend"] }, registryPath);
    expect(updated.id).toBe("api");
    expect(updated.name).toBe("API v2");
    expect(updated.enabled).toBe(false);
    expect(removeProject("api", registryPath)).toBe(true);
    expect(getProject("api", registryPath)).toBeNull();
  });

  it("rejects remote targets that include a password or credential-like query", () => {
    const dir = tempDir();
    const registryPath = path.join(dir, "projects.json");
    expect(() => registerProject({
      id: "remote",
      name: "Remote",
      type: "ssh",
      target: "ssh://user:password@example.test:22/app",
    }, registryPath)).toThrow(/credentials|password|secret/i);
  });
});
