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
});
