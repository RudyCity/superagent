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
      vi.mocked(execa).mockImplementation((cmd, args) => {
        // merge-base --is-ancestor: exit 1 = NOT an ancestor, proceed with merge
        if (cmd === "git" && args && args[0] === "merge-base" && args[1] === "--is-ancestor") {
          const err: any = new Error("Not ancestor");
          err.exitCode = 1;
          throw err;
        }
        return Promise.resolve({ stdout: "" } as any);
      });

      // Mock file reads to return clean content (no corruption)
      const spyExists = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        if (p.toString().endsWith("package.json")) return false;
        return false; // no changed files to validate
      });
      const spyRead = vi.spyOn(fs, "readFileSync").mockReturnValue("clean content");

      const master = new MasterAgent({} as any);

      const result = await master.mergeBranch("feature-1", ["src/app.tsx"]);
      expect(result).toBe("merged");
      expect(execa).toHaveBeenCalledWith("git", ["merge", "--no-commit", "feature-1"], expect.any(Object));
      expect(execa).toHaveBeenCalledWith("git", ["commit", "-m", "Merge branch 'feature-1' via Master Agent"], expect.any(Object));

      spyExists.mockRestore();
      spyRead.mockRestore();
    });

    it("should return 'already-merged' if branch is already an ancestor of HEAD", async () => {
      vi.mocked(execa).mockImplementation((cmd, args) => {
        // merge-base --is-ancestor: exit 0 = IS an ancestor, already merged
        if (cmd === "git" && args && args[0] === "merge-base" && args[1] === "--is-ancestor") {
          return Promise.resolve({ stdout: "" } as any);
        }
        return Promise.resolve({ stdout: "" } as any);
      });
      const master = new MasterAgent({} as any);

      const result = await master.mergeBranch("feature-already", ["src/app.tsx"]);
      expect(result).toBe("already-merged");
      // merge --no-commit should NOT have been called
      expect(execa).not.toHaveBeenCalledWith("git", ["merge", "--no-commit", "feature-already"], expect.any(Object));
    });

    it("should abort merge and return false when conflict occurs (no auto-resolve)", async () => {
      // Mock git merge failing (conflict) and git diff showing conflicts
      vi.mocked(execa).mockImplementation((cmd, args) => {
        if (cmd === "git" && args && args[0] === "merge-base" && args[1] === "--is-ancestor") {
          const err: any = new Error("Not ancestor");
          err.exitCode = 1;
          throw err;
        }
        if (cmd === "git" && args && args[0] === "merge" && args[1] === "--no-commit") {
          throw new Error("Conflict!");
        }
        if (cmd === "git" && args && args[0] === "diff" && args[2] === "--diff-filter=U") {
          return Promise.resolve({ stdout: "src/app.tsx" } as any);
        }
        return Promise.resolve({ stdout: "" } as any);
      });

      // Mock file read to return a complex conflict that can't be resolved by line-based resolution
      const conflictContent = `<<<<<<< HEAD
const x = 1;
const y = 2;
=======
const a = 10;
const b = 20;
>>>>>>> feature-2`;
      vi.spyOn(fs, "readFileSync").mockReturnValue(conflictContent);
      vi.spyOn(fs, "existsSync").mockReturnValue(true);

      const master = new MasterAgent({} as any);
      const result = await master.mergeBranch("feature-2", ["src/app.tsx"]);

      // Complex conflicts should NOT be auto-resolved — merge should abort
      expect(result).toBe(false);
      expect(execa).toHaveBeenCalledWith("git", ["merge", "--abort"], expect.any(Object));
      // lastMergeErrors should contain conflict info
      expect(master.lastMergeErrors.length).toBeGreaterThan(0);
      expect(master.lastMergeErrors[0]).toContain("conflict");
    });

    it("should abort merge and return false if conflict resolution throws error", async () => {
      // Mock git merge failing (conflict) and diff showing conflicts
      vi.mocked(execa).mockImplementation((cmd, args) => {
        if (cmd === "git" && args && args[0] === "merge-base" && args[1] === "--is-ancestor") {
          const err: any = new Error("Not ancestor");
          err.exitCode = 1;
          throw err;
        }
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
      const result = await master.mergeBranch("feature-error", ["src/app.tsx"]);

      expect(result).toBe(false);
      expect(execa).toHaveBeenCalledWith("git", ["merge", "--abort"], expect.any(Object));
    });

    it("should abort merge and return false if post-merge validation fails", async () => {
      // Mock git merge succeeding, but npm test failing
      vi.mocked(execa).mockImplementation((cmd, args) => {
        if (cmd === "git" && args && args[0] === "merge-base" && args[1] === "--is-ancestor") {
          const err: any = new Error("Not ancestor");
          err.exitCode = 1;
          throw err;
        }
        if (cmd === "npm" && args && args[0] === "test") {
          throw new Error("Tests failed!");
        }
        return Promise.resolve({ stdout: "" } as any);
      });

      const master = new MasterAgent({} as any);
      const result = await master.mergeBranch("feature-failing-tests", ["src/app.tsx"]);

      expect(result).toBe(false);
      expect(execa).toHaveBeenCalledWith("git", ["merge", "--abort"], expect.any(Object));
    });
  });
});
