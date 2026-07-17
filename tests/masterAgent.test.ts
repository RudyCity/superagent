import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { execa } from "execa";
import { parseConflictHunks, resolveFileConflicts, MasterAgent, detectPackageManager } from "../src/core/masterAgent.js";

vi.mock("../src/core/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/config.js")>();
  return {
    ...actual,
    getSettings: vi.fn(() => ({
      concurrencyLimit: 0,
      rateLimitRpm: 0,
      rateLimitCapacity: 60,
      disableStreaming: false,
      contextWindowLimit: 0,
      maxIterations: 50,
    })),
  };
});

// Mock execa
vi.mock("execa", () => ({
  execa: vi.fn(),
}));

// Mock ai SDK generateText
vi.mock("ai", () => ({
  generateText: vi.fn().mockResolvedValue({ text: "resolved code content" }),
}));

describe("MasterAgent & Surgical Diff Resolution", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
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
      const spyExists = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const pathStr = String(p);
        if (pathStr.endsWith("conflict.js")) return true;
        if (pathStr.includes("model-config.json")) return false;
        return true;
      });
      const spyRead = vi.spyOn(fs, "readFileSync").mockImplementation((p) => {
        const pathStr = String(p);
        if (pathStr.endsWith("conflict.js")) {
          return conflictFile as any;
        }
        if (pathStr.includes("model-config.json")) {
          throw new Error("Config not found");
        }
        return "" as any;
      });
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

    it("should use line-based resolution when conflict is safely resolvable", async () => {
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

      // Safe subset/superset conflict should resolve with line-based merge
      const conflictContent = `<<<<<<< HEAD
const x = 1;
console.log("ours");
=======
const x = 1;
console.log("ours");
return "theirs";
>>>>>>> feature-2`;
      const spyRead = vi.spyOn(fs, "readFileSync").mockImplementation((p) => {
        const pathStr = String(p);
        if (pathStr.endsWith("src/app.tsx")) {
          return conflictContent as any;
        }
        if (pathStr.includes("model-config.json")) {
          throw new Error("Config not found");
        }
        return "" as any;
      });
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const pathStr = String(p);
        if (pathStr.endsWith("src/app.tsx")) return true;
        if (pathStr.includes("model-config.json")) return false;
        return true;
      });

      const master = new MasterAgent({} as any);
      const result = await master.mergeBranch("feature-2", ["src/app.tsx"]);

      // Safe conflicts now use line-based resolution and complete merge
      expect(result).toBe("merged");
      expect(execa).toHaveBeenCalledWith("git", ["commit", "-m", "Merge branch 'feature-2' (line-based resolution) via Master Agent"], expect.any(Object));
      expect(master.lastMergeErrors.length).toBe(0);
    });

    it("should use line-based resolution even if file read fallback changes", async () => {
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

      const spyExists = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const pathStr = String(p);
        if (pathStr.endsWith("src/app.tsx")) return true;
        if (pathStr.includes("model-config.json")) return false;
        return true;
      });
      const spyRead = vi.spyOn(fs, "readFileSync").mockImplementation((p) => {
        const pathStr = String(p);
        if (pathStr.endsWith("src/app.tsx")) {
          return `<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 1;\nconst b = 2;\n>>>>>>> feature-error` as any;
        }
        if (pathStr.includes("model-config.json")) {
          throw new Error("Config not found");
        }
        return "" as any;
      });

      const master = new MasterAgent({} as any);
      const result = await master.mergeBranch("feature-error", ["src/app.tsx"]);

      expect(result).toBe("merged");
      expect(execa).toHaveBeenCalledWith("git", ["commit", "-m", "Merge branch 'feature-error' (line-based resolution) via Master Agent"], expect.any(Object));
    });

    it("should abort merge and return false if post-merge validation fails", async () => {
      // Mock git merge succeeding, but npm test failing
      vi.mocked(execa).mockImplementation((cmd, args) => {
        if (cmd === "git" && args && args[0] === "merge-base" && args[1] === "--is-ancestor") {
          const err: any = new Error("Not ancestor");
          err.exitCode = 1;
          throw err;
        }
        if (args && args.includes("test")) {
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

// ─── detectPackageManager ─────────────────────────────────────────────────────

describe("detectPackageManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-detect-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 'npm' when no lockfile is present", () => {
    expect(detectPackageManager(tmpDir)).toBe("npm");
  });

  it("returns 'yarn' when yarn.lock is present", () => {
    fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "");
    expect(detectPackageManager(tmpDir)).toBe("yarn");
  });

  it("returns 'pnpm' when pnpm-lock.yaml is present", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(tmpDir)).toBe("pnpm");
  });

  it("returns 'bun' when bun.lockb is present", () => {
    fs.writeFileSync(path.join(tmpDir, "bun.lockb"), "");
    expect(detectPackageManager(tmpDir)).toBe("bun");
  });

  it("prefers bun over pnpm when both lockfiles are present", () => {
    fs.writeFileSync(path.join(tmpDir, "bun.lockb"), "");
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(tmpDir)).toBe("bun");
  });

  it("prefers pnpm over yarn when both lockfiles are present", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "");
    expect(detectPackageManager(tmpDir)).toBe("pnpm");
  });
});
