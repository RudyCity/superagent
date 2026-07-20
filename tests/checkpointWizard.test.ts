import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const tempHome = path.join(process.cwd(), "tests", "temp-home-checkpoint-wizard");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

vi.mock("execa", () => ({
  execa: vi.fn().mockResolvedValue({ stdout: "" }),
}));

import { handleSlashCommand, type ChatLine } from "../src/core/slash-commands.js";
import { Agent } from "../src/core/agent.js";
import * as configModule from "../src/core/config.js";
import { getModelConfigPath } from "../src/core/config/paths.js";
import { clearModelConfigCache } from "../src/core/config/jsonConfig.js";
import {
  createCheckpoint,
  listCheckpointsForSession,
} from "../src/core/checkpoints.js";

vi.mock("../src/core/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof configModule>();
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

const configPath = getModelConfigPath();

// Create a mock agent with session file
function createMockAgent(sessionDir: string): Agent {
  const sessionFile = path.join(sessionDir, `session_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(sessionFile, "{}", "utf-8");
  const agent = new Agent({
    tier: "superagent",
    delegationDepth: 0,
    onEvent: () => {},
    onPermission: async () => true,
    onQuestion: async () => "",
  });
  // Override session file path
  (agent as any).currentHistoryFilePath = sessionFile;
  return agent;
}

function createMockCtx(agent: Agent) {
  const lines: ChatLine[] = [];
  let activeWizard: any = null;
  let wizardOptions: string[] = [];
  let wizardSelectedIndex = 0;
  let checkpointsList: any[] = [];

  return {
    lines,
    get activeWizard() { return activeWizard; },
    get wizardOptions() { return wizardOptions; },
    get wizardSelectedIndex() { return wizardSelectedIndex; },
    get checkpointsList() { return checkpointsList; },
    ctx: {
      addLine: (line: ChatLine) => lines.push(line),
      exit: () => {},
      agent,
      setActiveWizard: (w: any) => { activeWizard = w; },
      setWizardOptions: (opts: string[]) => { wizardOptions = opts; },
      setWizardSelectedIndex: (i: number) => { wizardSelectedIndex = i; },
      setCheckpointsList: (list: any[]) => { checkpointsList = list; },
      setIsProcessing: () => {},
    },
  };
}

describe("Checkpoint wizard: /checkpoint (no args)", () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = path.join(tempHome, `test-wizard-${Date.now()}`);
    fs.mkdirSync(sessionDir, { recursive: true });
    clearModelConfigCache();
  });

  afterEach(() => {
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
  });

  it("should open browse wizard when checkpoints exist", async () => {
    const agent = createMockAgent(sessionDir);
    // Create a checkpoint first
    await createCheckpoint(
      (agent as any).currentHistoryFilePath,
      "test-checkpoint",
      [{ role: "user", content: "hello", timestamp: Date.now() }],
      "IDLE"
    );

    const mock = createMockCtx(agent);
    await handleSlashCommand("/checkpoint", mock.ctx as any);

    // Wait for async listCheckpoints
    await new Promise(r => setTimeout(r, 200));

    expect(mock.activeWizard).not.toBeNull();
    expect(mock.activeWizard?.type).toBe("checkpoint");
    expect(mock.activeWizard?.data?.action).toBe("browse");
    expect(mock.wizardOptions.length).toBeGreaterThan(0);
  });

  it("should show message when no checkpoints exist", async () => {
    const agent = createMockAgent(sessionDir);
    const mock = createMockCtx(agent);
    await handleSlashCommand("/checkpoint", mock.ctx as any);

    await new Promise(r => setTimeout(r, 200));

    const systemLines = mock.lines.filter(l => l.type === "system");
    expect(systemLines.some(l => l.content.includes("No checkpoints found"))).toBe(true);
    expect(mock.activeWizard).toBeNull();
  });
});

describe("Checkpoint wizard: /checkpoint restore (no ID)", () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = path.join(tempHome, `test-restore-${Date.now()}`);
    fs.mkdirSync(sessionDir, { recursive: true });
    clearModelConfigCache();
  });

  afterEach(() => {
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
  });

  it("should open restore wizard when checkpoints exist", async () => {
    const agent = createMockAgent(sessionDir);
    await createCheckpoint(
      (agent as any).currentHistoryFilePath,
      "restore-test",
      [{ role: "user", content: "hi", timestamp: Date.now() }],
      "IDLE"
    );

    const mock = createMockCtx(agent);
    await handleSlashCommand("/checkpoint restore", mock.ctx as any);

    await new Promise(r => setTimeout(r, 200));

    expect(mock.activeWizard?.type).toBe("checkpoint");
    expect(mock.activeWizard?.data?.action).toBe("restore");
    expect(mock.wizardOptions.length).toBeGreaterThan(0);
  });
});

describe("Checkpoint wizard: /checkpoint delete (no ID)", () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = path.join(tempHome, `test-delete-${Date.now()}`);
    fs.mkdirSync(sessionDir, { recursive: true });
    clearModelConfigCache();
  });

  afterEach(() => {
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
  });

  it("should open delete wizard when checkpoints exist", async () => {
    const agent = createMockAgent(sessionDir);
    await createCheckpoint(
      (agent as any).currentHistoryFilePath,
      "delete-test",
      [{ role: "user", content: "hi", timestamp: Date.now() }],
      "IDLE"
    );

    const mock = createMockCtx(agent);
    await handleSlashCommand("/checkpoint delete", mock.ctx as any);

    await new Promise(r => setTimeout(r, 200));

    expect(mock.activeWizard?.type).toBe("checkpoint");
    expect(mock.activeWizard?.data?.action).toBe("delete");
    expect(mock.wizardOptions.length).toBeGreaterThan(0);
  });
});

describe("Checkpoint: /checkpoint delete <id> direct", () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = path.join(tempHome, `test-direct-del-${Date.now()}`);
    fs.mkdirSync(sessionDir, { recursive: true });
    clearModelConfigCache();
  });

  afterEach(() => {
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
  });

  it("should delete checkpoint directly when ID is provided", async () => {
    const agent = createMockAgent(sessionDir);
    const cp = await createCheckpoint(
      (agent as any).currentHistoryFilePath,
      "to-delete",
      [{ role: "user", content: "hi", timestamp: Date.now() }],
      "IDLE"
    );

    const mock = createMockCtx(agent);
    await handleSlashCommand(`/checkpoint delete ${cp.id}`, mock.ctx as any);

    await new Promise(r => setTimeout(r, 200));

    const systemLines = mock.lines.filter(l => l.type === "system");
    expect(systemLines.some(l => l.content.includes("deleted successfully"))).toBe(true);

    // Verify checkpoint is gone
    const remaining = await listCheckpointsForSession((agent as any).currentHistoryFilePath);
    expect(remaining.length).toBe(0);
  });

  it("should show error for non-existent ID", async () => {
    const agent = createMockAgent(sessionDir);
    const mock = createMockCtx(agent);
    await handleSlashCommand("/checkpoint delete chk_nonexistent", mock.ctx as any);

    await new Promise(r => setTimeout(r, 200));

    const errorLines = mock.lines.filter(l => l.type === "error");
    expect(errorLines.some(l => l.content.includes("not found"))).toBe(true);
  });
});

describe("Checkpoint: /checkpoint <name> creates checkpoint", () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = path.join(tempHome, `test-create-${Date.now()}`);
    fs.mkdirSync(sessionDir, { recursive: true });
    clearModelConfigCache();
  });

  afterEach(() => {
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
  });

  it("should create checkpoint with given name", async () => {
    const agent = createMockAgent(sessionDir);
    const mock = createMockCtx(agent);
    await handleSlashCommand("/checkpoint my-save-point", mock.ctx as any);

    await new Promise(r => setTimeout(r, 200));

    const systemLines = mock.lines.filter(l => l.type === "system");
    expect(systemLines.some(l => l.content.includes("my-save-point"))).toBe(true);

    const checkpoints = await listCheckpointsForSession((agent as any).currentHistoryFilePath);
    expect(checkpoints.length).toBe(1);
    expect(checkpoints[0].name).toBe("my-save-point");
  });
});
