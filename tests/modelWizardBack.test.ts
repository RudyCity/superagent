import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render } from "ink";
import { Console } from "node:console";
import { handleSlashCommand, type ChatLine } from "../src/core/slash-commands.js";
import { useModelWizard } from "../src/hooks/wizard/useModelWizard.js";
import { useKeyboardHandler } from "../src/hooks/useKeyboardHandler.js";

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
  });

  afterEach(() => {
    process.env = originalEnv;
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
    expect(wizardOptions).toContain("6. Configure Agent Tier Models");
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
        wizardOptions: ["Master", "Superagent", "Subagent", "Researcher", "Coder", "Reviewer", "Default", "All", "< Back"],
        wizardSelectedIndex: 8,
        setInput: mockCtx.setInput,
        addLine: mockCtx.addLine,
        focusedResponseIndex: null,
        focusMode: "input",
        scrollOffset: 0,
        focusedResponseOffset: 0,
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
    expect(wizardOptions).toContain("6. Configure Agent Tier Models");
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
});
