import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { editTool, replaceFileContentTool, writeToFileTool, writeTool } from "../src/core/tools/fileEditTools.js";
import { managePlanTool } from "../src/core/tools/otherTools.js";
import fs from "fs/promises";
import path from "path";
import os from "os";

describe("File Edit Tools Aliases, Undefined Guards, and Safety", () => {
  let tempDir: string;
  let testFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-edit-test-"));
    testFile = path.join(tempDir, "sample.txt");
    await fs.writeFile(testFile, "line 1\nline 2 target line\nline 3", "utf-8");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("editTool parameter aliases and undefined prevention", () => {
    it("should accept 'replacement' alias instead of newString and never inject 'undefined'", async () => {
      const result = await editTool.execute(
        {
          filePath: testFile,
          oldString: "line 2 target line",
          replacement: "line 2 updated line",
        },
        tempDir
      );

      expect(result).toContain("File edited");
      const content = await fs.readFile(testFile, "utf-8");
      expect(content).toContain("line 2 updated line");
      expect(content).not.toContain("undefined");
    });

    it("should accept 'new_string' and 'old_string' aliases", async () => {
      const result = await editTool.execute(
        {
          filePath: testFile,
          old_string: "line 2 target line",
          new_string: "line 2 via underscore",
        } as any,
        tempDir
      );

      expect(result).toContain("File edited");
      const content = await fs.readFile(testFile, "utf-8");
      expect(content).toContain("line 2 via underscore");
    });

    it("should reject when newString/replacement is completely missing without corrupting file", async () => {
      const result = await editTool.execute(
        {
          filePath: testFile,
          oldString: "line 2 target line",
        } as any,
        tempDir
      );

      expect(result).toContain("Error: Missing required parameter 'newString'");
      const content = await fs.readFile(testFile, "utf-8");
      expect(content).toBe("line 1\nline 2 target line\nline 3");
      expect(content).not.toContain("undefined");
    });

    it("should accept batch edits with 'replacement' alias", async () => {
      const result = await editTool.execute(
        {
          edits: [
            {
              filePath: testFile,
              oldString: "line 1",
              replacement: "line 1 modified",
            },
          ],
        } as any,
        tempDir
      );

      expect(result).toContain("File edited");
      const content = await fs.readFile(testFile, "utf-8");
      expect(content).toContain("line 1 modified");
      expect(content).not.toContain("undefined");
    });
  });

  describe("replaceFileContentTool parameter aliases", () => {
    it("should accept 'replacement' and 'target' aliases", async () => {
      const result = await replaceFileContentTool.execute(
        {
          filePath: testFile,
          target: "line 2 target line",
          replacement: "line 2 replaced",
          startLine: 2,
          endLine: 2,
        } as any,
        tempDir
      );

      expect(result).toContain("File updated successfully");
      const content = await fs.readFile(testFile, "utf-8");
      expect(content).toContain("line 2 replaced");
    });

    it("should reject empty or missing replacementContent cleanly", async () => {
      const result = await replaceFileContentTool.execute(
        {
          filePath: testFile,
          targetContent: "line 2 target line",
          startLine: 2,
          endLine: 2,
        } as any,
        tempDir
      );

      expect(result).toContain("Error: Missing required parameter 'replacementContent'");
      const content = await fs.readFile(testFile, "utf-8");
      expect(content).toBe("line 1\nline 2 target line\nline 3");
    });
  });

  describe("writeToFileTool aliases", () => {
    it("should accept 'CodeContent' and 'Overwrite' aliases", async () => {
      const result = await writeToFileTool.execute(
        {
          filePath: testFile,
          CodeContent: "completely new file content",
          Overwrite: true,
        } as any,
        tempDir
      );

      expect(result).toContain("File written successfully");
      const content = await fs.readFile(testFile, "utf-8");
      expect(content).toBe("completely new file content");
    });
  });

  describe("managePlanTool aliases", () => {
    it("should accept 'content' alias for create action", async () => {
      const planFile = path.join(tempDir, "implementation_plan.md");
      const result = await managePlanTool.execute(
        {
          action: "create",
          content: "# Goal Description\n\n## Proposed Changes\n- change 1\n\n## Verification Plan\n### Automated Tests\n- test\n### Manual Verification\n- verify\n\n- [ ] Task 1",
        } as any,
        tempDir
      );

      expect(result).toContain("Successfully created implementation plan");
      const planContent = await fs.readFile(planFile, "utf-8");
      expect(planContent).toContain("# Goal Description");
    });

    it("should accept 'oldString' and 'newString' for edit action", async () => {
      const planFile = path.join(tempDir, "implementation_plan.md");
      await fs.writeFile(
        planFile,
        "# Goal Description\n\n## Proposed Changes\n- old section\n\n## Verification Plan\n### Automated Tests\n- test\n### Manual Verification\n- verify\n\n- [ ] Task 1",
        "utf-8"
      );

      const result = await managePlanTool.execute(
        {
          action: "edit",
          oldString: "- old section",
          newString: "- updated section",
        } as any,
        tempDir
      );

      expect(result).toContain("Successfully synchronized");
      const planContent = await fs.readFile(planFile, "utf-8");
      expect(planContent).toContain("- updated section");
      expect(planContent).not.toContain("- old section");
    });
  });
});
