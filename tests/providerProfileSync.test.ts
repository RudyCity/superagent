import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import * as reactModule from "react";
import * as inkModule from "ink";

const tempHome = path.join(process.cwd(), "tests", "temp-home-provider-sync");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { handleSlashCommand, type ChatLine } from "../src/core/slash-commands.js";
import { useLoginWizard } from "../src/hooks/wizard/useLoginWizard.js";
import { useModelWizard } from "../src/hooks/wizard/useModelWizard.js";
import { ensureGlobalConfigDir } from "../src/core/config/paths.js";
import { clearModelConfigCache, getProviders, addProvider, removeProvider } from "../src/core/config/jsonConfig.js";
import { getConfiguredProviders, formatProviderForPicker } from "../src/core/config/providers.js";

describe("Provider Profile Sync Between /login and /model", () => {
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
    vi.restoreAllMocks();
    vi.spyOn(inkModule, "useApp").mockReturnValue({ exit: vi.fn() });
    vi.spyOn(inkModule, "useInput").mockImplementation(vi.fn());
    vi.spyOn(reactModule, "useRef").mockImplementation((val: any) => ({ current: val }));
    vi.spyOn(reactModule, "useCallback").mockImplementation((fn: any) => fn);
    vi.spyOn(reactModule, "useState").mockImplementation((initial: any) => [initial, vi.fn()]);
    vi.spyOn(reactModule, "useEffect").mockImplementation(vi.fn());
    vi.spyOn(reactModule, "createElement").mockImplementation(vi.fn());

    vi.spyOn(reactModule.default, "useRef").mockImplementation((val: any) => ({ current: val }));
    vi.spyOn(reactModule.default, "useCallback").mockImplementation((fn: any) => fn);
    vi.spyOn(reactModule.default, "useState").mockImplementation((initial: any) => [initial, vi.fn()]);
    vi.spyOn(reactModule.default, "useEffect").mockImplementation(vi.fn());
    vi.spyOn(reactModule.default, "createElement").mockImplementation(vi.fn());

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

    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    ensureGlobalConfigDir();
    clearModelConfigCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    clearModelConfigCache();
  });

  it("should show empty-key custom provider in /login delete list and allow deleting it", async () => {
    // Add a custom profile with empty API key (e.g. huggingfae)
    addProvider({
      id: "huggingfae",
      name: "huggingfae",
      provider: "custom",
      apiKey: "",
      baseUrl: "https://api-inference.huggingface.co/v1",
    });

    // Add another custom profile with a valid API key
    addProvider({
      id: "lmstudio",
      name: "lmstudio",
      provider: "custom",
      apiKey: "sk-lm-12345",
      baseUrl: "http://localhost:1234/v1",
    });

    const loginHandler = useLoginWizard(mockCtx as any);

    // 1. Go to /login Delete menu (Step 1 -> option 3)
    await loginHandler("3. Delete / Remove a Provider", 1, {});

    expect(activeWizard.step).toBe(14);
    // Both profiles MUST be present in delete options
    expect(wizardOptions.some(opt => opt.includes("huggingfae"))).toBe(true);
    expect(wizardOptions.some(opt => opt.includes("lmstudio"))).toBe(true);

    // 2. Select huggingfae to delete
    const huggingIndex = wizardOptions.findIndex(opt => opt.includes("huggingfae")) + 1;
    await loginHandler(String(huggingIndex), 14, {});

    expect(activeWizard.step).toBe(15);
    expect(activeWizard.data.providerId).toBe("huggingfae");

    // 3. Confirm deletion
    await loginHandler("1. Yes, Delete Provider", 15, activeWizard.data);

    // After deletion, huggingfae must be gone from getProviders and getConfiguredProviders
    const remainingProviders = getConfiguredProviders();
    expect(remainingProviders.some(p => p.id === "huggingfae")).toBe(false);
    expect(remainingProviders.some(p => p.id === "lmstudio")).toBe(true);
  });

  it("should synchronize profile options between /login and /model preset creation", async () => {
    addProvider({
      id: "custom-a",
      name: "custom-a",
      provider: "custom",
      apiKey: "sk-aaa",
      baseUrl: "https://custom-a.org/v1",
    });
    addProvider({
      id: "custom-b",
      name: "custom-b",
      provider: "custom",
      apiKey: "",
      baseUrl: "http://localhost:8080/v1",
    });

    const loginList = getConfiguredProviders().filter(p => p.type === "custom");
    expect(loginList.length).toBe(2);
    expect(loginList.map(p => p.name)).toContain("custom-a");
    expect(loginList.map(p => p.name)).toContain("custom-b");

    const modelHandler = useModelWizard(mockCtx as any);

    // In /model wizard: check getProfilePickerOptions
    // Trigger /model -> Create preset flow
    activeWizard = {
      type: "model",
      step: 23,
      data: {
        isPreset: "true",
        presetMode: "multi",
        presetName: "test-sync",
        tier: "master",
      }
    };

    // Submit provider selection for "4. Custom OpenAI Endpoint"
    await modelHandler("4. Custom OpenAI Endpoint", 23, activeWizard.data);

    expect(activeWizard.step).toBe(25);
    // Profile picker options must include custom-a and custom-b
    expect(wizardOptions.some(opt => opt.includes("custom-a"))).toBe(true);
    expect(wizardOptions.some(opt => opt.includes("custom-b"))).toBe(true);

    // Delete custom-b using login handler
    const loginHandler = useLoginWizard(mockCtx as any);
    await loginHandler("1. Yes, Delete Provider", 15, {
      providerId: "custom-b",
      providerName: "custom-b",
    });

    // Re-check profile options in /model after deletion
    activeWizard = {
      type: "model",
      step: 23,
      data: {
        isPreset: "true",
        presetMode: "multi",
        presetName: "test-sync",
        tier: "master",
      }
    };
    await modelHandler("4. Custom OpenAI Endpoint", 23, activeWizard.data);

    expect(wizardOptions.some(opt => opt.includes("custom-a"))).toBe(true);
    expect(wizardOptions.some(opt => opt.includes("custom-b"))).toBe(false);
  });
});
