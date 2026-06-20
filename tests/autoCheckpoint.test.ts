import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";

// Isolate tests in a temp directory
const tempHome = path.join(process.cwd(), "tests", "temp-home-auto-checkpoint");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

// Mock execa to avoid running real shell commands
vi.mock("execa", () => ({
  execa: vi.fn().mockResolvedValue({ stdout: "" }),
}));

// Mock config to avoid API key / provider issues
vi.mock("../src/core/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/config.js")>();
  return {
    ...actual,
    getConfig: vi.fn().mockReturnValue({
      apiKey: "test-key",
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "",
      maxTokens: 4096,
      systemPrompt: "",
      workingDirectory: process.cwd(),
    }),
    getInstalledSkills: () => [],
    getInstalledSkillInstructions: () => [],
  };
});

import {
  createCheckpoint,
  listCheckpointsForSession,
  deleteCheckpointById,
  deleteCheckpointsForSession,
} from "../src/core/checkpoints.js";

const TEST_SESSION_DIR = path.join(tempHome, "test-session-auto");
const TEST_SESSION_FILE = path.join(TEST_SESSION_DIR, "session.json");

const sampleMessages = [
  { role: "user" as const, content: "Hello", timestamp: Date.now() },
  { role: "assistant" as const, content: "Hi there!", timestamp: Date.now() },
];

describe("Auto-checkpoint: deleteCheckpointById", () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_SESSION_DIR, { recursive: true });
    await fs.writeFile(TEST_SESSION_FILE, "{}", "utf-8");
  });

  afterEach(async () => {
    try {
      await fs.rm(TEST_SESSION_DIR, { recursive: true, force: true });
    } catch {}
  });

  it("should delete an existing checkpoint by ID", async () => {
    const cp = await createCheckpoint(TEST_SESSION_FILE, "test-delete", sampleMessages, "IDLE");
    const checkpoints = await listCheckpointsForSession(TEST_SESSION_FILE);
    expect(checkpoints.length).toBe(1);

    const deleted = await deleteCheckpointById(cp.id, TEST_SESSION_FILE);
    expect(deleted).toBe(true);

    const remaining = await listCheckpointsForSession(TEST_SESSION_FILE);
    expect(remaining.length).toBe(0);
  });

  it("should return false for non-existent checkpoint ID", async () => {
    const deleted = await deleteCheckpointById("chk_nonexistent", TEST_SESSION_FILE);
    expect(deleted).toBe(false);
  });

  it("should only delete the targeted checkpoint, not others", async () => {
    const cp1 = await createCheckpoint(TEST_SESSION_FILE, "keep-this", sampleMessages, "IDLE");
    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 10));
    const cp2 = await createCheckpoint(TEST_SESSION_FILE, "delete-this", sampleMessages, "IDLE");

    const before = await listCheckpointsForSession(TEST_SESSION_FILE);
    expect(before.length).toBe(2);

    const deleted = await deleteCheckpointById(cp2.id, TEST_SESSION_FILE);
    expect(deleted).toBe(true);

    const after = await listCheckpointsForSession(TEST_SESSION_FILE);
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(cp1.id);
    expect(after[0].name).toBe("keep-this");
  });
});

describe("Auto-checkpoint: max rotation (20)", () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_SESSION_DIR, { recursive: true });
    await fs.writeFile(TEST_SESSION_FILE, "{}", "utf-8");
  });

  afterEach(async () => {
    try {
      await fs.rm(TEST_SESSION_DIR, { recursive: true, force: true });
    } catch {}
  });

  it("should prune checkpoints beyond 20", async () => {
    const checkpointsDir = path.join(TEST_SESSION_DIR, "checkpoints");
    await fs.mkdir(checkpointsDir, { recursive: true });

    // Manually create 22 fake checkpoint files with sequential timestamps
    const baseTime = Date.now() - 100000;
    for (let i = 0; i < 22; i++) {
      const ts = baseTime + i;
      const cp = {
        id: `chk_${ts}`,
        name: `Checkpoint ${i}`,
        timestamp: ts,
        sessionFilePath: TEST_SESSION_FILE,
        messages: sampleMessages,
        planState: "IDLE" as const,
      };
      await fs.writeFile(
        path.join(checkpointsDir, `checkpoint_${ts}.json`),
        JSON.stringify(cp),
        "utf-8"
      );
    }

    const beforeCount = (await fs.readdir(checkpointsDir)).filter(f => f.startsWith("checkpoint_")).length;
    expect(beforeCount).toBe(22);

    // Creating a new checkpoint should trigger pruning to 20
    await createCheckpoint(TEST_SESSION_FILE, "trigger-prune", sampleMessages, "IDLE");

    const afterFiles = (await fs.readdir(checkpointsDir)).filter(f => f.startsWith("checkpoint_"));
    expect(afterFiles.length).toBe(20);
  });
});

describe("Auto-checkpoint: createCheckpoint preserves git SHA", () => {
  beforeEach(async () => {
    await fs.mkdir(TEST_SESSION_DIR, { recursive: true });
    await fs.writeFile(TEST_SESSION_FILE, "{}", "utf-8");
  });

  afterEach(async () => {
    try {
      await fs.rm(TEST_SESSION_DIR, { recursive: true, force: true });
    } catch {}
  });

  it("should create checkpoint with correct structure", async () => {
    const cp = await createCheckpoint(TEST_SESSION_FILE, "struct-test", sampleMessages, "APPROVED");

    expect(cp.id).toMatch(/^chk_/);
    expect(cp.name).toBe("struct-test");
    expect(cp.messages.length).toBe(2);
    expect(cp.planState).toBe("APPROVED");
    expect(cp.sessionFilePath).toBe(TEST_SESSION_FILE);
    expect(typeof cp.timestamp).toBe("number");
  });
});
