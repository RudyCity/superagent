import { describe, it, expect } from "vitest";
import { readTool, writeToFileTool, editTool, replaceFileContentTool, multiReplaceFileContentTool } from "../src/core/tools/systemTools.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Bulk File Tools Operations", () => {
  it("should perform bulk read on multiple files", async () => {
    const file1 = path.resolve(__dirname, "bulk-read-1.txt");
    const file2 = path.resolve(__dirname, "bulk-read-2.txt");
    await fs.writeFile(file1, "Hello from file 1", "utf-8");
    await fs.writeFile(file2, "Hello from file 2", "utf-8");

    try {
      const result = await readTool.execute({ filePaths: [file1, file2] }, process.cwd());
      expect(result).toContain("Hello from file 1");
      expect(result).toContain("Hello from file 2");
      expect(result).toContain("bulk-read-1.txt");
      expect(result).toContain("bulk-read-2.txt");
    } finally {
      await fs.unlink(file1).catch(() => {});
      await fs.unlink(file2).catch(() => {});
    }
  });

  it("should perform bulk write to multiple files", async () => {
    const file1 = path.resolve(__dirname, "bulk-write-1.txt");
    const file2 = path.resolve(__dirname, "bulk-write-2.txt");

    try {
      const result = await writeToFileTool.execute({
        files: [
          { filePath: file1, content: "Initial content 1", overwrite: true },
          { filePath: file2, content: "Initial content 2", overwrite: true }
        ]
      }, process.cwd());

      expect(result).toContain("bulk-write-1.txt");
      expect(result).toContain("bulk-write-2.txt");

      const content1 = await fs.readFile(file1, "utf-8");
      const content2 = await fs.readFile(file2, "utf-8");
      expect(content1).toBe("Initial content 1");
      expect(content2).toBe("Initial content 2");
    } finally {
      await fs.unlink(file1).catch(() => {});
      await fs.unlink(file2).catch(() => {});
    }
  });

  it("should perform bulk exact match editing across multiple files", async () => {
    const file1 = path.resolve(__dirname, "bulk-edit-1.txt");
    const file2 = path.resolve(__dirname, "bulk-edit-2.txt");
    await fs.writeFile(file1, "Original line 1", "utf-8");
    await fs.writeFile(file2, "Original line 2", "utf-8");

    try {
      const result = await editTool.execute({
        edits: [
          { filePath: file1, oldString: "Original line 1", newString: "Modified line 1" },
          { filePath: file2, oldString: "Original line 2", newString: "Modified line 2" }
        ]
      }, process.cwd());

      expect(result).toContain("bulk-edit-1.txt");
      expect(result).toContain("bulk-edit-2.txt");

      const content1 = await fs.readFile(file1, "utf-8");
      const content2 = await fs.readFile(file2, "utf-8");
      expect(content1).toBe("Modified line 1");
      expect(content2).toBe("Modified line 2");
    } finally {
      await fs.unlink(file1).catch(() => {});
      await fs.unlink(file2).catch(() => {});
    }
  });

  it("should perform bulk line replacement across multiple files", async () => {
    const file1 = path.resolve(__dirname, "bulk-replace-1.txt");
    const file2 = path.resolve(__dirname, "bulk-replace-2.txt");
    await fs.writeFile(file1, "Original content 1", "utf-8");
    await fs.writeFile(file2, "Original content 2", "utf-8");

    try {
      const result = await replaceFileContentTool.execute({
        edits: [
          { filePath: file1, targetContent: "Original content 1", replacementContent: "Replaced content 1", startLine: 1, endLine: 1 },
          { filePath: file2, targetContent: "Original content 2", replacementContent: "Replaced content 2", startLine: 1, endLine: 1 }
        ]
      }, process.cwd());

      expect(result).toContain("bulk-replace-1.txt");
      expect(result).toContain("bulk-replace-2.txt");

      const content1 = await fs.readFile(file1, "utf-8");
      const content2 = await fs.readFile(file2, "utf-8");
      expect(content1).toBe("Replaced content 1");
      expect(content2).toBe("Replaced content 2");
    } finally {
      await fs.unlink(file1).catch(() => {});
      await fs.unlink(file2).catch(() => {});
    }
  });

  it("should perform bulk multi-replace across multiple files", async () => {
    const file1 = path.resolve(__dirname, "bulk-multi-1.txt");
    const file2 = path.resolve(__dirname, "bulk-multi-2.txt");
    await fs.writeFile(file1, "Line one\nLine two", "utf-8");
    await fs.writeFile(file2, "Line A\nLine B", "utf-8");

    try {
      const result = await multiReplaceFileContentTool.execute({
        files: [
          {
            filePath: file1,
            chunks: [
              { targetContent: "Line one", replacementContent: "First line", startLine: 1, endLine: 1 },
              { targetContent: "Line two", replacementContent: "Second line", startLine: 2, endLine: 2 }
            ]
          },
          {
            filePath: file2,
            chunks: [
              { targetContent: "Line A", replacementContent: "Alpha", startLine: 1, endLine: 1 },
              { targetContent: "Line B", replacementContent: "Beta", startLine: 2, endLine: 2 }
            ]
          }
        ]
      }, process.cwd());

      expect(result).toContain("bulk-multi-1.txt");
      expect(result).toContain("bulk-multi-2.txt");

      const content1 = await fs.readFile(file1, "utf-8");
      const content2 = await fs.readFile(file2, "utf-8");
      expect(content1).toBe("First line\nSecond line");
      expect(content2).toBe("Alpha\nBeta");
    } finally {
      await fs.unlink(file1).catch(() => {});
      await fs.unlink(file2).catch(() => {});
    }
  });
});
