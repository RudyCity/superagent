import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { chunkFileContent, CodebaseIndexer } from "../src/core/context/codebaseIndexer.js";
import { codebaseSearchTool } from "../src/core/tools/codebaseSearchTool.js";

describe("Codebase Indexer & RAG Tools", () => {
  describe("chunkFileContent", () => {
    it("should perform structural chunking on TypeScript code", () => {
      const tsCode = `
export function add(a: number, b: number): number {
  return a + b;
}

export class Calculator {
  multiply(a: number, b: number): number {
    return a * b;
  }
}
`.repeat(10);

      const chunks = chunkFileContent("src/math.ts", tsCode, "hash-123");
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].relativePath).toBe("src/math.ts");
      expect(chunks[0].content).toContain("[File: src/math.ts");
    });

    it("should perform line-based chunking on plain markdown files", () => {
      const mdContent = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`).join("\n");
      const chunks = chunkFileContent("README.md", mdContent, "hash-456");

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0].relativePath).toBe("README.md");
      expect(chunks[0].startLine).toBe(1);
    });
  });

  describe("codebase_search tool", () => {
    it("should have correct name and parameters definition", () => {
      expect(codebaseSearchTool.name).toBe("codebase_search");
      expect(codebaseSearchTool.parameters).toHaveProperty("properties");
    });

    it("should return error if query is missing", async () => {
      const res = await codebaseSearchTool.execute({}, ".");
      expect(res).toContain("Error: query argument is required.");
    });

    it("should invoke CodebaseIndexer.searchCodebase and return formatted results", async () => {
      const spy = vi.spyOn(CodebaseIndexer, "searchCodebase").mockResolvedValue([
        {
          relativePath: "src/core/agent.ts",
          startLine: 10,
          endLine: 40,
          content: "export class Agent { start() {} }",
          score: 0.95,
        },
      ]);

      const res = await codebaseSearchTool.execute({ query: "agent start class" }, ".");
      expect(res).toContain("Result #1 (Score: 95.0%)");
      expect(res).toContain("File: src/core/agent.ts");
      expect(spy).toHaveBeenCalledWith(expect.any(String), "agent start class", 5);

      spy.mockRestore();
    });
  });

  describe("CodebaseIndexer lifecycle", () => {
    const tempTestDir = path.join(os.tmpdir(), `superagent-test-indexer-${Date.now()}`);

    beforeEach(() => {
      if (!fs.existsSync(tempTestDir)) {
        fs.mkdirSync(tempTestDir, { recursive: true });
      }
      fs.writeFileSync(path.join(tempTestDir, "test.ts"), "export const hello = 'world';", "utf-8");
    });

    afterEach(() => {
      if (fs.existsSync(tempTestDir)) {
        try {
          fs.rmSync(tempTestDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it("should clean index directory without throwing", async () => {
      await expect(CodebaseIndexer.clearIndex(tempTestDir)).resolves.toBeUndefined();
    });
  });
});
