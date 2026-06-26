import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render } from "ink";
import { Console } from "node:console";
import fs from "fs";
import path from "path";
import os from "os";

// Mock os.homedir() di paling atas untuk isolasi penuh
const tempHome = path.join(process.cwd(), "tests", "temp-home-wizard-back");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { handleSlashCommand, type ChatLine } from "../src/core/slash-commands.js";
import { useModelWizard } from "../src/hooks/wizard/useModelWizard.js";
import { useKeyboardHandler } from "../src/hooks/useKeyboardHandler.js";
import { ensureGlobalConfigDir } from "../src/core/config/paths.js";
import { clearModelConfigCache, getProviders, addProvider } from "../src/core/config/jsonConfig.js";

// Restore console.Console if Vitest mocked or removed it
if (!console.Console) {
  console.Console = Console;
}

// Mock useApp and useInput from ink to prevent stdin raw mode errors in Vitest
let inputCallbacks: any[] = [];
vi.mock("ink", async (importOriginal) => {
  const original = await importOriginal<typeof import("ink")>();
  return {
    ...original,
    useApp: () => ({ exit: vi.fn() }),
    useInput: vi.fn((cb) => {
      inputCallbacks.push(cb);
    }),
  };
});

describe("Model Wizard Back Navigation", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let addedLines: ChatLine[] = [];
  let activeWizard: any = null;
  let wizardOptions: string[] = [];
  let wizardSelectedIndex = 0;
  let currentInput = "";
  let contextLimit = 0;
  let activeModel = "";
  let isLoadingModels = false;

  const mockCtx = {
    setActiveWizard: (w: any) => { activeWizard = w; },
    setWizardOptions: (opts: string[]) => { wizardOptions = opts; },
    setWizardSelectedIndex: (idx: number) => { wizardSelectedIndex = idx; },
    addLine: (line: ChatLine) => { addedLines.push(line); },
    setInput: (val: any) => {
      if (typeof val === "function") {
        currentInput = val(currentInput);
      } else {
        currentInput = val;
      }
    },
    setContextLimit: (lim: any) => {
      if (typeof lim === "function") {
        contextLimit = lim(contextLimit);
      } else {
        contextLimit = lim;
      }
    },
    setActiveModel: (m: any) => {
      if (typeof m === "function") {
        activeModel = m(activeModel);
      } else {
        activeModel = m;
      }
    },
    setWizardIsLoadingModels: (loading: any) => {
      if (typeof loading === "function") {
        isLoadingModels = loading(isLoadingModels);
      } else {
        isLoadingModels = loading;
      }
    },
    wizardSelectedIndex: 0,
    wizardOptions: [] as string[],
    wizardIsLoadingModels: false,
    agentRef: {
      current: {
        isMultiAgent: true,
      }
    }
  };

  beforeEach(() => {
    originalEnv = { ...process.env };
    addedLines = [];
    activeWizard = null;
    wizardOptions = [];
    wizardSelectedIndex = 0;
    currentInput = "";
    contextLimit = 0;
    activeModel = "";
    isLoadingModels = false;
    inputCallbacks = [];
    mockCtx.agentRef.current.isMultiAgent = true;

    // Bersihkan folder temp
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    ensureGlobalConfigDir();
    clearModelConfigCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    // Bersihkan folder temp
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    clearModelConfigCache();
  });

  it("should list '< Back' in the main /model menu and close wizard when selected", async () => {
    // Start wizard
    handleSlashCommand("/model", mockCtx as any);

    expect(activeWizard).toEqual({
      type: "model",
      step: 1,
      data: {},
    });
    expect(wizardOptions).toContain("< Back");

    // Submit "< Back"
    let capturedHandler: any = null;
    const TestComponent = () => {
      capturedHandler = useModelWizard(mockCtx as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    await capturedHandler("< Back", 1, {});

    expect(activeWizard).toBeNull();
    expect(wizardOptions).toEqual([]);
    unmount();
  });

  it("should go back from step 4 (load preset) to step 1", async () => {
    let capturedHandler: any = null;
    const TestComponent = () => {
      capturedHandler = useModelWizard(mockCtx as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));
    
    // Simulate step 4 active
    activeWizard = { type: "model", step: 4, data: {} };
    await capturedHandler("< Back", 4, {});

    expect(activeWizard).toEqual({
      type: "model",
      step: 1,
      data: {},
    });
    expect(wizardOptions).toContain("5. Delete Model Preset [Multi-Agent]");
    expect(wizardOptions).toContain("< Back");
    unmount();
  });

  it("should go back from step 50 (tier configure) to step 1", async () => {
    const TestComponent = () => {
      useKeyboardHandler({
        activeWizard: { type: "model", step: 50, data: {} },
        setActiveWizard: (w: any) => { activeWizard = w; },
        setWizardOptions: (opts: string[]) => { wizardOptions = opts; },
        setWizardSelectedIndex: (idx: number) => { wizardSelectedIndex = idx; },
        wizardOptions: ["Master", "Superagent", "Subagent", "Researcher", "Coder", "Reviewer", "All", "< Back"],
        wizardSelectedIndex: 7,
        setInput: mockCtx.setInput,
        addLine: mockCtx.addLine,
        focusedResponseIndex: null,
        focusMode: "input",
        scrollOffset: 0,
        focusedResponseOffset: 0,
        agentRef: mockCtx.agentRef,
      } as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    expect(inputCallbacks.length).toBeGreaterThan(0);

    // Trigger Enter keypress (return) on "< Back"
    for (const cb of inputCallbacks) {
      cb("return", { upArrow: false, downArrow: false, return: true, escape: false, tab: false } as any);
    }

    expect(activeWizard).toEqual({
      type: "model",
      step: 1,
      data: {},
    });
    expect(wizardOptions).toContain("5. Delete Model Preset [Multi-Agent]");
    unmount();
  });

  it("should go back from step 2 (provider) to step 50", async () => {
    let capturedHandler: any = null;
    const TestComponent = () => {
      capturedHandler = useModelWizard(mockCtx as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    // Simulate step 2 active
    activeWizard = { type: "model", step: 2, data: { tier: "master" } };
    await capturedHandler("< Back", 2, { tier: "master" });

    expect(activeWizard).toEqual({
      type: "model",
      step: 50,
      data: { tier: "master" },
    });
    expect(wizardOptions).toContain("< Back");
    expect(wizardOptions.some(opt => opt.includes("Master Agent"))).toBe(true);
    unmount();
  });

  it("should go back from step 3 (model) to step 2", async () => {
    let capturedHandler: any = null;
    const TestComponent = () => {
      capturedHandler = useModelWizard(mockCtx as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    // Simulate step 3 active (which is the default else block)
    activeWizard = { type: "model", step: 3, data: { tier: "master", provider: "openai" } };
    await capturedHandler("< Back", 3, { tier: "master", provider: "openai" });

    expect(activeWizard).toEqual({
      type: "model",
      step: 2,
      data: { tier: "master", provider: "openai" },
    });
    expect(wizardOptions).toContain("< Back");
  });

  it("should go back from step 15 (model select) to step 3 (profile select)", async () => {
    let capturedHandler: any = null;
    const TestComponent = () => {
      capturedHandler = useModelWizard(mockCtx as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    // Simulate step 15 active
    activeWizard = { type: "model", step: 15, data: { tier: "master", providerType: "openai" } };
    await capturedHandler("< Back", 15, { tier: "master", providerType: "openai" });

    expect(activeWizard).toEqual({
      type: "model",
      step: 3,
      data: { tier: "master", providerType: "openai" },
    });
    expect(wizardOptions).toContain("< Back");
    unmount();
  });

  it("should go back using Escape key on step 50", async () => {
    const mockSubmit = vi.fn();
    const TestComponent = () => {
      useKeyboardHandler({
        activeWizard: { type: "model", step: 50, data: {} },
        setActiveWizard: (w: any) => { activeWizard = w; },
        setWizardOptions: (opts: string[]) => { wizardOptions = opts; },
        setWizardSelectedIndex: (idx: number) => { wizardSelectedIndex = idx; },
        wizardOptions: ["Master", "Superagent", "Subagent", "Researcher", "Coder", "Reviewer", "Default", "All", "< Back"],
        wizardSelectedIndex: 8,
        setInput: mockCtx.setInput,
        addLine: mockCtx.addLine,
        focusedResponseIndex: null,
        focusMode: "input",
        scrollOffset: 0,
        focusedResponseOffset: 0,
        handleWizardSubmit: mockSubmit,
        input: "",
        isPasted: false,
        pastePrefixLength: 0,
        pasteSuffixLength: 0,
      } as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    expect(inputCallbacks.length).toBeGreaterThan(0);

    // Trigger Escape keypress
    for (const cb of inputCallbacks) {
      cb("escape", { upArrow: false, downArrow: false, return: false, escape: true, tab: false } as any);
    }

    expect(mockSubmit).toHaveBeenCalledWith("back");
    unmount();
  });

  it("should go back using Escape key on step 2", async () => {
    const mockSubmit = vi.fn();
    const TestComponent = () => {
      useKeyboardHandler({
        activeWizard: { type: "model", step: 2, data: {} },
        setActiveWizard: (w: any) => { activeWizard = w; },
        setWizardOptions: (opts: string[]) => { wizardOptions = opts; },
        setWizardSelectedIndex: (idx: number) => { wizardSelectedIndex = idx; },
        wizardOptions: ["OpenRouter", "< Back"],
        wizardSelectedIndex: 0,
        setInput: mockCtx.setInput,
        addLine: mockCtx.addLine,
        focusedResponseIndex: null,
        focusMode: "input",
        scrollOffset: 0,
        focusedResponseOffset: 0,
        handleWizardSubmit: mockSubmit,
        input: "",
        isPasted: false,
        pastePrefixLength: 0,
        pasteSuffixLength: 0,
      } as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    expect(inputCallbacks.length).toBeGreaterThan(0);

    // Trigger Escape keypress
    for (const cb of inputCallbacks) {
      cb("escape", { upArrow: false, downArrow: false, return: false, escape: true, tab: false } as any);
    }

    expect(mockSubmit).toHaveBeenCalledWith("< Back");
    unmount();
  });

  it("should cancel/close the wizard when Escape is pressed on step 1", async () => {
    const mockSubmit = vi.fn();
    const TestComponent = () => {
      useKeyboardHandler({
        activeWizard: { type: "model", step: 1, data: {} },
        setActiveWizard: (w: any) => { activeWizard = w; },
        setWizardOptions: (opts: string[]) => { wizardOptions = opts; },
        setWizardSelectedIndex: (idx: number) => { wizardSelectedIndex = idx; },
        wizardOptions: ["Create", "< Back"],
        wizardSelectedIndex: 0,
        setInput: mockCtx.setInput,
        addLine: mockCtx.addLine,
        focusedResponseIndex: null,
        focusMode: "input",
        scrollOffset: 0,
        focusedResponseOffset: 0,
        handleWizardSubmit: mockSubmit,
        setCheckpointsList: () => {},
        input: "",
        isPasted: false,
        pastePrefixLength: 0,
        pasteSuffixLength: 0,
      } as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    expect(inputCallbacks.length).toBeGreaterThan(0);

    // Trigger Escape keypress
    for (const cb of inputCallbacks) {
      cb("escape", { upArrow: false, downArrow: false, return: false, escape: true, tab: false } as any);
    }

    expect(mockSubmit).not.toHaveBeenCalled();
    expect(activeWizard).toBeNull();
    unmount();
  });

  it("should clear master agent model override when 'Not Set' is selected on step 2", async () => {
    let capturedHandler: any = null;
    const TestComponent = () => {
      capturedHandler = useModelWizard(mockCtx as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    // Simulate step 2 active with tier=master and existing preset models
    activeWizard = { type: "model", step: 2, data: { tier: "master", presetModels: JSON.stringify({ MODEL_MULTI_MASTER: "openrouter:google/gemini-2.5-flash", MODEL: "test-model" }) } };
    await capturedHandler("6. Not Set (Clear Override)", 2, { tier: "master", presetModels: JSON.stringify({ MODEL_MULTI_MASTER: "openrouter:google/gemini-2.5-flash", MODEL: "test-model" }) });

    // Should close wizard
    expect(activeWizard).toBeNull();
    expect(wizardOptions).toEqual([]);

    // Should have logged a system message
    expect(addedLines.some(l => l.content.includes("Master Agent (depth 0) model override cleared"))).toBe(true);

    unmount();
  });

  it("should clear all tier model overrides when 'Not Set' is selected with tier=all on step 2", async () => {
    const presetModels = {
      MODEL_MULTI_MASTER: "m0",
      MODEL_MULTI_SUPERAGENT: "m1",
      MODEL_MULTI_SUBAGENT: "m2",
      MODEL_MULTI_SUBAGENT_RESEARCHER: "mr",
      MODEL_MULTI_SUBAGENT_CODER: "mc",
      MODEL_MULTI_SUBAGENT_REVIEWER: "mv",
      MODEL: "fallback-model",
    };

    let capturedHandler: any = null;
    const TestComponent = () => {
      capturedHandler = useModelWizard(mockCtx as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    activeWizard = { type: "model", step: 2, data: { tier: "all", presetModels: JSON.stringify(presetModels) } };
    await capturedHandler("6. Not Set (Clear Override)", 2, { tier: "all", presetModels: JSON.stringify(presetModels) });

    expect(activeWizard).toBeNull();
    expect(addedLines.some(l => l.content.includes("All Tiers model override cleared"))).toBe(true);

    unmount();
  });

  it("should delete preset model keys when 'Not Set' is selected on step 23 (preset)", async () => {
    const presetModels = {
      MODEL_MULTI_MASTER: "openrouter:google/gemini-2.5-flash",
      MODEL_MULTI_SUPERAGENT: "openrouter:meta/llama-3",
    };

    let capturedHandler: any = null;
    const TestComponent = () => {
      capturedHandler = useModelWizard(mockCtx as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    activeWizard = {
      type: "model",
      step: 23,
      data: { tier: "master", presetModels: JSON.stringify(presetModels), presetName: "test" },
    };
    await capturedHandler("6. Not Set (Clear Override)", 23, activeWizard.data);

    // Should navigate back to step 22 (tier selection for preset)
    expect(activeWizard).not.toBeNull();
    expect(activeWizard.step).toBe(22);

    // The master tier keys should be deleted from presetModels
    const updatedModels = JSON.parse(activeWizard.data.presetModels);
    expect(updatedModels.MODEL_MULTI_MASTER).toBeUndefined();

    // Superagent keys should be preserved
    expect(updatedModels.MODEL_MULTI_SUPERAGENT).toBe("openrouter:meta/llama-3");

    // Options should show (not set) for master but still show model for superagent
    expect(wizardOptions.some(o => o.includes("Master Agent") && o.includes("(not set)"))).toBe(true);
    expect(wizardOptions.some(o => o.includes("Superagent") && o.includes("openrouter:meta/llama-3"))).toBe(true);

    unmount();
  });

  it("should include 'Not Set (Clear Override)' in step 2 options", async () => {
    let capturedHandler: any = null;
    const TestComponent = () => {
      capturedHandler = useModelWizard(mockCtx as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    // Simulate selecting a tier (master) on step 50, which transitions to step 2
    activeWizard = { type: "model", step: 50, data: {} };
    await capturedHandler("1. Master Agent (depth 0) ((not set))", 50, {});

    // Step 2 should now be active
    expect(activeWizard.step).toBe(2);
    expect(wizardOptions).toContain("6. Not Set (Clear Override)");
    expect(wizardOptions).toContain("< Back");

    unmount();
  });

  it("should exclude 'Master Agent' from step 50 options in single-agent mode", async () => {
    mockCtx.agentRef.current.isMultiAgent = false;
    let capturedHandler: any = null;
    const TestComponent = () => {
      capturedHandler = useModelWizard(mockCtx as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    // Simulate going back to step 50 from step 2
    activeWizard = { type: "model", step: 2, data: { tier: "superagent" } };
    await capturedHandler("< Back", 2, { tier: "superagent" });

    expect(activeWizard.step).toBe(50);
    expect(wizardOptions.some(opt => opt.includes("Master Agent"))).toBe(false);
    expect(wizardOptions.some(opt => opt.includes("Superagent"))).toBe(true);

    unmount();
  });
});

