import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitActionTool } from "../src/core/tools/otherTools.js";

describe("headless Git executable resolution", () => {
  it("reads a bounded commit log from an isolated local repository", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-mcp-git-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd, windowsHide: true });
      execFileSync("git", [
        "-c", "user.name=SuperAgent Test",
        "-c", "user.email=superagent-test@example.invalid",
        "commit", "--allow-empty", "--quiet", "-m", "MCP_NATIVE_GIT_PROBE",
      ], { cwd, windowsHide: true });
      const output = await gitActionTool.execute({ action: "log", limit: 1 }, cwd);
      expect(String(output)).toContain("MCP_NATIVE_GIT_PROBE");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
  it("keeps commit staged-only and limits cleanup or restore to explicit files", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-git-scoped-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd, windowsHide: true });
      execFileSync("git", ["config", "user.name", "SuperAgent Test"], { cwd, windowsHide:true });
      execFileSync("git", ["config", "user.email", "superagent-test@example.invalid"], { cwd, windowsHide:true });
      fs.writeFileSync(path.join(cwd, "approved.txt"), "approved-v1\n");
      fs.writeFileSync(path.join(cwd, "unrelated.txt"), "unrelated\n");

      // Commit must never silently stage the entire workspace.
      const unstagedCommit = await gitActionTool.execute({ action:"commit", message:"Unstaged" }, cwd);
      expect(String(unstagedCommit)).toMatch(/Git action error:/);
      const untouched = execFileSync("git", ["status", "--porcelain"], { cwd, encoding:"utf8" });
      expect(untouched).toContain("approved.txt");
      expect(untouched).toContain("unrelated.txt");

      const rejected = await gitActionTool.execute({ action:"add", files:["*.txt"] }, cwd);
      expect(String(rejected)).toContain("explicit file paths");
      const staged = await gitActionTool.execute({ action:"add", files:["approved.txt"] }, cwd);
      expect(String(staged)).toContain("Successfully staged files");
      const committed = await gitActionTool.execute({ action:"commit", message:"Only approved file" }, cwd);
      expect(String(committed)).not.toMatch(/^Git action error:/);
      expect(execFileSync("git", ["ls-files"], { cwd, encoding:"utf8" }).trim()).toBe("approved.txt");
      expect(fs.existsSync(path.join(cwd,"unrelated.txt"))).toBe(true);

      fs.writeFileSync(path.join(cwd,"approved.txt"),"changed\n");
      expect(String(await gitActionTool.execute({action:"restore",files:["approved.txt"]},cwd)))
        .toContain("Successfully restored files");
      expect(fs.readFileSync(path.join(cwd,"approved.txt"),"utf8")).toMatch(/^approved-v1\r?\n$/);

      const noClean=await gitActionTool.execute({action:"clean"},cwd);
      expect(String(noClean)).toContain("explicit file paths");
      expect(fs.existsSync(path.join(cwd,"unrelated.txt"))).toBe(true);
      await gitActionTool.execute({action:"clean",files:["unrelated.txt"]},cwd);
      expect(fs.existsSync(path.join(cwd,"unrelated.txt"))).toBe(false);
      expect(fs.existsSync(path.join(cwd,"approved.txt"))).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive:true, force:true });
    }
  });

});
