import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import * as reactModule from "react";
import * as inkModule from "ink";

let inputCallbacks: any[] = [];

const tempHome = path.join(process.cwd(), "tests", "temp-home-login-edit");

import { handleSlashCommand, type ChatLine } from "../src/core/slash-commands.js";
import { useLoginWizard } from "../src/hooks/wizard/useLoginWizard.js";
import { useKeyboardHandler } from "../src/hooks/useKeyboardHandler.js";
import { ensureGlobalConfigDir } from "../src/core/config/paths.js";
import { clearModelConfigCache, getProviders, addProvider } from "../src/core/config/jsonConfig.js";

describe("Login Wizard Provider Edition", () => {
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
    vi.spyOn(inkModule, "useInput").mockImplementation((cb: any) => {
      inputCallbacks.push(cb);
    });
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
    inputCallbacks = [];

    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    ensureGlobalConfigDir();
    clearModelConfigCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    clearModelConfigCache();
  });

  it("should show Edit option in step 1 of login wizard", async () => {
    handleSlashCommand("/login", mockCtx as any);

    expect(activeWizard).toEqual({
      type: "login",
      step: 1,
      data: {},
    });
    expect(wizardOptions).toContain("4. Edit an Existing Provider");
  });

  it("should transition to step 17 when Edit is chosen and providers exist", async () => {
    addProvider({
      id: "openai-test",
      name: "OpenAI Test",
      provider: "openai",
      apiKey: "sk-test-key",
    });

    const capturedHandler = useLoginWizard(mockCtx as any);

    await capturedHandler("4. Edit an Existing Provider", 1, {});

    expect(activeWizard).toEqual({
      type: "login",
      step: 17,
      data: {},
    });
    expect(wizardOptions.some(opt => opt.includes("OpenAI Test"))).toBe(true);
  });

  it("should show error when Edit is chosen but no providers exist", async () => {
    const capturedHandler = useLoginWizard(mockCtx as any);

    await capturedHandler("4. Edit an Existing Provider", 1, {});

    expect(activeWizard).toBeNull();
    expect(addedLines.some(line => line.content.includes("No providers configured yet"))).toBe(true);
  });

  it("should transition to step 18 and ask for new API Key in step 17", async () => {
    addProvider({
      id: "openai-test",
      name: "OpenAI Test",
      provider: "openai",
      apiKey: "sk-test-key-12345678",
      baseUrl: "https://api.openai.com/v1",
    });

    const capturedHandler = useLoginWizard(mockCtx as any);

    await capturedHandler("1", 17, {});

    expect(activeWizard).toEqual({
      type: "login",
      step: 18,
      data: {
        providerId: "openai-test",
        providerName: "OpenAI Test",
        providerType: "openai",
        providerApiKey: "sk-test-key-12345678",
        providerBaseUrl: "https://api.openai.com/v1",
        isEdit: "true",
      },
    });
    expect(addedLines[addedLines.length - 1].content).toContain("Enter new API Key (or press Enter to keep current):");
  });

  it("should transition to step 19 and ask for new Base URL in step 18", async () => {
    const capturedHandler = useLoginWizard(mockCtx as any);

    await capturedHandler("sk-new-key", 18, {
      providerId: "openai-test",
      providerName: "OpenAI Test",
      providerType: "openai",
      providerApiKey: "sk-test-key",
      providerBaseUrl: "https://api.openai.com/v1",
    });

    expect(activeWizard).toEqual({
      type: "login",
      step: 19,
      data: {
        providerId: "openai-test",
        providerName: "OpenAI Test",
        providerType: "openai",
        providerApiKey: "sk-new-key",
        providerBaseUrl: "https://api.openai.com/v1",
      },
    });
    expect(addedLines[addedLines.length - 1].content).toContain("Enter new Base URL (or press Enter to keep current:");
  });

  it("should save changes and transition to step 7 on confirming in step 19", async () => {
    addProvider({
      id: "openai-test",
      name: "OpenAI Test",
      provider: "openai",
      apiKey: "sk-test-key",
      baseUrl: "https://api.openai.com/v1",
    });

    const capturedHandler = useLoginWizard(mockCtx as any);

    await capturedHandler("https://new.openai.com/v2", 19, {
      providerId: "openai-test",
      providerName: "OpenAI Test",
      providerType: "openai",
      providerApiKey: "sk-new-key",
      providerBaseUrl: "https://api.openai.com/v1",
    });

    expect(activeWizard).toEqual({
      type: "login",
      step: 7,
      data: {
        providerId: "openai-test",
        providerName: "OpenAI Test",
        providerType: "openai",
        providerApiKey: "sk-new-key",
        providerBaseUrl: "https://new.openai.com/v2",
        fromList: "false",
        isEdit: "true",
      },
    });
    expect(addedLines.some(line => line.content.includes("Successfully updated provider profile: OpenAI Test"))).toBe(true);

    const providers = getProviders();
    const updated = providers.find(p => p.id === "openai-test");
    expect(updated?.apiKey).toBe("sk-new-key");
    expect(updated?.baseUrl).toBe("https://new.openai.com/v2");
  });

  it("should support keyboard navigation from step 1 to step 17 when choosing Edit", async () => {
    addProvider({
      id: "openai-test",
      name: "OpenAI Test",
      provider: "openai",
      apiKey: "sk-test-key",
    });

    const mockSubmit = vi.fn();
    useKeyboardHandler({
      activeWizard: { type: "login", step: 1, data: {} },
      setActiveWizard: (w: any) => { activeWizard = w; },
      setWizardOptions: (opts: string[]) => { wizardOptions = opts; },
      setWizardSelectedIndex: (idx: number) => { wizardSelectedIndex = idx; },
      wizardOptions: ["1. List Configured Providers", "2. Create / Log in to a Provider", "3. Delete / Remove a Provider", "4. Edit an Existing Provider"],
      wizardSelectedIndex: 3,
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

    expect(inputCallbacks.length).toBeGreaterThan(0);

    for (const cb of inputCallbacks) {
      cb("\r", { upArrow: false, downArrow: false, return: true, escape: false, tab: false } as any);
    }

    expect(activeWizard).toEqual({
      type: "login",
      step: 17,
      data: {},
    });
    expect(wizardOptions.some(opt => opt.includes("OpenAI Test"))).toBe(true);
  });

  it("should support keyboard navigation going back from step 17 to step 1", async () => {
    const mockSubmit = vi.fn();
    useKeyboardHandler({
      activeWizard: { type: "login", step: 17, data: {} },
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

    expect(inputCallbacks.length).toBeGreaterThan(0);

    for (const cb of inputCallbacks) {
      cb("escape", { upArrow: false, downArrow: false, return: false, escape: true, tab: false } as any);
    }

    expect(activeWizard).toEqual({
      type: "login",
      step: 1,
      data: {},
    });
    expect(wizardOptions).toContain("4. Edit an Existing Provider");
  });
});
