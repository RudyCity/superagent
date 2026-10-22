import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HistoryManager } from "../src/core/agent/HistoryManager.js";
import { inspectBrainSession, writeBrainFile, readBrainFile } from "../src/core/brain/brainWorkspace.js";
import type { Agent } from "../src/core/agent.js";

const roots: string[] = [];
afterEach(() => {
  delete process.env.SUPERAGENT_CONFIG_DIR;
  delete process.env.SUPERAGENT_SESSION_PATH;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function mockAgent(): Agent {
  return {
    tier: "single",
    sessionId: "",
    planState: "IDLE",
    workingDirectory: process.cwd(),
    writeToLogFile: () => {},
    conversation: {
      loadFromFile: async () => {},
      rebindContextManagerForSession: async () => {},
    },
  } as unknown as Agent;
}

describe("Agent history -> Brain lifecycle", () => {
  it("allocates and resumes the matching Brain without changing the current project", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-history-")); roots.push(root);
    process.env.SUPERAGENT_CONFIG_DIR = root;
    const agent = mockAgent();
    const originalWorkspace = agent.workingDirectory;
    const firstPath = path.join(root, "history", "single", "sess_alpha", "sess_alpha.json");
    await HistoryManager.loadHistoryFromPath(agent, firstPath);
    expect(agent.sessionId).toBe("sess_alpha");
    const first = inspectBrainSession("local-cli", "sess_alpha", root);
    writeBrainFile("local-cli", "sess_alpha", "scratch/note.md", "remember this", false, root);
    await HistoryManager.loadHistoryFromPath(agent, firstPath);
    expect(inspectBrainSession("local-cli", "sess_alpha", root).path).toBe(first.path);
    expect(readBrainFile("local-cli", "sess_alpha", "scratch/note.md", root)).toBe("remember this");
    const secondPath = path.join(root, "history", "single", "sess_beta", "sess_beta.json");
    await HistoryManager.loadHistoryFromPath(agent, secondPath);
    expect(inspectBrainSession("local-cli", "sess_beta", root).sessionId).toBe("sess_beta");
    expect(agent.workingDirectory).toBe(originalWorkspace);
  });
});
