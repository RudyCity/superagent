import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { readFileTail } from "../src/utils/logTail.js";

const tempFiles: string[] = [];

function createTempFile(content: string): string {
  const filePath = path.join(os.tmpdir(), `superagent-logtail-test-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(filePath, content, "utf-8");
  tempFiles.push(filePath);
  return filePath;
}

afterEach(() => {
  for (const filePath of tempFiles.splice(0)) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best-effort cleanup.
    }
  }
});

describe("readFileTail", () => {
  it("reads a small file completely", () => {
    const filePath = createTempFile("line1\nline2\nline3");
    expect(readFileTail(filePath, 1024)).toBe("line1\nline2\nline3");
  });

  it("reads only the requested tail of a large file", () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(`line-${String(i).padStart(4, "0")}-aaaaaaaaaaaaaaaaaaaa`);
    }
    const filePath = createTempFile(lines.join("\n"));
    const tail = readFileTail(filePath, 256);
    expect(tail.length).toBeLessThanOrEqual(256);
    // Must end at the true end of the file...
    expect(tail.endsWith(lines[lines.length - 1])).toBe(true);
    // ...and must not contain a torn first line.
    expect(tail.startsWith("\n") || !tail.includes(lines[0])).toBe(true);
    const firstLineOfTail = tail.split("\n")[0];
    expect(lines.some((l) => l === firstLineOfTail)).toBe(true);
  });

  it("drops the partial first line when truncating mid-line", () => {
    const filePath = createTempFile("ABCDEFGHIJ\nKLMNOPQRST\nVWXYZ");
    // Offset lands inside "KLMNOPQRST"; that torn line must be removed.
    const tail = readFileTail(filePath, 12);
    expect(tail.startsWith("KLMNOPQRST") || tail.startsWith("VWXYZ") || tail === "").toBe(true);
    expect(tail.endsWith("VWXYZ")).toBe(true);
  });

  it("returns an empty string for missing files", () => {
    expect(readFileTail(path.join(os.tmpdir(), "definitely-missing-file-xyz.txt"))).toBe("");
  });

  it("handles an empty file", () => {
    const filePath = createTempFile("");
    expect(readFileTail(filePath, 1024)).toBe("");
  });
});
