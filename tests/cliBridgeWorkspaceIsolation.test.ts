import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cliBridgeTool } from "../src/core/tools/cliBridgeTool.js";
import { __resetForTests } from "../src/core/tools/cliBridgeSession.js";
import { cliArtifactPathVisibleToWorkspace, resolveAuthorizedDelegateCwd } from "../src/core/tools/cliBridgeWorkspaceScope.js";

let fixture = "";
let rootA = "";
let rootB = "";
const repl = 'process.stdout.write("repl> "); process.stdin.setEncoding("utf8"); process.stdin.on("data", s => { process.stdout.write("ok:" + s + "\\nrepl> "); });';

beforeAll(async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-cli-session-"));
  rootA = path.join(fixture, "project-A");
  rootB = path.join(fixture, "project-B");
  await fs.mkdir(rootA);
  await fs.mkdir(rootB);
});
afterEach(() => { __resetForTests(); });
afterAll(async () => {
  __resetForTests();
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

describe("Hermes Phase 4 CLI Bridge interactive project isolation", () => {
  it("does not expose project A interactive sessions to project B", async () => {
    const result = await cliBridgeTool.execute({
      action: "session.create", cli: "custom", binary: process.execPath,
      args: ["-e", repl], injectArtifacts: false, skillAutoDetect: false,
    }, rootA);
    const id = String(result).match(/Session created: (clb_[A-Za-z0-9_]+)/)?.[1];
    expect(id).toBeTruthy();
    const denied = await Promise.all([
      cliBridgeTool.execute({ action: "session.list" }, rootB),
      cliBridgeTool.execute({ action: "session.get", sessionId: id }, rootB),
      cliBridgeTool.execute({ action: "session.tail", sessionId: id }, rootB),
      cliBridgeTool.execute({ action: "session.send", sessionId: id, message: "private secret" }, rootB),
      cliBridgeTool.execute({ action: "session.kill", sessionId: id }, rootB),
      cliBridgeTool.execute({ action: "session.respond", sessionId: id, answer: "yes" }, rootB),
      cliBridgeTool.execute({ action: "session.export", sessionId: id }, rootB),
      cliBridgeTool.execute({ action: "session.config", sessionId: id }, rootB),
      cliBridgeTool.execute({ action: "session.resume", sessionId: id }, rootB),
      cliBridgeTool.execute({ action: "session.detach", sessionId: id }, rootB),
    ]);
    expect(denied[0]).not.toContain(id!);
    for (const output of denied.slice(1)) {
      expect(String(output)).toMatch(/not found in the authorized workspace/i);
      expect(String(output)).not.toContain(id!);
    }
    expect(String(await cliBridgeTool.execute({ action: "session.get", sessionId: id }, rootA))).toContain(id!);
    expect(String(await cliBridgeTool.execute({ action: "session.kill", sessionId: id }, rootA))).toMatch(/killed/i);
  }, 20_000);

  it("prevents session creation in another project and rejects cross-project artifact overrides", async () => {
    const badCwd = await cliBridgeTool.execute({
      action: "session.create", cli: "custom", binary: process.execPath,
      args: ["-e", repl], cwd: rootB, injectArtifacts: false,
    }, rootA);
    expect(String(badCwd)).toMatch(/outside the authorized workspace/i);
    const crossArtifact = await cliBridgeTool.execute({
      action: "delegate", cli: "custom", binary: process.execPath,
      args: ["-e", 'console.log("should not spawn")'], prompt: "Task",
      planPath: path.join(rootB, "plan.md"), injectArtifacts: true,
    }, rootA);
    expect(String(crossArtifact)).toMatch(/artifact path is outside the authorized workspace/i);
  });

  it("does not inject session artifacts outside workspace, including symlinked files", async () => {
    const foreign = path.join(rootB, "secret_task.md");
    await fs.writeFile(foreign, "not yours");
    expect(cliArtifactPathVisibleToWorkspace(foreign, rootA)).toBe(false);
    expect(cliArtifactPathVisibleToWorkspace(path.join(rootA, "new", "task.md"), rootA)).toBe(true);
    expect(() => resolveAuthorizedDelegateCwd(rootA, rootB)).toThrow(/outside/);
    const shortcut = path.join(rootA, "link-to-B");
    try {
      await fs.symlink(rootB, shortcut, process.platform === "win32" ? "junction" : "dir");
      expect(() => resolveAuthorizedDelegateCwd(rootA, shortcut)).toThrow(/outside/);
      expect(cliArtifactPathVisibleToWorkspace(path.join(shortcut, "secret_task.md"), rootA)).toBe(false);
      const missingTarget = path.join(rootB, "does-not-exist");
      const dangling = path.join(rootA, "dangling");
      try {
        await fs.symlink(missingTarget, dangling, process.platform === "win32" ? "junction" : "dir");
        expect(cliArtifactPathVisibleToWorkspace(path.join(dangling, "future.md"), rootA)).toBe(false);
      } finally {
        await fs.rm(dangling, { force: true, recursive: true }).catch(() => {});
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    } finally {
      await fs.rm(shortcut, { force: true, recursive: true }).catch(() => {});
    }
  });
});
