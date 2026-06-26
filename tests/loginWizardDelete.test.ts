import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render } from "ink";
import { Console } from "node:console";
import fs from "fs";
import path from "path";
import os from "os";

const tempHome = path.join(process.cwd(), "tests", "temp-home-login-delete");

import { handleSlashCommand, type ChatLine } from "../src/core/slash-commands.js";
import { useLoginWizard } from "../src/hooks/wizard/useLoginWizard.js";
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

describe("Login Wizard Provider Deletion", () => {
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
    process.env.SUPERAGENT_CONFIG_DIR = tempHome;
    addedLines = [];
    activeWizard = null;
    wizardOptions = [];
    wizardSelectedIndex = 0;
    currentInput = "";
    contextLimit = 0;
    activeModel = "";
    isLoadingModels = false;
    inputCallbacks = [];

    // Clean temp folder
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    ensureGlobalConfigDir();
    clearModelConfigCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    // Clean temp folder
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    clearModelConfigCache();
  });

  it("should show Delete / Remove a Provider option in step 1 of login wizard", async () => {
    handleSlashCommand("/login", mockCtx as any);

    expect(activeWizard).toEqual({
      type: "login",
      step: 1,
      data: {},
    });
    expect(wizardOptions).toContain("3. Delete / Remove a Provider");
  });

  it("should transition to step 14 when Delete / Remove a Provider is chosen and providers exist", async () => {
    // Configure a provider profile first
    addProvider({
      id: "openai-test",
      name: "OpenAI Test",
      provider: "openai",
      apiKey: "sk-test-key",
    });

    let capturedHandler: any = null;
    const TestComponent = () => {
      capturedHandler = useLoginWizard(mockCtx as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    // Submit option 3 (Delete) in step 1
    await capturedHandler("3. Delete / Remove a Provider", 1, {});

    expect(activeWizard).toEqual({
      type: "login",
      step: 14,
      data: {},
    });
    expect(wizardOptions.some(opt => opt.includes("OpenAI Test"))).toBe(true);

    unmount();
  });

  it("should show error when Delete is chosen but no providers exist", async () => {
    let capturedHandler: any = null;
    const TestComponent = () => {
      capturedHandler = useLoginWizard(mockCtx as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    await capturedHandler("3. Delete / Remove a Provider", 1, {});

    expect(activeWizard).toBeNull();
    expect(addedLines.some(line => line.content.includes("No providers configured yet"))).toBe(true);

    unmount();
  });

  it("should transition to step 15 for delete confirmation when a provider is selected in step 14", async () => {
    addProvider({
      id: "openai-test",
      name: "OpenAI Test",
      provider: "openai",
      apiKey: "sk-test-key",
    });

    let capturedHandler: any = null;
    const TestComponent = () => {
      capturedHandler = useLoginWizard(mockCtx as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    // Simulate step 14 selection (selecting the first provider: index 1)
    await capturedHandler("1", 14, {});

    expect(activeWizard).toEqual({
      type: "login",
      step: 15,
      data: {
        providerId: "openai-test",
        providerName: "OpenAI Test",
      },
    });
    expect(wizardOptions).toContain("1. Yes, Delete Provider");
    expect(wizardOptions).toContain("2. No (Cancel)");

    unmount();
  });

  it("should delete the provider and exit wizard on confirming in step 15", async () => {
    addProvider({
      id: "openai-test",
      name: "OpenAI Test",
      provider: "openai",
      apiKey: "sk-test-key",
    });

    // Default config has 2 default providers. Adding one makes 3.
    expect(getProviders()).toHaveLength(3);

    let capturedHandler: any = null;
    const TestComponent = () => {
      capturedHandler = useLoginWizard(mockCtx as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    // Confirm deletion
    await capturedHandler("1. Yes, Delete Provider", 15, {
      providerId: "openai-test",
      providerName: "OpenAI Test",
    });

    expect(activeWizard).toBeNull();
    expect(getProviders()).toHaveLength(2);
    expect(addedLines.some(line => line.content.includes("Successfully removed provider: OpenAI Test (openai-test)"))).toBe(true);

    unmount();
  });

  it("should cancel deletion and exit wizard on declining in step 15", async () => {
    addProvider({
      id: "openai-test",
      name: "OpenAI Test",
      provider: "openai",
      apiKey: "sk-test-key",
    });

    expect(getProviders()).toHaveLength(3);

    let capturedHandler: any = null;
    const TestComponent = () => {
      capturedHandler = useLoginWizard(mockCtx as any);
      return null;
    };
    const { unmount } = render(React.createElement(TestComponent));

    // Cancel deletion
    await capturedHandler("2. No (Cancel)", 15, {
      providerId: "openai-test",
      providerName: "OpenAI Test",
    });

    expect(activeWizard).toBeNull();
    expect(getProviders()).toHaveLength(3);
    expect(addedLines.some(line => line.content.includes("Deletion cancelled"))).toBe(true);

    unmount();
  });

  it("should support keyboard navigation going back from step 14 to step 1", async () => {
    const mockSubmit = vi.fn();
    const TestComponent = () => {
      useKeyboardHandler({
        activeWizard: { type: "login", step: 14, data: {} },
        setActiveWizard: (w: any) => { activeWizard = w; },
        setWizardOptions: (opts: string[]) => { wizardOptions = opts; },
        setWizardSelectedIndex: (idx: number) => { wizardSelectedIndex = idx; },
        wizardOptions: ["1. OpenAI Test [openai]"],
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

    // Trigger Escape keypress to go back
    for (const cb of inputCallbacks) {
      cb("escape", { upArrow: false, downArrow: false, return: false, escape: true, tab: false } as any);
    }

    expect(activeWizard).toEqual({
      type: "login",
      step: 1,
      data: {},
    });
    expect(wizardOptions).toContain("3. Delete / Remove a Provider");
    unmount();
  });

  it("should support keyboard navigation going back from step 15 to step 14", async () => {
    addProvider({
      id: "openai-test",
      name: "OpenAI Test",
      provider: "openai",
      apiKey: "sk-test-key",
    });

    const mockSubmit = vi.fn();
    const TestComponent = () => {
      useKeyboardHandler({
        activeWizard: { type: "login", step: 15, data: { providerId: "openai-test", providerName: "OpenAI Test" } },
        setActiveWizard: (w: any) => { activeWizard = w; },
        setWizardOptions: (opts: string[]) => { wizardOptions = opts; },
        setWizardSelectedIndex: (idx: number) => { wizardSelectedIndex = idx; },
        wizardOptions: ["1. Yes, Delete Provider", "2. No (Cancel)"],
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

    // Trigger Escape keypress to go back
    for (const cb of inputCallbacks) {
      cb("escape", { upArrow: false, downArrow: false, return: false, escape: true, tab: false } as any);
    }

    expect(activeWizard).toEqual({
      type: "login",
      step: 14,
      data: {},
    });
    expect(wizardOptions.some(opt => opt.includes("OpenAI Test"))).toBe(true);
    unmount();
  });
});
