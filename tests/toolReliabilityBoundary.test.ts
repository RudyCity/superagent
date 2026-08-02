import { describe, expect, it, beforeEach, vi } from "vitest";
import { readTool, writeTool } from "../src/core/tools/systemTools.js";
import * as sharedMemoryModule from "../src/core/storage/sharedMemory.js";

beforeEach(() => {
  vi.spyOn(sharedMemoryModule, "checkFileLock").mockReturnValue({ locked: false });
});
import path from "path";
import fs from "fs/promises";

const cwd = process.cwd();

describe("workspace boundary guards", () => {
  it("prevents read access outside workspace root", async () => {
    const result = await readTool.execute({ filePath: "../../etc/passwd" }, cwd);
    expect(result).toContain("violates workspace boundary");
  });

  it("prevents write access outside workspace root", async () => {
    const result = await writeTool.execute({ filePath: "../../etc/passwd", content: "x" }, cwd);
    expect(result).toContain("violates workspace boundary");
  });

  it("appends walkthrough file without overwriting if it already exists", async () => {
    const testWalkthrough = path.resolve(cwd, "test_session_walkthrough.md");
    try {
      await fs.writeFile(testWalkthrough, "# Existing Header\n\nExisting Content", "utf-8");
      const result = await writeTool.execute({ filePath: testWalkthrough, content: "# Phase 2 Header\n\nNew Content" }, cwd);

      expect(result).toContain("File appended");

      const updated = await fs.readFile(testWalkthrough, "utf-8");
      expect(updated).toContain("# Existing Header");
      expect(updated).toContain("# Phase 2 Header");
    } finally {
      await fs.rm(testWalkthrough, { force: true });
    }
  });
});
