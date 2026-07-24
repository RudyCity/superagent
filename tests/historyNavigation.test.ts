import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as reactModule from "react";
import * as inkModule from "ink";
import * as configModule from "../src/core/config.js";
import * as slashCommandsModule from "../src/core/slash-commands.js";

let inputCallbacks: any[] = [];

import { useKeyboardHandler } from "../src/hooks/useKeyboardHandler.js";
import { useDashboardKeyboard } from "../src/hooks/useDashboardKeyboard.js";

describe("History Up/Down Navigation", () => {
  beforeEach(() => {
    inputCallbacks = [];
    vi.restoreAllMocks();
    vi.spyOn(reactModule, "useRef").mockImplementation((val: any) => ({ current: val }));
    vi.spyOn(reactModule, "useCallback").mockImplementation((fn: any) => fn);
    vi.spyOn(reactModule.default, "useRef").mockImplementation((val: any) => ({ current: val }));
    vi.spyOn(reactModule.default, "useCallback").mockImplementation((fn: any) => fn);

    vi.spyOn(inkModule, "useApp").mockReturnValue({ exit: vi.fn() });
    vi.spyOn(inkModule, "useInput").mockImplementation((cb: any) => {
      inputCallbacks.push(cb);
    });

    vi.spyOn(configModule, "getSettings").mockReturnValue({
      maxChecklistVisible: 3,
      maxProcsVisible: 3,
    } as any);
    vi.spyOn(configModule, "getConfiguredProviders").mockReturnValue([]);
    vi.spyOn(configModule, "switchActiveProvider").mockImplementation(async () => {});
    vi.spyOn(configModule, "fetchAndCacheModels").mockImplementation(async () => {});
    vi.spyOn(configModule, "getContextWindowLimit").mockReturnValue(200000);
    vi.spyOn(configModule, "listHistorySessions").mockReturnValue([]);
    vi.spyOn(configModule, "getModelPresets").mockReturnValue([]);
    vi.spyOn(configModule, "getInstalledSkills").mockReturnValue([]);
    vi.spyOn(configModule, "getProviderOptionsList").mockReturnValue([]);
    vi.spyOn(slashCommandsModule, "getDefaultModel").mockReturnValue("test-model");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Single Agent (useKeyboardHandler)", () => {
    function createCtx(overrides: any = {}) {
      return {
        input: "",
        setInput: vi.fn(),
        isProcessing: false,
        history: ["first input", "second input", "third input"],
        setHistory: vi.fn(),
        historyIndex: -1,
        setHistoryIndex: vi.fn(),
        tempInput: "",
        setTempInput: vi.fn(),
        focusMode: "input",
        setFocusMode: vi.fn(),
        focusedResponseIndex: null,
        setFocusedResponseIndex: vi.fn(),
        activeWizard: null,
        setActiveWizard: vi.fn(),
        wizardOptions: [],
        setWizardOptions: vi.fn(),
        wizardSelectedIndex: 0,
        setWizardSelectedIndex: vi.fn(),
        wizardSelectedSet: new Set(),
        setWizardSelectedSet: vi.fn(),
        lines: [],
        setLines: vi.fn(),
        addLine: vi.fn(),
        scrollOffset: 0,
        setScrollOffset: vi.fn(),
        scrollChat: vi.fn(),
        commands: [],
        suggestions: [],
        lastTabPrefix: null,
        setLastTabPrefix: vi.fn(),
        setIsPasted: vi.fn(),
        isPasted: false,
        pastePrefixLength: 0,
        pasteSuffixLength: 0,
        agentRef: { current: null },
        exit: vi.fn(),
        handleSubmit: vi.fn(),
        handleSlashCommand: vi.fn(),
        expandCursorRef: { current: 0 },
        visibleLinePositions: [],
        toggleLineExpand: vi.fn(),
        toggleChildExpand: vi.fn(),
        ...overrides,
      };
    }

    it("should navigate to last history item on up arrow", () => {
      const ctx = createCtx();
      useKeyboardHandler(ctx as any);

      expect(inputCallbacks.length).toBeGreaterThan(0);
      const cb = inputCallbacks[0];

      // Simulate up arrow press
      cb("", { upArrow: true });

      // Should set history index to last item (index 2)
      expect(ctx.setHistoryIndex).toHaveBeenCalledWith(2);
      // Should set input to last history item
      expect(ctx.setInput).toHaveBeenCalledWith("third input");
    });

    it("should navigate to previous history item on subsequent up arrow", () => {
      const ctx = createCtx({
        historyIndex: 2,
      });
      useKeyboardHandler(ctx as any);

      const cb = inputCallbacks[0];
      cb("", { upArrow: true });

      expect(ctx.setHistoryIndex).toHaveBeenCalledWith(1);
      expect(ctx.setInput).toHaveBeenCalledWith("second input");
    });

    it("should not go before first history item on up arrow", () => {
      const ctx = createCtx({
        historyIndex: 0,
      });
      useKeyboardHandler(ctx as any);

      const cb = inputCallbacks[0];
      cb("", { upArrow: true });

      // historyIndex stays at 0 (no change)
      expect(ctx.setHistoryIndex).toHaveBeenCalledWith(0);
      expect(ctx.setInput).toHaveBeenCalledWith("first input");
    });

    it("should navigate to next history item on down arrow", () => {
      const ctx = createCtx({
        historyIndex: 1,
      });
      useKeyboardHandler(ctx as any);

      const cb = inputCallbacks[0];
      cb("", { downArrow: true });

      expect(ctx.setHistoryIndex).toHaveBeenCalledWith(2);
      expect(ctx.setInput).toHaveBeenCalledWith("third input");
    });

    it("should restore temp input when down arrow at last history item", () => {
      const ctx = createCtx({
        historyIndex: 2,
        tempInput: "my draft",
      });
      useKeyboardHandler(ctx as any);

      const cb = inputCallbacks[0];
      cb("", { downArrow: true });

      expect(ctx.setHistoryIndex).toHaveBeenCalledWith(-1);
      expect(ctx.setInput).toHaveBeenCalledWith("my draft");
    });

    it("should NOT navigate history when isProcessing is true", () => {
      const ctx = createCtx({
        isProcessing: true,
      });
      useKeyboardHandler(ctx as any);

      const cb = inputCallbacks[0];
      cb("", { upArrow: true });

      expect(ctx.setHistoryIndex).not.toHaveBeenCalled();
      expect(ctx.setInput).not.toHaveBeenCalled();
    });

    it("should NOT navigate history when history is empty", () => {
      const ctx = createCtx({
        history: [],
      });
      useKeyboardHandler(ctx as any);

      const cb = inputCallbacks[0];
      cb("", { upArrow: true });

      expect(ctx.setHistoryIndex).not.toHaveBeenCalled();
    });

    it("should save current input to tempInput before navigating history", () => {
      const ctx = createCtx({
        input: "my current text",
        historyIndex: -1,
      });
      useKeyboardHandler(ctx as any);

      const cb = inputCallbacks[0];
      cb("", { upArrow: true });

      expect(ctx.setTempInput).toHaveBeenCalledWith("my current text");
    });
  });

  describe("Multi Agent (useDashboardKeyboard)", () => {
    function createDashboardCtx(overrides: any = {}) {
      return {
        query: "",
        setQuery: vi.fn(),
        focusArea: "input",
        setFocusArea: vi.fn(),
        history: ["first input", "second input", "third input"],
        historyIndex: -1,
        setHistoryIndex: vi.fn(),
        tempInput: "",
        setTempInput: vi.fn(),
        isProcessing: false,
        activeWizard: null,
        setActiveWizard: vi.fn(),
        wizardOptions: [],
        setWizardOptions: vi.fn(),
        wizardSelectedIndex: 0,
        setWizardSelectedIndex: vi.fn(),
        wizardSelectedSet: new Set(),
        setWizardSelectedSet: vi.fn(),
        wizardAllOptions: [],
        setWizardAllOptions: vi.fn(),
        setWizardIsLoadingModels: vi.fn(),
        isPasted: false,
        setIsPasted: vi.fn(),
        pastePrefixLength: 0,
        pasteSuffixLength: 0,
        exit: vi.fn(),
        stopAllRunningAgents: () => 0,
        setCurrentTask: vi.fn(),
        setIsHistoryTruncated: vi.fn(),
        handleQuerySubmit: vi.fn(),
        setLogScrollOffset: vi.fn(),
        pendingQuestion: null,
        setPendingQuestion: vi.fn(),
        suggestions: [],
        planState: "",
        checklistTasks: [],
        runningSubagentsCount: 0,
        runningTasksCount: 0,
        setSelectedIndex: vi.fn(),
        sessions: [],
        selectedIndex: 0,
        wrappedLines: [],
        logsCount: 0,
        setChecklistScrollOffset: vi.fn(),
        maxChecklistVisible: 5,
        setAgentsScrollOffset: vi.fn(),
        maxAgentsVisible: 5,
        setProcsScrollOffset: vi.fn(),
        maxProcsVisible: 5,
        lastTabPrefix: null,
        setLastTabPrefix: vi.fn(),
        expandCursorRef: { current: 0 },
        groupBoundaries: [],
        toggleGroupCollapse: vi.fn(),
        ...overrides,
      };
    }

    it("should navigate to last history item on up arrow", () => {
      const ctx = createDashboardCtx();
      useDashboardKeyboard(ctx as any);

      expect(inputCallbacks.length).toBeGreaterThan(0);
      const cb = inputCallbacks[0];

      cb("", { upArrow: true });

      expect(ctx.setHistoryIndex).toHaveBeenCalledWith(2);
      expect(ctx.setQuery).toHaveBeenCalledWith("third input");
    });

    it("should navigate to previous history item on subsequent up arrow", () => {
      const ctx = createDashboardCtx({
        historyIndex: 2,
      });
      useDashboardKeyboard(ctx as any);

      const cb = inputCallbacks[0];
      cb("", { upArrow: true });

      expect(ctx.setHistoryIndex).toHaveBeenCalledWith(1);
      expect(ctx.setQuery).toHaveBeenCalledWith("second input");
    });

    it("should navigate to next history item on down arrow", () => {
      const ctx = createDashboardCtx({
        historyIndex: 1,
      });
      useDashboardKeyboard(ctx as any);

      const cb = inputCallbacks[0];
      cb("", { downArrow: true });

      expect(ctx.setHistoryIndex).toHaveBeenCalledWith(2);
      expect(ctx.setQuery).toHaveBeenCalledWith("third input");
    });

    it("should restore temp input when down arrow at last history item", () => {
      const ctx = createDashboardCtx({
        historyIndex: 2,
        tempInput: "my draft",
      });
      useDashboardKeyboard(ctx as any);

      const cb = inputCallbacks[0];
      cb("", { downArrow: true });

      expect(ctx.setHistoryIndex).toHaveBeenCalledWith(-1);
      expect(ctx.setQuery).toHaveBeenCalledWith("my draft");
    });

    it("should NOT navigate history when focusArea is not input", () => {
      const ctx = createDashboardCtx({
        focusArea: "logs",
      });
      useDashboardKeyboard(ctx as any);

      const cb = inputCallbacks[0];
      cb("", { upArrow: true });

      expect(ctx.setHistoryIndex).not.toHaveBeenCalled();
      expect(ctx.setQuery).not.toHaveBeenCalled();
    });
  });
});
