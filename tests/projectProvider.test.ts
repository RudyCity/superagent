import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalProjectProvider } from "../src/core/project/providers/localProjectProvider.js";
import { registerProject, removeProject, updateProject } from "../src/core/project/projectRegistry.js";
import type { ResolvedProjectContext } from "../src/core/project/providers/types.js";
import { execFileSync } from "node:child_process";
import { setFullYoloMode, setYoloMode } from "../src/core/permissions.js";

const directories: string[] = [];
function createProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-local-provider-"));
  directories.push(root);
  return root;
}

afterEach(() => {
  removeProject("local-fixture");
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function context(root: string, workspace = root): ResolvedProjectContext {
  registerProject({ id: "local-fixture", name: "Local fixture", type: "local", root });
  return {
    projectId: "local-fixture",
    providerKind: "local",
    workspace,
    selectionSource: "projectId",
    explicit: true,
    project: {
      id: "local-fixture",
      name: "Local fixture",
      type: "local",
      root,
      enabled: true,
      tags: [],
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

describe("LocalProjectProvider", () => {
  it("returns canonical workspace metadata for a registered local project", async () => {
    const root = createProjectRoot();
    const nested = path.join(root, "packages", "api");
    fs.mkdirSync(nested, { recursive: true });
    const provider = new LocalProjectProvider();

    await expect(provider.getWorkspaceInfo(context(root, nested))).resolves.toMatchObject({
      projectId: "local-fixture",
      providerKind: "local",
      root: fs.realpathSync(root),
      workspace: fs.realpathSync(nested),
      remote: false,
      exists: true,
    });
  });

  it("rejects a workspace that escapes the registered project root", async () => {
    const root = createProjectRoot();
    const outside = createProjectRoot();
    const provider = new LocalProjectProvider();

    await expect(provider.getWorkspaceInfo(context(root, outside))).rejects.toThrow(/outside|escapes|registered project/i);
  });

  it("advertises only the operations currently supported by the local adapter", () => {
    const provider = new LocalProjectProvider();

    expect(provider.supports("workspace_info")).toBe(true);
    expect(provider.supports("health_check")).toBe(true);
    expect(provider.supports("read_files")).toBe(true);
    expect(provider.supports("list_files")).toBe(true);
    expect(provider.supports("grep_search")).toBe(true);
    expect(provider.supports("find_files")).toBe(true);
  });

  it("routes read/list/search through the explicit local provider methods with existing path and secret guards", async () => {
    const root = createProjectRoot();
    const outside = createProjectRoot();
    fs.writeFileSync(path.join(root, "provider-fixture.txt"), "unique-provider-marker" + String.fromCharCode(10) + "second line" + String.fromCharCode(10), "utf8");
    fs.writeFileSync(path.join(root, ".env"), "PROVIDER_TEST_SECRET=do-not-read" + String.fromCharCode(10), "utf8");
    fs.writeFileSync(path.join(outside, "outside.txt"), "outside-provider-marker" + String.fromCharCode(10), "utf8");
    const selected = context(root);
    const provider = new LocalProjectProvider();

    const read = await provider.readFiles(selected, { filePaths: ["provider-fixture.txt"] });
    expect(read.isError).toBeUndefined();
    expect(read.text).toContain("unique-provider-marker");

    const listing = await provider.listFiles(selected, { dirPath: "." });
    expect(listing.text).toContain("provider-fixture.txt");

    const grep = await provider.grepSearch(selected, { query: "unique-provider-marker", path: "." });
    expect(grep.text).toContain("provider-fixture.txt:1");

    const found = await provider.findFiles(selected, { pattern: "**/*.txt", path: "." });
    expect(found.text).toContain("provider-fixture.txt");

    const secret = await provider.readFiles(selected, { filePaths: [".env"] });
    expect(secret.isError).toBe(true);
    expect(secret.text).toContain("blocked");

    const escaped = await provider.readFiles(selected, { filePaths: [path.join(outside, "outside.txt")] });
    expect(escaped.isError).toBe(true);
    expect(escaped.text).toMatch(/outside|escapes|workspace/i);
  });

  it("routes write, command, and Git operations through the local provider while preserving safety guards", async () => {
    const root = createProjectRoot();
    const repo = context(root);
    const provider = new LocalProjectProvider();
    setFullYoloMode(false);
    setYoloMode(false);
    execFileSync("git", ["init", "-q"], { cwd: root });

    try {
      const write = await provider.writeFiles(repo, { files: [{ filePath: "provider-write.txt", content: "safe-write-marker" }] });
      expect(write.isError).toBeUndefined();
      expect(fs.readFileSync(path.join(root, "provider-write.txt"), "utf8")).toBe("safe-write-marker");

      const blockedEnv = await provider.writeFiles(repo, { files: [{ filePath: ".env", content: "SHOULD_NOT_WRITE=1" }] });
      expect(blockedEnv.isError).toBe(true);
      expect(fs.existsSync(path.join(root, ".env"))).toBe(false);

      const command = await provider.execCommand(repo, { command: "echo provider-exec-ok" });
      expect(command.isError).toBeUndefined();
      expect(command.text).toContain("provider-exec-ok");

      const destructive = await provider.execCommand(repo, { command: "rm -rf /tmp/superagent-provider-guard-never-created" });
      expect(destructive.isError).toBe(true);
      expect(destructive.text).toMatch(/blocked by safety policy|destructive/i);

      const git = await provider.gitAction(repo, { action: "status" });
      expect(git.isError).toBeUndefined();
      expect(git.text).toMatch(/provider-write.txt|On branch|Changes not staged/i);
    } finally {
      setFullYoloMode(false);
      setYoloMode(false);
    }
  });

  it("reports a missing local project root as unavailable without throwing", async () => {
    const root = createProjectRoot();
    const provider = new LocalProjectProvider();
    const resolvedContext = context(root);
    fs.rmSync(root, { recursive: true, force: true });

    const report = await provider.checkHealth(resolvedContext);

    expect(report.projectId).toBe("local-fixture");
    expect(report.providerKind).toBe("local");
    expect(report.status).toBe("unavailable");
    expect(report.checks.some((check) => check.name === "root_exists" && check.status === "failed")).toBe(true);
  });

  it("rejects a stale resolved context after the registered local root changes", async () => {
    const root = createProjectRoot();
    const replacementRoot = createProjectRoot();
    const staleContext = context(root);
    const provider = new LocalProjectProvider();
    updateProject("local-fixture", { root: replacementRoot });

    await expect(provider.getWorkspaceInfo(staleContext)).rejects.toThrow(/configuration changed/i);
    await expect(provider.checkHealth(staleContext)).rejects.toThrow(/configuration changed/i);
  });

  it("rejects health checks when a project is disabled after resolution", async () => {
    const root = createProjectRoot();
    const staleContext = context(root);
    const provider = new LocalProjectProvider();
    updateProject("local-fixture", { enabled: false });

    await expect(provider.checkHealth(staleContext)).rejects.toThrow(/enabled registered local project/i);
  });

  it("reports local workspace and git readiness as bounded health checks", async () => {
    const root = createProjectRoot();
    const provider = new LocalProjectProvider();

    const report = await provider.checkHealth(context(root));

    expect(report.status).toMatch(/healthy|degraded/);
    expect(report.checks.some((check) => check.name === "root_exists" && check.status === "passed")).toBe(true);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });
});
