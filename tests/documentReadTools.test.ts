import { describe, test, expect, vi } from "vitest";
import { readDocumentTool } from "../src/core/tools/documentReadTools.js";
import path from "path";
import fs from "fs/promises";
import os from "os";

describe("readDocumentTool", () => {
  test("returns error when file does not exist", async () => {
    const result = await readDocumentTool.execute({ filePath: "nonexistent-file-12345.pdf" }, process.cwd());
    expect(result).toContain("Error: File not found");
  });

  test("handles empty/missing filePath parameter", async () => {
    const result = await readDocumentTool.execute({}, process.cwd());
    expect(result).toContain("Error: Invalid or missing filePath parameter");
  });
});
