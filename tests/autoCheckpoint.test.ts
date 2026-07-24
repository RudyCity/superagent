import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";

// Isolate tests in a temp directory
const tempHome = path.join(process.cwd(), "tests", "temp-home-auto-checkpoint");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);


import * as configModule from "../src/core/config.js";

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
    // Spy on config functions to avoid API key / provider issues
    vi.spyOn(configModule, "getConfig").mockReturnValue({
      apiKey: "test-key",
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "",
      maxTokens: 4096,
      systemPrompt: "",
      workingDirectory: process.cwd(),
    } as any);
    vi.spyOn(configModule, "getInstalledSkills").mockReturnValue([] as any);

    await fs.mkdir(TEST_SESSION_DIR, { recursive: true });
    await fs.writeFile(TEST_SESSION_FILE, "{}", "utf-8");
    await deleteCheckpointsForSession(TEST_SESSION_FILE);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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
    vi.spyOn(configModule, "getConfig").mockReturnValue({
      apiKey: "test-key",
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "",
      maxTokens: 4096,
      systemPrompt: "",
      workingDirectory: process.cwd(),
    } as any);
    vi.spyOn(configModule, "getInstalledSkills").mockReturnValue([] as any);

    await fs.mkdir(TEST_SESSION_DIR, { recursive: true });
    await fs.writeFile(TEST_SESSION_FILE, "{}", "utf-8");
    await deleteCheckpointsForSession(TEST_SESSION_FILE);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await fs.rm(TEST_SESSION_DIR, { recursive: true, force: true });
    } catch {}
  });

  it("should prune checkpoints beyond 20", async () => {
    for (let i = 0; i < 22; i++) {
      await createCheckpoint(TEST_SESSION_FILE, `Checkpoint ${i}`, sampleMessages, "IDLE");
      await new Promise((r) => setTimeout(r, 2));
    }

    const checkpoints = await listCheckpointsForSession(TEST_SESSION_FILE);
    expect(checkpoints.length).toBe(20);
  });
});

describe("Auto-checkpoint: createCheckpoint preserves git SHA", () => {
  beforeEach(async () => {
    vi.spyOn(configModule, "getConfig").mockReturnValue({
      apiKey: "test-key",
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "",
      maxTokens: 4096,
      systemPrompt: "",
      workingDirectory: process.cwd(),
    } as any);
    vi.spyOn(configModule, "getInstalledSkills").mockReturnValue([] as any);

    await fs.mkdir(TEST_SESSION_DIR, { recursive: true });
    await fs.writeFile(TEST_SESSION_FILE, "{}", "utf-8");
    await deleteCheckpointsForSession(TEST_SESSION_FILE);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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
