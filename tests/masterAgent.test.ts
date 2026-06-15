import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import { execa } from "execa";
import { parseConflictHunks, resolveFileConflicts, MasterAgent } from "../src/core/masterAgent.js";

// Mock execa
vi.mock("execa", () => ({
  execa: vi.fn(),
}));

// Mock ai SDK generateText
vi.mock("ai", () => ({
  generateText: vi.fn().mockResolvedValue({ text: "resolved code content" }),
}));

describe("MasterAgent & Surgical Diff Resolution", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("parseConflictHunks", () => {
    it("should correctly identify conflict boundaries and content", () => {
      const content = `
const x = 1;
<<<<<<< HEAD
const y = 2;
=======
const y = 3;
>>>>>>> feature-branch
const z = 4;
`;
      const hunks = parseConflictHunks(content);
      expect(hunks.length).toBe(1);
      expect(hunks[0].ourSide.trim()).toBe("const y = 2;");
      expect(hunks[0].theirSide.trim()).toBe("const y = 3;");
    });

    it("should correctly handle content containing helper ======= separators", () => {
      const content = `
<<<<<<< HEAD
const y = 2;
// ===================
// Helper divider
=======
const y = 3;
// ===================
>>>>>>> feature-branch
`;
      const hunks = parseConflictHunks(content);
      expect(hunks.length).toBe(1);
      expect(hunks[0].ourSide.trim()).toBe("const y = 2;\n// ===================\n// Helper divider");
      expect(hunks[0].theirSide.trim()).toBe("const y = 3;\n// ===================");
    });
  });

  describe("resolveFileConflicts", () => {
    it("should rewrite file with resolved content from LLM", async () => {
      const conflictFile = `
<<<<<<< HEAD
const a = 1;
=======
const a = 2;
>>>>>>> branch-name
`;
      const spyExists = vi.spyOn(fs, "existsSync").mockReturnValue(true);
      const spyRead = vi.spyOn(fs, "readFileSync").mockReturnValue(conflictFile);
      const spyWrite = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});

      const result = await resolveFileConflicts("conflict.js", {} as any);

      expect(result).toBe(true);
      expect(spyWrite).toHaveBeenCalledWith(
        "conflict.js",
        expect.stringContaining("resolved code content"),
        "utf-8"
      );
    });
  });

  describe("mergeBranch", () => {
    it("should merge cleanly if no conflicts occur and validation passes", async () => {
      vi.mocked(execa).mockResolvedValue({ stdout: "" } as any);
      const master = new MasterAgent({} as any);

      const success = await master.mergeBranch("feature-1", ["src/app.tsx"]);
      expect(success).toBe(true);
      expect(execa).toHaveBeenCalledWith("git", ["merge", "--no-commit", "feature-1"], expect.any(Object));
      expect(execa).toHaveBeenCalledWith("git", ["commit", "-m", "Merge branch 'feature-1' via Master Agent"], expect.any(Object));
    });

    it("should resolve conflicts, run validation, and complete merge if conflict occurs", async () => {
      // Mock git merge failing (conflict) and git diff showing conflicts
      vi.mocked(execa).mockImplementation((cmd, args) => {
        if (cmd === "git" && args && args[0] === "merge" && args[1] === "--no-commit") {
          throw new Error("Conflict!");
        }
        if (cmd === "git" && args && args[0] === "diff" && args[2] === "--diff-filter=U") {
          return Promise.resolve({ stdout: "src/app.tsx" } as any);
        }
        return Promise.resolve({ stdout: "" } as any);
      });

      const conflictFile = `
<<<<<<< HEAD
const b = 1;
=======
const b = 2;
>>>>>>> feature-2
`;
      const spyExists = vi.spyOn(fs, "existsSync").mockReturnValue(true);
      const spyRead = vi.spyOn(fs, "readFileSync").mockImplementation((filePath) => {
        if (filePath.toString().endsWith("package.json")) {
          return JSON.stringify({ scripts: { build: "tsc", test: "vitest" } });
        }
        return conflictFile;
      });
      const spyWrite = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});

      const master = new MasterAgent({} as any);
      const success = await master.mergeBranch("feature-2", ["src/app.tsx"]);

      expect(success).toBe(true);
      expect(spyWrite).toHaveBeenCalled();
      expect(execa).toHaveBeenCalledWith("git", ["add", "-A"], expect.any(Object));
    });

    it("should abort merge and return false if conflict resolution throws error", async () => {
      // Mock git merge failing (conflict) and diff showing conflicts
      vi.mocked(execa).mockImplementation((cmd, args) => {
        if (cmd === "git" && args && args[0] === "merge" && args[1] === "--no-commit") {
          throw new Error("Conflict!");
        }
        if (cmd === "git" && args && args[0] === "diff" && args[2] === "--diff-filter=U") {
          return Promise.resolve({ stdout: "src/app.tsx" } as any);
        }
        return Promise.resolve({ stdout: "" } as any);
      });

      const spyExists = vi.spyOn(fs, "existsSync").mockReturnValue(true);
      const spyRead = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
        throw new Error("Disk read error");
      });

      const master = new MasterAgent({} as any);
      const success = await master.mergeBranch("feature-error", ["src/app.tsx"]);

      expect(success).toBe(false);
      expect(execa).toHaveBeenCalledWith("git", ["merge", "--abort"], expect.any(Object));
    });

    it("should abort merge and return false if post-merge validation fails", async () => {
      // Mock git merge succeeding, but npm test failing
      vi.mocked(execa).mockImplementation((cmd, args) => {
        if (cmd === "npm" && args && args[0] === "test") {
          throw new Error("Tests failed!");
        }
        return Promise.resolve({ stdout: "" } as any);
      });

      const master = new MasterAgent({} as any);
      const success = await master.mergeBranch("feature-failing-tests", ["src/app.tsx"]);

      expect(success).toBe(false);
      expect(execa).toHaveBeenCalledWith("git", ["merge", "--abort"], expect.any(Object));
    });
  });
});
