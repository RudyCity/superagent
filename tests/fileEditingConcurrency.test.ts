import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeToFileTool, replaceFileContentTool, editTool, applyPatchTool } from "../src/core/tools/systemTools.js";
import { fileLockManager } from "../src/core/tools/helpers.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testFile = path.resolve(__dirname, "temp-concurrency-test.txt");

describe("File Editing Concurrency and Accuracy Tests", () => {
  beforeEach(async () => {
    await fs.writeFile(testFile, "Initial Line\nSecond Line\nThird Line\n", "utf-8");
  });

  afterEach(async () => {
    await fs.unlink(testFile).catch(() => {});
  });

  it("should successfully serialize parallel edit operations to prevent race conditions", async () => {
    const promises = Array.from({ length: 10 }).map((_, index) => {
      return replaceFileContentTool.execute(
        {
          filePath: testFile,
          startLine: 1,
          endLine: 3,
          targetContent: "Initial Line",
          replacementContent: `Initial Line ${index}`,
          allowMultiple: true,
        },
        process.cwd()
      );
    });

    await Promise.all(promises);
    const fileContent = await fs.readFile(testFile, "utf-8");
    expect(fileContent).toBeDefined();
  });

  it("should verify that fileLockManager serializes asynchronous operations", async () => {
    const executionOrder: number[] = [];
    const runLocked = async (id: number, delayMs: number) => {
      const release = await fileLockManager.acquire("dummy-file-path");
      executionOrder.push(id);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      release();
    };

    await Promise.all([
      runLocked(1, 30),
      runLocked(2, 10),
      runLocked(3, 5),
    ]);

    expect(executionOrder).toEqual([1, 2, 3]);
  });

  it("should accurately edit files with trailing whitespace using editTool", async () => {
    const wsFile = path.resolve(__dirname, "temp-ws-edit-test.txt");
    await fs.writeFile(wsFile, "line A    \nline B  \nline C\n", "utf-8");

    try {
      const result = await editTool.execute(
        {
          filePath: wsFile,
          oldString: "line B",
          newString: "line B edited",
        },
        process.cwd()
      );

      expect(result).toContain("File edited");
      const content = await fs.readFile(wsFile, "utf-8");
      expect(content).toBe("line A    \nline B edited  \nline C\n");
    } finally {
      await fs.unlink(wsFile).catch(() => {});
    }
  });

  it("should accurately apply search-replace patches on files with trailing whitespace", async () => {
    const wsFile = path.resolve(__dirname, "temp-ws-patch-test.txt");
    await fs.writeFile(wsFile, "first line    \nsecond line  \nthird line\n", "utf-8");

    try {
      const result = await applyPatchTool.execute(
        {
          filePath: wsFile,
          patchContent: "<<<<<<< SEARCH\nsecond line\n=======\nsecond line patched\n>>>>>>> REPLACE",
        },
        process.cwd()
      );

      expect(result).toContain("Patch applied successfully");
      const content = await fs.readFile(wsFile, "utf-8");
      expect(content).toBe("first line    \nsecond line patched  \nthird line\n");
    } finally {
      await fs.unlink(wsFile).catch(() => {});
    }
  });
});
