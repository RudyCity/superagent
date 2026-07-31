import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Isolate home directory for this test
const tempHome = path.join(process.cwd(), "tests", "temp-home-worker-workspace-test");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { handleSlashCommand, type ChatLine } from "../src/core/slash-commands.js";
import { Agent } from "../src/core/agent.js";
import { getTrustedDirectories, clearModelConfigCache, addTrustedDirectory, removeTrustedDirectory } from "../src/core/config/jsonConfig.js";

describe("Slash Command: /workspace and /w (Interactive Wizard)", () => {
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

  it("should trigger wizard dialog when run with or without arguments (/workspace and /w)", async () => {
    await handleSlashCommand("/workspace", mockCtx as any);
    expect(activeWizard).toBeDefined();
    expect(activeWizard.type).toBe("workspace");
    expect(activeWizard.step).toBe(1);
    expect(wizardOptions.length).toBeGreaterThan(0);
    expect(wizardOptions).toContain("2. Add a new workspace...");
    expect(wizardOptions).toContain("3. Remove a workspace...");
    expect(wizardOptions).toContain("4. View workspace status");
    expect(wizardOptions).toContain("❌ Exit Wizard");

    activeWizard = null;
    await handleSlashCommand("/w", mockCtx as any);
    expect(activeWizard).toBeDefined();
    expect(activeWizard.type).toBe("workspace");
    expect(activeWizard.step).toBe(1);
  });

  it("should add and remove trusted workspace directories using config functions", async () => {
    const dummyDir = path.join(tempHome, "dummy-workspace");
    fs.mkdirSync(dummyDir, { recursive: true });

    addTrustedDirectory(dummyDir, "Dummy Workspace");
    let trusted = getTrustedDirectories();
    expect(trusted.map(d => path.resolve(d))).toContain(path.resolve(dummyDir));

    removeTrustedDirectory(dummyDir);
    trusted = getTrustedDirectories();
    expect(trusted.map(d => path.resolve(d))).not.toContain(path.resolve(dummyDir));
  });

  it("should update agent working directory and generate distinct history file paths when workspace switches", async () => {
    const dirA = path.join(tempHome, "workspace-a");
    const dirB = path.join(tempHome, "workspace-b");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });

    mockCtx.setWorkingDirectory(dirA);
    expect(testAgent?.workingDirectory).toBe(path.resolve(dirA));
    const historyPathA = (testAgent as any).resolveHistoryFilePath(false) || "";
    expect(historyPathA).toContain("single");

    mockCtx.setWorkingDirectory(dirB);
    expect(testAgent?.workingDirectory).toBe(path.resolve(dirB));
    const historyPathB = (testAgent as any).resolveHistoryFilePath(false) || "";
    expect(historyPathB).toContain("single");
    expect(historyPathA).not.toEqual(historyPathB);
  });
});
