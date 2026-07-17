import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Isolate home directory for this test
const tempHome = path.join(process.cwd(), "tests", "temp-home-worker-workspace-test");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { handleSlashCommand, type ChatLine } from "../src/core/slash-commands.js";
import { Agent } from "../src/core/agent.js";
import { getTrustedDirectories, clearModelConfigCache } from "../src/core/config/jsonConfig.js";

describe("Slash Command: /workspace", () => {
  let addedLines: ChatLine[] = [];
  let activeWizard: any = null;
  let wizardOptions: string[] = [];
  let wizardSelectedIndex = 0;
  let workingDir = process.cwd();

  const mockCtx = {
    addLine: (line: ChatLine) => {
      addedLines.push(line);
    },
    exit: () => {},
    agent: {
      workingDirectory: workingDir,
    } as any,
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
    mockCtx.agent.workingDirectory = workingDir;

    if (!fs.existsSync(tempHome)) {
      fs.mkdirSync(tempHome, { recursive: true });
    }
    clearModelConfigCache();
  });

  afterEach(() => {
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {}
  });

  it("should trigger wizard dialog when run without arguments", async () => {
    await handleSlashCommand("/workspace", mockCtx as any);
    expect(activeWizard).toBeDefined();
    expect(activeWizard.type).toBe("workspace");
    expect(activeWizard.step).toBe(1);
    expect(wizardOptions.length).toBeGreaterThan(0);
    expect(wizardOptions[wizardOptions.length - 1]).toBe("➕ Add a new workspace...");
  });

  it("should list workspaces", async () => {
    await handleSlashCommand("/workspace list", mockCtx as any);
    expect(addedLines.length).toBeGreaterThan(0);
    expect(addedLines[0].content).toContain("Registered Workspaces:");
  });

  it("should add a workspace path", async () => {
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
    expect(workingDir).toBe(path.resolve(switchDir));
  });
});
