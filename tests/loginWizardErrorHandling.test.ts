import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import * as reactModule from "react";
import * as inkModule from "ink";

const tempHome = path.join(process.cwd(), "tests", "temp-home-login-err");

import type { ChatLine } from "../src/core/slash-commands.js";
import { useLoginWizard } from "../src/hooks/wizard/useLoginWizard.js";
import { ensureGlobalConfigDir } from "../src/core/config/paths.js";
import { clearModelConfigCache } from "../src/core/config/jsonConfig.js";
import { closeHistoryDb } from "../src/core/storage/historyDb.js";
import * as loginWizardLogic from "../src/core/loginWizardLogic.js";

describe("Login Wizard Error Handling", () => {
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
    setIsProcessing: vi.fn(),
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

    try { closeHistoryDb(); } catch {}
    if (fs.existsSync(tempHome)) {
      try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
    }
    ensureGlobalConfigDir();
    clearModelConfigCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
    try { closeHistoryDb(); } catch {}
    if (fs.existsSync(tempHome)) {
      try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch {}
    }
    clearModelConfigCache();
  });

  it("should not crash and gracefully fall back when fetchModelsForProvider throws an authentication error in step 7", async () => {
    // Mock fetchModelsForProvider to throw 401 error like a rejected API key
    vi.spyOn(loginWizardLogic, "fetchModelsForProvider").mockRejectedValue(
      new Error("Authentication rejected by openai (HTTP 401) — the API key is invalid or revoked.")
    );

    const handleLoginWizard = useLoginWizard(mockCtx);

    // Step 7: user confirms connection test with invalid credentials
    const step7Data = {
      providerId: "test-openai",
      providerName: "test-openai",
      providerType: "openai",
      providerApiKey: "sk-invalid-key-12345",
      providerBaseUrl: "",
      fromList: "false",
    };

    // Calling handleLoginWizard should complete without throwing or rejecting
    await handleLoginWizard("1. Yes, Test Connection", 7, step7Data);

    // Verify loading spinner is turned off
    expect(isLoadingModels).toBe(false);

    // Verify wizard transitioned to step 8 with fallback models and cancel option
    expect(activeWizard).not.toBeNull();
    expect(activeWizard.step).toBe(8);
    expect(wizardOptions.length).toBeGreaterThan(0);
    expect(wizardOptions).toContain("+ Custom Model (Input manually)");
    expect(wizardOptions).toContain("❌ Cancel Setup");

    // Verify that warning or error line was reported to user
    const errorOrWarn = addedLines.find(l => l.content.includes("Connection failed") || l.content.includes("Could not fetch"));
    expect(errorOrWarn).toBeDefined();
  });

  it("should cleanly exit wizard when user chooses Cancel Setup in step 8", async () => {
    const handleLoginWizard = useLoginWizard(mockCtx);

    const step8Data = {
      providerId: "test-openai",
      providerName: "test-openai",
      providerType: "openai",
      providerApiKey: "sk-invalid-key-12345",
      providerBaseUrl: "",
      fromList: "false",
    };

    await handleLoginWizard("❌ Cancel Setup", 8, step8Data);

    expect(activeWizard).toBeNull();
    expect(wizardOptions).toEqual([]);
    expect(addedLines.some(l => l.content.includes("cancelled"))).toBe(true);
  });
});
