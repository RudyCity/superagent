import { describe, it, expect } from "vitest";
import { readTool, grepTool, multiReplaceFileContentTool } from "../src/core/tools/systemTools.js";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("System Tools Optimizations", () => {
  it("should have readTool with default limit 800 and correct description", () => {
    expect(readTool.name).toBe("read");
    expect(readTool.parameters.properties.limit.description).toContain("default 800");
  });

  it("should read a file up to the default limit (800 lines) and add truncation warning", async () => {
    // Create a temporary file with 1000 lines
    const tempFilePath = path.resolve(__dirname, "temp-large-file.txt");
    const fileContent = Array.from({ length: 1000 }, (_, i) => `Line ${i + 1}`).join("\n");
    await fs.writeFile(tempFilePath, fileContent, "utf-8");

    try {
      // Execute read tool with default limit (800)
      const result = await readTool.execute({ filePath: tempFilePath }, process.cwd());
      
      // Should contain line 1 to 800
      expect(result).toContain("1: Line 1");
      expect(result).toContain("800: Line 800");
      expect(result).not.toContain("801: Line 801");
      
      // Should contain the truncation warning
      expect(result).toContain("output truncated, showing 800 of 1000 lines");
      expect(result).toContain("There are 200 more lines");
    } finally {
      await fs.unlink(tempFilePath).catch(() => {});
    }
  });

  it("should respect custom limit and offset in readTool and show truncation warning if not reading to the end", async () => {
    const tempFilePath = path.resolve(__dirname, "temp-custom-file.txt");
    const fileContent = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join("\n");
    await fs.writeFile(tempFilePath, fileContent, "utf-8");

    try {
      const result = await readTool.execute({ filePath: tempFilePath, offset: 10, limit: 5 }, process.cwd());
      
      expect(result).toContain("10: Line 10");
      expect(result).toContain("14: Line 14");
      expect(result).not.toContain("9: Line 9");
      expect(result).not.toContain("15: Line 15");
      
      // Should show truncation warning because we only read a slice of a larger file
      expect(result).toContain("output truncated");
    } finally {
      await fs.unlink(tempFilePath).catch(() => {});
    }
  });

  it("should NOT show truncation warning when reading to the end of the file", async () => {
    const tempFilePath = path.resolve(__dirname, "temp-end-file.txt");
    const fileContent = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join("\n");
    await fs.writeFile(tempFilePath, fileContent, "utf-8");

    try {
      const result = await readTool.execute({ filePath: tempFilePath, offset: 45, limit: 10 }, process.cwd());
      
      expect(result).toContain("45: Line 45");
      expect(result).toContain("50: Line 50");
      
      // No truncation warning since we reached the end of the file
      expect(result).not.toContain("output truncated");
    } finally {
      await fs.unlink(tempFilePath).catch(() => {});
    }
  });

  it("should add truncation warning in grepTool when matches exceed 100", async () => {
    // Create a temp directory with files containing many matches
    const tempDir = path.resolve(__dirname, "temp-grep-dir");
    await fs.mkdir(tempDir, { recursive: true });
    
    // Write a file with 150 matches of the word "target"
    const tempFile = path.join(tempDir, "matches.txt");
    const fileContent = Array.from({ length: 150 }, () => "this is a target line").join("\n");
    await fs.writeFile(tempFile, fileContent, "utf-8");

    try {
      const result = await grepTool.execute({ pattern: "target", path: tempDir }, process.cwd());
      
      // Should contain the truncation warning
      expect(result).toContain("output truncated, showing 100 of 150 matches");
      expect(result).toContain("Refine your query/pattern or search path");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe("multi_replace_file_content Robustness", () => {
    it("should parse chunks when passed as a serialized JSON string array", async () => {
      const tempFilePath = path.resolve(__dirname, "temp-multi-replace-json-string.txt");
      await fs.writeFile(tempFilePath, "line 1\nline 2\nline 3\n", "utf-8");

      try {
        const chunksJsonString = JSON.stringify([
          {
            startLine: 1,
            endLine: 1,
            targetContent: "line 1",
            replacementContent: "line 1 updated"
          },
          {
            startLine: 3,
            endLine: 3,
            targetContent: "line 3",
            replacementContent: "line 3 updated"
          }
        ]);

        const result = await multiReplaceFileContentTool.execute(
          { filePath: tempFilePath, chunks: chunksJsonString },
          process.cwd()
        );

        expect(result).toContain("File updated successfully");
        const updatedContent = await fs.readFile(tempFilePath, "utf-8");
        expect(updatedContent).toBe("line 1 updated\nline 2\nline 3 updated\n");
      } finally {
        await fs.unlink(tempFilePath).catch(() => {});
      }
    });

    it("should handle single non-array chunk gracefully", async () => {
      const tempFilePath = path.resolve(__dirname, "temp-multi-replace-single.txt");
      await fs.writeFile(tempFilePath, "line 1\nline 2\n", "utf-8");

      try {
        const result = await multiReplaceFileContentTool.execute(
          {
            filePath: tempFilePath,
            chunks: {
              startLine: 2,
              endLine: 2,
              targetContent: "line 2",
              replacementContent: "line 2 updated"
            }
          },
          process.cwd()
        );

        expect(result).toContain("File updated successfully");
        const updatedContent = await fs.readFile(tempFilePath, "utf-8");
        expect(updatedContent).toBe("line 1\nline 2 updated\n");
      } finally {
        await fs.unlink(tempFilePath).catch(() => {});
      }
    });

    it("should defensively reject malformed chunks structure instead of throwing unhandled exceptions", async () => {
      const tempFilePath = path.resolve(__dirname, "temp-multi-replace-malformed.txt");
      await fs.writeFile(tempFilePath, "line 1\nline 2\n", "utf-8");

      try {
        // Passing chunk with missing/invalid targetContent (number)
        const result1 = await multiReplaceFileContentTool.execute(
          {
            filePath: tempFilePath,
            chunks: [
              {
                startLine: 1,
                endLine: 1,
                targetContent: 123,
                replacementContent: "new content"
              }
            ]
          },
          process.cwd()
        );
        expect(result1).toContain("Error: Missing or invalid 'targetContent'");

        // Passing chunk with missing targetContent
        const result2 = await multiReplaceFileContentTool.execute(
          {
            filePath: tempFilePath,
            chunks: [
              {
                startLine: 1,
                endLine: 1,
                replacementContent: "new content"
              }
            ]
          },
          process.cwd()
        );
        expect(result2).toContain("Error: Missing or invalid 'targetContent'");
      } finally {
        await fs.unlink(tempFilePath).catch(() => {});
      }
    });
  });
});
