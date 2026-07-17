import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import { execa } from "execa";
import { validatePostMerge } from "../src/core/masterAgent.js";

vi.mock("execa", () => ({
  execa: vi.fn().mockResolvedValue({ stdout: "" }),
}));

describe("Post-Merge Validation (Universal)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── Conflict Marker Detection ──────────────────────────────────────────

  describe("conflict marker detection", () => {
    it("should detect leftover conflict markers in changed files", async () => {
      const contentWithMarkers = `
const a = 1;
<<<<<<< HEAD
const b = 2;
=======
const b = 3;
>>>>>>> feature-branch
const c = 4;
`;
      vi.spyOn(fs, "existsSync").mockReturnValue(true);
      vi.spyOn(fs, "readFileSync").mockReturnValue(contentWithMarkers);

      const result = await validatePostMerge(process.cwd(), "feat/test", ["src/index.ts"]);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("conflict marker"))).toBe(true);
    });

    it("should pass when no conflict markers exist", async () => {
      const cleanContent = `
const a = 1;
const b = 2;
const c = 3;
`;
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        if (p.toString().endsWith("package.json")) return false;
        return true;
      });
      vi.spyOn(fs, "readFileSync").mockReturnValue(cleanContent);

      const result = await validatePostMerge(process.cwd(), "feat/test", ["src/index.ts"]);

      expect(result.errors.filter(e => e.includes("conflict marker"))).toHaveLength(0);
    });
  });

  // ── Duplicate Adjacent Lines ───────────────────────────────────────────

  describe("duplicate adjacent lines detection", () => {
    it("should detect 3+ consecutive duplicate non-trivial lines", async () => {
      const corruptContent = [
        "const a = 1;",
        "const b = processConfig();",
        "const b = processConfig();",
        "const b = processConfig();",
        "const c = 3;",
      ].join("\n");

      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        if (p.toString().endsWith("package.json")) return false;
        return true;
      });
      vi.spyOn(fs, "readFileSync").mockReturnValue(corruptContent);

      const result = await validatePostMerge(process.cwd(), "feat/test", ["src/app.ts"]);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("duplicate adjacent"))).toBe(true);
    });

    it("should ignore consecutive blank lines and closing braces", async () => {
      const cleanContent = [
        "function foo() {",
        "  return 1;",
        "}",
        "}",
        "}",
        "",
        "",
        "",
      ].join("\n");

      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        if (p.toString().endsWith("package.json")) return false;
        return true;
      });
      vi.spyOn(fs, "readFileSync").mockReturnValue(cleanContent);

      const result = await validatePostMerge(process.cwd(), "feat/test", ["src/app.ts"]);

      const dupErrors = result.errors.filter(e => e.includes("duplicate adjacent"));
      expect(dupErrors).toHaveLength(0);
    });

    it("should ignore consecutive JSX closing tags", async () => {
      const cleanContent = [
        "<div>",
        "  <Box>",
        "    content",
        "  </Box>",
        "  </Box>",
        "  </Box>",
        "</div>",
      ].join("\n");

      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        if (p.toString().endsWith("package.json")) return false;
        return true;
      });
      vi.spyOn(fs, "readFileSync").mockReturnValue(cleanContent);

      const result = await validatePostMerge(process.cwd(), "feat/test", ["src/Component.tsx"]);

      const dupErrors = result.errors.filter(e => e.includes("duplicate adjacent"));
      expect(dupErrors).toHaveLength(0);
    });
  });

  // ── Duplicate Attributes ───────────────────────────────────────────────

  describe("duplicate attribute detection", () => {
    it("should detect duplicate attributes on the same element", async () => {
      const contentWithDupAttrs = `<div class="foo" id="main" class="bar">content</div>`;

      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        if (p.toString().endsWith("package.json")) return false;
        return true;
      });
      vi.spyOn(fs, "readFileSync").mockReturnValue(contentWithDupAttrs);

      const result = await validatePostMerge(process.cwd(), "feat/test", ["index.html"]);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Duplicate attribute "class"'))).toBe(true);
    });

    it("should not flag data-* attributes that legitimately repeat", async () => {
      const cleanContent = `<div data-id="1" data-name="test" data-value="x">content</div>`;

      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        if (p.toString().endsWith("package.json")) return false;
        return true;
      });
      vi.spyOn(fs, "readFileSync").mockReturnValue(cleanContent);

      const result = await validatePostMerge(process.cwd(), "feat/test", ["index.html"]);

      const attrErrors = result.errors.filter(e => e.includes("Duplicate attribute"));
      expect(attrErrors).toHaveLength(0);
    });
  });

  // ── Line Merging Detection ─────────────────────────────────────────────

  describe("line merging detection", () => {
    it("should warn when multiple statements are crammed on one line", async () => {
      const mergedLine = "const a = getValue(); const b = process(a); const c = validate(b);";

      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        if (p.toString().endsWith("package.json")) return false;
        return true;
      });
      vi.spyOn(fs, "readFileSync").mockReturnValue(mergedLine);

      const result = await validatePostMerge(process.cwd(), "feat/test", ["src/utils.ts"]);

      expect(result.warnings.some(w => w.includes("line merging"))).toBe(true);
    });

    it("should warn when multiple tags are on one long line", async () => {
      const mergedTags = '<button class="btn" onClick={save}>Save</button> <button class="btn" onClick={cancel}>Cancel</button> <button class="btn" onClick={del}>Delete</button>';

      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        if (p.toString().endsWith("package.json")) return false;
        return true;
      });
      vi.spyOn(fs, "readFileSync").mockReturnValue(mergedTags);

      const result = await validatePostMerge(process.cwd(), "feat/test", ["src/Toolbar.tsx"]);

      expect(result.warnings.some(w => w.includes("opening tags on one line"))).toBe(true);
    });
  });

  // ── Diff Sanity Check ──────────────────────────────────────────────────

  describe("diff sanity check", () => {
    it("should warn when staged diff is abnormally large", async () => {
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        if (p.toString().endsWith("package.json")) return false;
        return true;
      });
      vi.spyOn(fs, "readFileSync").mockReturnValue("clean code");

      // Create a spy that tracks calls AND returns values
      const execaSpy = vi.spyOn(execa, "bind" as any); // just to track
      vi.mocked(execa).mockImplementation((async (...callArgs: any[]) => {
        const [cmd, args] = callArgs;
        const a = Array.isArray(args) ? args : [];
        if (cmd === "git" && a[0] === "diff" && a[1] === "--stat") {
          if (String(a[2] || "").includes("HEAD...")) {
            return { stdout: " 10 insertions(+)" };
          }
          if (a[2] === "--cached") {
            return { stdout: " 500 insertions(+)" };
          }
        }
        return { stdout: "" };
      }) as any);

      const result = await validatePostMerge(process.cwd(), "feat/test", ["src/index.ts"]);

      expect(result.warnings.some(w => w.includes("sanity check"))).toBe(true);
    });

    it("should not warn for normal-sized diffs", async () => {
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        if (p.toString().endsWith("package.json")) return false;
        return true;
      });
      vi.spyOn(fs, "readFileSync").mockReturnValue("clean code");

      vi.mocked(execa).mockImplementation((cmd, args) => {
        if (args && args[0] === "diff" && args[1] === "--stat" && args[2] === "HEAD...feat/ok") {
          return Promise.resolve({ stdout: " 50 insertions(+)" } as any);
        }
        if (args && args[0] === "diff" && args[1] === "--stat" && args[2] === "--cached") {
          return Promise.resolve({ stdout: " 55 insertions(+)" } as any);
        }
        return Promise.resolve({ stdout: "" } as any);
      });

      const result = await validatePostMerge(process.cwd(), "feat/ok", ["src/index.ts"]);

      const sanityWarnings = result.warnings.filter(w => w.includes("sanity check"));
      expect(sanityWarnings).toHaveLength(0);
    });
  });

  // ── Project Validation ─────────────────────────────────────────────────

  describe("project-level validation", () => {
    it("should run build and test scripts from package.json", async () => {
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const pathStr = p.toString();
        if (pathStr.endsWith("bun.lockb") || pathStr.endsWith("bun.lock") || pathStr.endsWith("pnpm-lock.yaml") || pathStr.endsWith("yarn.lock")) return false;
        if (pathStr.endsWith("package.json")) return true;
        return true;
      });
      vi.spyOn(fs, "readFileSync").mockImplementation((p) => {
        if (p.toString().endsWith("package.json")) {
          return JSON.stringify({ scripts: { build: "tsc", test: "vitest" } });
        }
        return "clean code";
      });

      vi.mocked(execa).mockResolvedValue({ stdout: "" } as any);

      const result = await validatePostMerge(process.cwd(), "feat/test", ["src/index.ts"]);

      expect(execa).toHaveBeenCalledWith("npm", ["run", "build"], expect.any(Object));
      expect(execa).toHaveBeenCalledWith("npm", ["test"], expect.any(Object));
    });

    it("should report build failure as hard error", async () => {
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const pathStr = p.toString();
        if (pathStr.endsWith("bun.lockb") || pathStr.endsWith("bun.lock") || pathStr.endsWith("pnpm-lock.yaml") || pathStr.endsWith("yarn.lock")) return false;
        if (pathStr.endsWith("package.json")) return true;
        return true;
      });
      vi.spyOn(fs, "readFileSync").mockImplementation((p) => {
        if (p.toString().endsWith("package.json")) {
          return JSON.stringify({ scripts: { build: "tsc" } });
        }
        return "clean code";
      });

      vi.mocked(execa).mockImplementation((cmd, args) => {
        if (cmd === "npm" && args && args[0] === "run" && args[1] === "build") {
          throw new Error("TypeScript compilation failed: src/bad.ts(5,10): error TS2345");
        }
        return Promise.resolve({ stdout: "" } as any);
      });

      const result = await validatePostMerge(process.cwd(), "feat/test", ["src/index.ts"]);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("Build failed"))).toBe(true);
    });

    it("should report lint failure as warning, not hard error", async () => {
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const pathStr = p.toString();
        if (pathStr.endsWith("bun.lockb") || pathStr.endsWith("bun.lock") || pathStr.endsWith("pnpm-lock.yaml") || pathStr.endsWith("yarn.lock")) return false;
        if (pathStr.endsWith("package.json")) return true;
        return true;
      });
      vi.spyOn(fs, "readFileSync").mockImplementation((p) => {
        if (p.toString().endsWith("package.json")) {
          return JSON.stringify({ scripts: { build: "tsc", lint: "eslint ." } });
        }
        return "clean code";
      });

      vi.mocked(execa).mockImplementation((cmd, args) => {
        if (cmd === "npm" && args && args[0] === "run" && args[1] === "lint") {
          throw new Error("eslint: 3 warnings found");
        }
        return Promise.resolve({ stdout: "" } as any);
      });

      const result = await validatePostMerge(process.cwd(), "feat/test", ["src/index.ts"]);

      expect(result.warnings.some(w => w.includes("Lint warnings"))).toBe(true);
      // Lint failure should NOT make it invalid (it's a warning)
      const lintErrors = result.errors.filter(e => e.includes("Lint"));
      expect(lintErrors).toHaveLength(0);
    });
  });

  // ── Overall Validation ─────────────────────────────────────────────────

  describe("overall validation result", () => {
    it("should return valid=true when all checks pass", async () => {
      vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        if (p.toString().endsWith("package.json")) return false;
        return true;
      });
      vi.spyOn(fs, "readFileSync").mockReturnValue("const x = 1;\nconst y = 2;\n");

      const result = await validatePostMerge(process.cwd(), "feat/clean", ["src/clean.ts"]);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should skip files that don't exist on disk", async () => {
      vi.spyOn(fs, "existsSync").mockReturnValue(false);

      const result = await validatePostMerge(process.cwd(), "feat/test", ["nonexistent.ts"]);

      // Should not throw, should not report errors for missing files
      expect(result.errors.filter(e => e.includes("nonexistent"))).toHaveLength(0);
    });
  });
});
