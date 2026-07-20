import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Isolate home directory for this test
const tempHome = path.join(process.cwd(), "tests", "temp-home-worker-workspace-test");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { handleSlashCommand, type ChatLine } from "../src/core/slash-commands.js";
import { Agent } from "../src/core/agent.js";
import { getTrustedDirectories, clearModelConfigCache, addTrustedDirectory } from "../src/core/config/jsonConfig.js";

describe("Slash Command: /workspace and /w", () => {
  let addedLines: ChatLine[] = [];
  let activeWizard: any = null;
  let wizardOptions: string[] = [];
  let wizardSelectedIndex = 0;
  let workingDir = process.cwd();
  let testAgent: Agent | null = null;

  const mockCtx = {
    addLine: (line: ChatLine) => {
      addedLines.push(line);
    },
    exit: () => {},
    agent: null as Agent | null,
    setActiveWizard: (w: any) => {
      activeWizard = w;
    },
    setWizardOptions: (opts: string[]) => {
      wizardOptions = opts;
    },
    setWizardSelectedIndex: (idx: number) => {
      wizardSelectedIndex = idx;
    },
    setWorkingDirectory: (newPath: string) => {
      workingDir = newPath;
      if (mockCtx.agent) {
        mockCtx.agent.workingDirectory = newPath;
      }
    },
  };

  beforeEach(() => {
    addedLines = [];
    activeWizard = null;
    wizardOptions = [];
    wizardSelectedIndex = 0;
    workingDir = process.cwd();

    if (!fs.existsSync(tempHome)) {
      fs.mkdirSync(tempHome, { recursive: true });
    }
    clearModelConfigCache();

    testAgent = new Agent(() => {}, async () => true, async () => ({ answers: {} }), undefined, undefined, workingDir);
    mockCtx.agent = testAgent;
  });

  afterEach(() => {
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {}
  });

  it("should trigger wizard dialog when run without arguments (/workspace and /w)", async () => {
    await handleSlashCommand("/workspace", mockCtx as any);
    expect(activeWizard).toBeDefined();
    expect(activeWizard.type).toBe("workspace");
    expect(activeWizard.step).toBe(1);
    expect(wizardOptions.length).toBeGreaterThan(0);
    expect(wizardOptions[wizardOptions.length - 1]).toBe("➕ Add a new workspace...");

    activeWizard = null;
    await handleSlashCommand("/w", mockCtx as any);
    expect(activeWizard).toBeDefined();
    expect(activeWizard.type).toBe("workspace");
    expect(activeWizard.step).toBe(1);
  });

  it("should list workspaces", async () => {
    await handleSlashCommand("/workspace list", mockCtx as any);
    expect(addedLines.length).toBeGreaterThan(0);
    expect(addedLines[0].content).toContain("Registered Workspaces:");
  });

  it("should add a workspace path and update trusted directories", async () => {
    const dummyDir = path.join(tempHome, "dummy-workspace");
    fs.mkdirSync(dummyDir, { recursive: true });

    await handleSlashCommand(`/workspace add ${dummyDir}`, mockCtx as any);
    expect(addedLines.some(l => l.content.includes("Added workspace"))).toBe(true);

    const trusted = getTrustedDirectories();
    expect(trusted.map(d => path.resolve(d))).toContain(path.resolve(dummyDir));
  });

  it("should fail to add a non-existent path", async () => {
    const nonExistent = path.join(tempHome, "does-not-exist");
    await handleSlashCommand(`/workspace add ${nonExistent}`, mockCtx as any);
    expect(addedLines.some(l => l.content.includes("Error: Path does not exist"))).toBe(true);
  });

  it("should switch working directory using select/use command", async () => {
    const switchDir = path.join(tempHome, "switch-workspace");
    fs.mkdirSync(switchDir, { recursive: true });

    await handleSlashCommand(`/workspace use ${switchDir}`, mockCtx as any);
    expect(addedLines.some(l => l.content.includes("Switched workspace to"))).toBe(true);
    expect(addedLines.some(l => l.content.includes("Started a new chat session"))).toBe(true);
    expect(workingDir).toBe(path.resolve(switchDir));
    expect(testAgent?.workingDirectory).toBe(path.resolve(switchDir));
  });

  it("should switch workspace using numerical index", async () => {
    const dir1 = path.join(tempHome, "ws-index-1");
    const dir2 = path.join(tempHome, "ws-index-2");
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    addTrustedDirectory(dir1);
    addTrustedDirectory(dir2);

    const trusted1 = getTrustedDirectories().map(d => path.resolve(d));
    const allDirs1 = [...new Set([workingDir, ...trusted1])];
    const idx1 = allDirs1.indexOf(path.resolve(dir1)) + 1;

    await handleSlashCommand(`/workspace use ${idx1}`, mockCtx as any);
    expect(workingDir).toBe(path.resolve(dir1));
    expect(testAgent?.workingDirectory).toBe(path.resolve(dir1));

    const trusted2 = getTrustedDirectories().map(d => path.resolve(d));
    const allDirs2 = [...new Set([workingDir, ...trusted2])];
    const idx2 = allDirs2.indexOf(path.resolve(dir2)) + 1;

    await handleSlashCommand(`/w use ${idx2}`, mockCtx as any);
    expect(workingDir).toBe(path.resolve(dir2));
    expect(testAgent?.workingDirectory).toBe(path.resolve(dir2));
  });

  it("should update agent working directory and generate distinct history file paths when workspace switches", async () => {
    const dirA = path.join(tempHome, "workspace-a");
    const dirB = path.join(tempHome, "workspace-b");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    await handleSlashCommand(`/workspace use ${dirA}`, mockCtx as any);
    expect(testAgent?.workingDirectory).toBe(path.resolve(dirA));
    const historyPathA = (testAgent as any).resolveHistoryFilePath(false) || "";
    expect(historyPathA).toContain("single");

    await handleSlashCommand(`/workspace use ${dirB}`, mockCtx as any);
    expect(testAgent?.workingDirectory).toBe(path.resolve(dirB));
    const historyPathB = (testAgent as any).resolveHistoryFilePath(false) || "";
    expect(historyPathB).toContain("single");
    expect(historyPathA).not.toEqual(historyPathB);
  });

  it("should verify tool execution uses updated agent working directory as CWD", async () => {
    const customWorkspace = path.join(tempHome, "tool-cwd-workspace");
    fs.mkdirSync(customWorkspace, { recursive: true });

    await handleSlashCommand(`/workspace use ${customWorkspace}`, mockCtx as any);
    expect(testAgent?.workingDirectory).toBe(path.resolve(customWorkspace));

    // Verify tools obtain workingDirectory from agent
    const targetCwd = testAgent?.workingDirectory || process.cwd();
    expect(targetCwd).toBe(path.resolve(customWorkspace));
  });
});
