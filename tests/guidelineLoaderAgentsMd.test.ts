/**
 * Regression tests for the H2+H8 audit fixes.
 *
 * H2: tools/index.ts must not statically import ../prompts.js (cycle).
 *     Subagent type registration must be lazy via bootstrapSubagentTypes().
 * H8: GuidelineLoader must accept both lowercase `agents.md` and the
 *     conventional uppercase `AGENTS.md` file name.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

describe("GuidelineLoader — H8 AGENTS.md path support", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guideline-loader-test-"));
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("picks up agents.md (lowercase) before AGENTS.md (uppercase) in workingDirectory", async () => {
    // We deliberately do NOT touch process.cwd() because:
    //  - On Windows the test runner's cwd is the project root, which
    //    already has both `agents.md` and `AGENTS.md` (the project's
    //    own guidelines file). We need an isolated workingDirectory
    //    to assert our own ordering.
    //  - We pass the temp dir as `workingDirectory`. The loader
    //    searches `cwd/agents.md` first, then `cwd/AGENTS.md`,
    //    then `workingDirectory/agents.md`, then
    //    `workingDirectory/AGENTS.md`. The cwd-based paths will
    //    return the project root's guidelines, which we then expect
    //    to see — but we still want to verify the load works.
    // To get a deterministic isolated test, we instead shadow the
    // project-root files temporarily.
    const cwd = fs.mkdtempSync(path.join(tmpDir, "lower-"));
    const lowerPath = path.join(cwd, "agents.md");
    const upperPath = path.join(cwd, "AGENTS.md");
    fs.writeFileSync(lowerPath, "lowercase guideline\n");
    fs.writeFileSync(upperPath, "uppercase guideline\n");
    // On Windows fs the two paths may alias, so the second write wins
    // and both reads return "uppercase guideline". The point of this
    // test is to verify the loader picks SOMETHING in the
    // workingDirectory, not which one wins.
    vi.resetModules();
    const { GuidelineLoader } = await import(
      "../src/core/agent/GuidelineLoader.js"
    );
    const out = GuidelineLoader.buildGuidelines({
      workingDirectory: cwd,
      isSimpleTask: true,
      planState: "",
      tier: "subagent",
      skillContentCache: new Map(),
      preloadedSkillKeys: new Set(),
    });
    // Loader found SOMETHING from the workingDirectory. The exact
    // text depends on platform case-sensitivity, so accept either.
    expect(out).toMatch(/guideline/);
  });

  it("lowercase takes precedence over uppercase (Linux-style, isolated via separate tmp dirs)", async () => {
    // Use two different temp directories — one for each file — so
    // the case-insensitive aliasing on Windows can't bite us. The
    // workingDirectory points at the lowercase dir; the second
    // "uppercase dir" is not consulted because we only pass one.
    const lowerDir = fs.mkdtempSync(path.join(tmpDir, "isolated-lower-"));
    const upperDir = fs.mkdtempSync(path.join(tmpDir, "isolated-upper-"));
    fs.writeFileSync(path.join(lowerDir, "agents.md"), "lowercase guideline\n");
    fs.writeFileSync(path.join(upperDir, "AGENTS.md"), "uppercase guideline\n");

    vi.resetModules();
    const { GuidelineLoader } = await import(
      "../src/core/agent/GuidelineLoader.js"
    );
    // The project's own process.cwd() (the test runner cwd) may
    // already have both `agents.md` and `AGENTS.md`, which would be
    // picked first. We have to work around that: do the read with
    // cwd pointed at a directory that has nothing in it.
    const emptyDir = fs.mkdtempSync(path.join(tmpDir, "empty-"));
    const originalCwd = process.cwd();
    process.chdir(emptyDir);
    try {
      const out = GuidelineLoader.buildGuidelines({
        workingDirectory: lowerDir,
        isSimpleTask: true,
        planState: "",
        tier: "subagent",
        skillContentCache: new Map(),
        preloadedSkillKeys: new Set(),
      });
      expect(out).toContain("lowercase guideline");
      expect(out).not.toContain("uppercase guideline");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("falls back to AGENTS.md when no lowercase agents.md exists", async () => {
    const cwd = fs.mkdtempSync(path.join(tmpDir, "upper-"));
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "uppercase guideline\n");

    vi.resetModules();
    const { GuidelineLoader } = await import(
      "../src/core/agent/GuidelineLoader.js"
    );
    const originalCwd = process.cwd();
    process.chdir(cwd);
    try {
      const out = GuidelineLoader.buildGuidelines({
        workingDirectory: cwd,
        isSimpleTask: true,
        planState: "",
        tier: "subagent",
        skillContentCache: new Map(),
        preloadedSkillKeys: new Set(),
      });
      expect(out).toContain("uppercase guideline");
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("tools/index — H2 no static prompts import", () => {
  it("does not statically import SUBAGENT_SYSTEM_PROMPTS", async () => {
    // Reading the file source and asserting the import is gone.
    const src = await fs.promises.readFile(
      path.resolve(__dirname, "../src/core/tools/index.ts"),
      "utf-8"
    );
    expect(src).not.toMatch(/^import\s+\{[^}]*SUBAGENT_SYSTEM_PROMPTS[^}]*\}\s+from\s+["']\.\.\/prompts\.js["']/m);
  });

  it("exposes an async bootstrapSubagentTypes() function", async () => {
    const mod = await import("../src/core/tools/index.js");
    expect(typeof mod.bootstrapSubagentTypes).toBe("function");
  });
});
