import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPromptInjectionBlock,
  getActiveLessonsForWorkspace,
  MAX_INJECTED_LESSONS,
  MAX_LESSON_CHARS,
} from "../../src/core/selfdev/injector.js";
import type { SelfDevStoreData } from "../../src/core/selfdev/types.js";

describe("SelfDev Injector", () => {
  let tmpDir: string;
  let storePath: string;
  const workspace = "test-ws-inject";

  beforeEach(async () => {
    const root = resolve("tmp");
    await mkdir(root, { recursive: true });
    tmpDir = await mkdtemp(join(root, "injector-test-"));
    storePath = join(tmpDir, "lessons.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("retrieves only active lessons for the target workspace", async () => {
    const data: SelfDevStoreData = {
      schemaVersion: 1,
      updatedAt: Date.now(),
      lessons: [
        {
          id: "l-1",
          version: 2,
          status: "active",
          workspace,
          statement: "Always use ; instead of && in PowerShell",
          evidenceIds: ["ev-1"],
          tags: ["powershell"],
          createdAt: 1000,
          updatedAt: 2000,
          approvedBy: "user",
          approvedAt: 2000,
        },
        {
          id: "l-2",
          version: 1,
          status: "candidate",
          workspace,
          statement: "Candidate lesson that is not yet approved",
          evidenceIds: ["ev-2"],
          tags: ["draft"],
          createdAt: 1500,
          updatedAt: 1500,
        },
        {
          id: "l-3",
          version: 3,
          status: "retired",
          workspace,
          statement: "Retired rule that should not be injected",
          evidenceIds: ["ev-3"],
          tags: ["old"],
          createdAt: 500,
          updatedAt: 3000,
          retiredAt: 3000,
        },
        {
          id: "l-4",
          version: 2,
          status: "active",
          workspace: "other-workspace",
          statement: "Active lesson from a foreign workspace",
          evidenceIds: ["ev-4"],
          tags: ["other"],
          createdAt: 1000,
          updatedAt: 2000,
          approvedBy: "user",
          approvedAt: 2000,
        },
      ],
    };

    await writeFile(storePath, JSON.stringify(data, null, 2), "utf8");

    const active = await getActiveLessonsForWorkspace({
      workspace,
      storePath,
      config: { enabled: true, injectionEnabled: true },
    });

    expect(active).toHaveLength(1);
    expect(active[0].id).toBe("l-1");
  });

  it("formats lessons into an advisory prompt block with character bounds", async () => {
    const longStatement = "A".repeat(350);
    const data: SelfDevStoreData = {
      schemaVersion: 1,
      updatedAt: Date.now(),
      lessons: [
        {
          id: "l-long",
          version: 2,
          status: "active",
          workspace,
          statement: longStatement,
          evidenceIds: ["ev-long"],
          tags: ["test"],
          createdAt: 1000,
          updatedAt: 2000,
          approvedBy: "user",
          approvedAt: 2000,
        },
      ],
    };

    await writeFile(storePath, JSON.stringify(data, null, 2), "utf8");

    const block = await buildPromptInjectionBlock({
      workspace,
      storePath,
      config: { enabled: true, injectionEnabled: true },
    });

    expect(block).toContain("=== WORKSPACE OPERATIONAL LESSONS ===");
    expect(block).toContain("A".repeat(MAX_LESSON_CHARS - 3) + "...");
    expect(block).not.toContain("A".repeat(MAX_LESSON_CHARS + 10));
  });

  it("caps maximum injected lessons at 5", async () => {
    const lessons = Array.from({ length: 10 }, (_, i) => ({
      id: `lesson-${i}`,
      version: 2,
      status: "active" as const,
      workspace,
      statement: `Active rule number ${i}`,
      evidenceIds: [`ev-${i}`],
      tags: ["rule"],
      createdAt: 1000 + i,
      updatedAt: 2000 + i,
      approvedBy: "user",
      approvedAt: 2000 + i,
    }));

    const data: SelfDevStoreData = {
      schemaVersion: 1,
      updatedAt: Date.now(),
      lessons,
    };

    await writeFile(storePath, JSON.stringify(data, null, 2), "utf8");

    const active = await getActiveLessonsForWorkspace({
      workspace,
      storePath,
      config: { enabled: true, injectionEnabled: true },
    });

    expect(active).toHaveLength(MAX_INJECTED_LESSONS);
  });

  it("returns empty string when disabled or file missing", async () => {
    const blockDisabled = await buildPromptInjectionBlock({
      workspace,
      storePath,
      config: { enabled: false, injectionEnabled: true },
    });
    expect(blockDisabled).toBe("");

    const blockMissing = await buildPromptInjectionBlock({
      workspace,
      storePath: "/nonexistent/lessons.json",
      config: { enabled: true, injectionEnabled: true },
    });
    expect(blockMissing).toBe("");
  });
});
