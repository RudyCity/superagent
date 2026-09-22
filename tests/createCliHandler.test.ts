import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";
import { handleCreateCliCommand } from "../src/core/commands/createCliHandler.js";

describe("handleCreateCliCommand", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-cli-create-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    vi.restoreAllMocks();
  });

  it("should create project when called with project name and --dir", async () => {
    const targetDir = path.join(tempDir, "cli-test-project");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: any) => {
      return undefined as never;
    });

    await handleCreateCliCommand(["cli-test-project", "--dir", targetDir, "--no-git"]);

    expect(fs.existsSync(targetDir)).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(targetDir, "src"))).toBe(true);

    const pkg = JSON.parse(fs.readFileSync(path.join(targetDir, "package.json"), "utf-8"));
    expect(pkg.name).toBe("cli-test-project");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
