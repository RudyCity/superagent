import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runSandboxSkillReplay } from "../src/core/skills/skillReplay.js";
import type { SkillReplayFixture } from "../src/core/skills/skillLifecycle.js";

const candidate = {
  name: "replay-fixture-helper",
  version: "a1b2c3d4e5f6",
  markdownContent: [
    "---",
    "name: replay-fixture-helper",
    "description: fixture skill for the sandbox replay test",
    "---",
    "# Replay Fixture Helper",
    "",
    "Use the task prompt and edit only the files in the provided temporary workspace.",
    "Check expected output and verify syntax before finishing.",
  ].join("\n"),
};

const fixture: SkillReplayFixture = {
  fixtureId: "json-output-fixture-v1",
  name: "Write a verified JSON output",
  description: "Create one JSON artifact and one small source file.",
  taskPrompt: "Create result.json with an ok=true property and create src/result.ts exporting a constant.",
  initialFiles: {
    "input.json": JSON.stringify({ request: "fixture" }, null, 2),
    "empty.txt": "",
  },
  actions: [
    { type: "assert_file_exists", target: "result.json" },
    { type: "assert_file_contains", target: "result.json", expected: '"ok": true' },
    { type: "verify_syntax", target: "src/result.ts" },
    { type: "read_file", target: "src/result.ts", expected: "export const result = true" },
  ],
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("sandboxed skill replay harness", () => {
  it("runs an executor only against a disposable file API and validates postconditions", async () => {
    const liveRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skill-replay-live-"));
    roots.push(liveRoot);
    const result = await runSandboxSkillReplay(candidate, fixture, async (context) => {
      expect(context.skillName).toBe(candidate.name);
      expect(context.skillVersion).toBe(candidate.version);
      expect(context.instructions).toContain("temporary workspace");
      expect(context.taskPrompt).toContain("result.json");
      expect(await context.tools.listFiles()).toContain("input.json");
      expect(await context.tools.readFile("empty.txt")).toBe("");

      await context.tools.writeFile("result.json", JSON.stringify({ ok: true }, null, 2));
      await context.tools.writeFile("src/result.ts", "export const result = true;\n");
      await context.tools.verifySyntax("src/result.ts");

      // The replay executor gets no live-workspace path and the live folder stays untouched.
      expect(await fs.readdir(liveRoot)).toHaveLength(0);
      return { summary: "completed", provider: "test-provider", model: "test-model", promptTokens: 20, completionTokens: 10 };
    }, { timeoutMs: 5_000 });

    expect(result.status, JSON.stringify(result, null, 2)).toBe("passed");
    expect(result.skillVersion).toBe(candidate.version);
    expect(result.runId).toBeTruthy();
    expect(result.fixtureSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.provider).toBe("test-provider");
    expect(result.model).toBe("test-model");
    expect(result.promptTokens).toBe(20);
    expect(result.completionTokens).toBe(10);
    expect(result.changedFiles).toEqual(["result.json", "src/result.ts"]);
    expect(result.checks).toHaveLength(4);
    expect(result.checks.every(check => check.status === "pass")).toBe(true);
    expect(result.actionsExecuted).toBe(5);
  }, 10_000);

  it("refuses traversal paths supplied by a replay fixture", async () => {
    const malicious: SkillReplayFixture = {
      ...fixture,
      fixtureId: "path-traversal-fixture",
      actions: [{ type: "assert_file_exists", target: "../outside.txt" }],
    };
    await expect(runSandboxSkillReplay(candidate, malicious, async () => undefined))
      .rejects.toThrow(/absolute, traversal, or malformed/);
  });

  it("fails a replay when an executor attempts to traverse outside the sandbox", async () => {
    const result = await runSandboxSkillReplay(candidate, fixture, async ({ tools }) => {
      await tools.writeFile("../outside.txt", "not allowed");
    }, { timeoutMs: 5_000 });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/traversal|sandbox/i);
    expect(result.checks.every(check => check.status === "fail")).toBe(true);
  }, 10_000);

  it("aborts an executor that cooperatively observes the replay timeout signal", async () => {
    let observedAbort = false;
    const result = await runSandboxSkillReplay(candidate, fixture, async ({ signal }) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          observedAbort = true;
          resolve();
          return;
        }
        signal.addEventListener("abort", () => {
          observedAbort = true;
          resolve();
        }, { once: true });
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }, { timeoutMs: 1_000 });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/timed out/i);
    expect(observedAbort).toBe(true);
  }, 5_000);

  it("checks source syntax by parsing, without executing candidate-written JavaScript", async () => {
    const syntaxFixture: SkillReplayFixture = {
      ...fixture,
      fixtureId: "syntax-failure-fixture",
      actions: [{ type: "verify_syntax", target: "src/broken.js" }],
    };
    const result = await runSandboxSkillReplay(candidate, syntaxFixture, async ({ tools }) => {
      await tools.writeFile("src/broken.js", "function { process.exit(99); }");
    }, { timeoutMs: 5_000 });
    expect(result.status).toBe("failed");
    expect(result.checks[0]?.detail).toMatch(/syntax parse failed/i);
  }, 10_000);
});
