import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { getGlobalConfigDir } from "./config.js";
import {
  createCheckpoint,
  listCheckpointsForSession,
  restoreCheckpoint,
  deleteCheckpointsForSession,
  getGitSha,
  type Checkpoint,
} from "./checkpoints.js";
import type { Message } from "./conversation.js";

describe("checkpoints", () => {
  const checkpointsDir = path.join(getGlobalConfigDir(), "checkpoints");
  const sessionFilePath = path.join(
    getGlobalConfigDir(),
    "history",
    "test_session.json"
  );

  const sampleMessages: Message[] = [
    { role: "user", content: "hello", timestamp: 1000 },
    { role: "assistant", content: "hi there", timestamp: 1001 },
  ];

  // Track created checkpoint files for cleanup
  let createdFiles: string[] = [];

  beforeEach(() => {
    createdFiles = [];
    // Ensure directories exist
    fs.mkdirSync(checkpointsDir, { recursive: true });
    fs.mkdirSync(path.dirname(sessionFilePath), { recursive: true });
  });

  afterEach(async () => {
    // Cleanup any test checkpoint files we created
    for (const f of createdFiles) {
      try {
        await fsPromises.unlink(f);
      } catch {}
    }
    // Also cleanup session-related test files
    for (const suffix of [
      ".json",
      "_implementation_plan.md",
      "_task.md",
      "_walkthrough.md",
    ]) {
      try {
        await fsPromises.unlink(
          sessionFilePath.replace(/\.json$/, suffix)
        );
      } catch {}
    }
  });

  it("getGitSha should return a string or undefined", () => {
    const sha = getGitSha();
    // In a git repo, it should return a non-empty string
    if (sha !== undefined) {
      expect(typeof sha).toBe("string");
      expect(sha.length).toBeGreaterThan(0);
      expect(sha.length).toBeLessThanOrEqual(10); // short SHA
    }
  });

  it("createCheckpoint should save a checkpoint file and return valid data", async () => {
    const checkpoint = await createCheckpoint(
      sessionFilePath,
      "Test Checkpoint",
      sampleMessages,
      "IDLE"
    );

    expect(checkpoint.name).toBe("Test Checkpoint");
    expect(checkpoint.messages).toHaveLength(2);
    expect(checkpoint.planState).toBe("IDLE");
    expect(checkpoint.id).toMatch(/^chk_\d+$/);
    expect(checkpoint.timestamp).toBeGreaterThan(0);

    // Verify file was written
    const sessionBase = path.basename(sessionFilePath, ".json");
    const expectedPath = path.join(
      checkpointsDir,
      `${sessionBase}_checkpoint_${checkpoint.timestamp}.json`
    );
    createdFiles.push(expectedPath);

    expect(fs.existsSync(expectedPath)).toBe(true);

    const savedContent = JSON.parse(
      fs.readFileSync(expectedPath, "utf-8")
    ) as Checkpoint;
    expect(savedContent.name).toBe("Test Checkpoint");
    expect(savedContent.messages).toHaveLength(2);
  });

  it("createCheckpoint should capture plan/task/walkthrough file contents", async () => {
    // Write plan and task files
    const planPath = sessionFilePath.replace(/\.json$/, "_implementation_plan.md");
    const taskPath = sessionFilePath.replace(/\.json$/, "_task.md");
    fs.writeFileSync(planPath, "# My Plan\nSome plan content", "utf-8");
    fs.writeFileSync(taskPath, "- [ ] Task 1", "utf-8");

    const checkpoint = await createCheckpoint(
      sessionFilePath,
      "With Plan",
      sampleMessages,
      "PLANNING_PENDING"
    );

    const sessionBase = path.basename(sessionFilePath, ".json");
    createdFiles.push(
      path.join(checkpointsDir, `${sessionBase}_checkpoint_${checkpoint.timestamp}.json`)
    );

    expect(checkpoint.planFileContent).toBe("# My Plan\nSome plan content");
    expect(checkpoint.taskFileContent).toBe("- [ ] Task 1");
    expect(checkpoint.walkthroughFileContent).toBeUndefined();
  });

  it("listCheckpointsForSession should return checkpoints sorted newest-first", async () => {
    // Create multiple checkpoints with slight delays
    const c1 = await createCheckpoint(sessionFilePath, "First", sampleMessages, "IDLE");
    // Ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    const c2 = await createCheckpoint(sessionFilePath, "Second", sampleMessages, "IDLE");
    await new Promise((r) => setTimeout(r, 10));
    const c3 = await createCheckpoint(sessionFilePath, "Third", sampleMessages, "IDLE");

    const sessionBase = path.basename(sessionFilePath, ".json");
    createdFiles.push(
      path.join(checkpointsDir, `${sessionBase}_checkpoint_${c1.timestamp}.json`),
      path.join(checkpointsDir, `${sessionBase}_checkpoint_${c2.timestamp}.json`),
      path.join(checkpointsDir, `${sessionBase}_checkpoint_${c3.timestamp}.json`)
    );

    const list = await listCheckpointsForSession(sessionFilePath);
    expect(list.length).toBeGreaterThanOrEqual(3);
    // Newest first
    expect(list[0].name).toBe("Third");
    expect(list[1].name).toBe("Second");
    expect(list[2].name).toBe("First");
  });

  it("listCheckpointsForSession should return empty for non-existent session", async () => {
    const list = await listCheckpointsForSession("/non/existent/path.json");
    expect(list).toEqual([]);
  });

  it("restoreCheckpoint should write session file and plan/task/walkthrough files", async () => {
    const planContent = "# Restored Plan";
    const taskContent = "- [x] Done";

    // Create a checkpoint manually
    const sessionBase = path.basename(sessionFilePath, ".json");
    const timestamp = Date.now();
    const checkpointData: Checkpoint = {
      id: `chk_${timestamp}`,
      name: "Restore Test",
      timestamp,
      sessionFilePath,
      messages: sampleMessages,
      planState: "APPROVED",
      planFileContent: planContent,
      taskFileContent: taskContent,
      walkthroughFileContent: undefined,
    };

    const checkpointPath = path.join(
      checkpointsDir,
      `${sessionBase}_checkpoint_${timestamp}.json`
    );
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpointData, null, 2), "utf-8");
    createdFiles.push(checkpointPath);

    // Write session file (will be overwritten)
    fs.writeFileSync(sessionFilePath, "{}", "utf-8");

    const restored = await restoreCheckpoint(checkpointPath, sessionFilePath);

    expect(restored.name).toBe("Restore Test");
    expect(restored.planState).toBe("APPROVED");

    // Session file should be updated
    const sessionData = JSON.parse(fs.readFileSync(sessionFilePath, "utf-8"));
    expect(sessionData.messages).toHaveLength(2);
    expect(sessionData.planState).toBe("APPROVED");

    // Plan file should be created
    const planPath = sessionFilePath.replace(/\.json$/, "_implementation_plan.md");
    expect(fs.existsSync(planPath)).toBe(true);
    expect(fs.readFileSync(planPath, "utf-8")).toBe(planContent);

    // Task file should be created
    const taskPath = sessionFilePath.replace(/\.json$/, "_task.md");
    expect(fs.existsSync(taskPath)).toBe(true);
    expect(fs.readFileSync(taskPath, "utf-8")).toBe(taskContent);

    // Walkthrough should NOT exist (was undefined)
    const walkthroughPath = sessionFilePath.replace(/\.json$/, "_walkthrough.md");
    expect(fs.existsSync(walkthroughPath)).toBe(false);
  });

  it("deleteCheckpointsForSession should remove all session checkpoints", async () => {
    const c1 = await createCheckpoint(sessionFilePath, "Del1", sampleMessages, "IDLE");
    const c2 = await createCheckpoint(sessionFilePath, "Del2", sampleMessages, "IDLE");

    const sessionBase = path.basename(sessionFilePath, ".json");
    const f1 = path.join(checkpointsDir, `${sessionBase}_checkpoint_${c1.timestamp}.json`);
    const f2 = path.join(checkpointsDir, `${sessionBase}_checkpoint_${c2.timestamp}.json`);

    expect(fs.existsSync(f1)).toBe(true);
    expect(fs.existsSync(f2)).toBe(true);

    await deleteCheckpointsForSession(sessionFilePath);

    expect(fs.existsSync(f1)).toBe(false);
    expect(fs.existsSync(f2)).toBe(false);
  });

  it("createCheckpoint should prune older checkpoints beyond 30", async () => {
    const sessionBase = path.basename(sessionFilePath, ".json");

    // Create 32 fake checkpoint files (pre-existing)
    const oldTimestamps: number[] = [];
    for (let i = 0; i < 32; i++) {
      const ts = 1000000 + i;
      oldTimestamps.push(ts);
      const chk: Checkpoint = {
        id: `chk_${ts}`,
        name: `Old #${i}`,
        timestamp: ts,
        sessionFilePath,
        messages: sampleMessages,
        planState: "IDLE",
      };
      const fp = path.join(checkpointsDir, `${sessionBase}_checkpoint_${ts}.json`);
      fs.writeFileSync(fp, JSON.stringify(chk), "utf-8");
      createdFiles.push(fp);
    }

    // Now create a new checkpoint which triggers pruning
    const newChk = await createCheckpoint(
      sessionFilePath,
      "Newest",
      sampleMessages,
      "IDLE"
    );
    createdFiles.push(
      path.join(checkpointsDir, `${sessionBase}_checkpoint_${newChk.timestamp}.json`)
    );

    // After pruning, total should be <= 30
    const list = await listCheckpointsForSession(sessionFilePath);
    expect(list.length).toBeLessThanOrEqual(30);

    // Oldest files should have been deleted
    const oldestPath = path.join(
      checkpointsDir,
      `${sessionBase}_checkpoint_${oldTimestamps[0]}.json`
    );
    expect(fs.existsSync(oldestPath)).toBe(false);
  });
});
