import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";

vi.mock("react", async (importOriginal) => {
  const original = await importOriginal<typeof import("react")>();
  const mocked = {
    ...original,
    useRef: (val: any) => ({ current: val }),
    useCallback: (fn: any) => fn,
  };
  return {
    ...mocked,
    default: mocked,
  };
});

import { getDashboardSuggestions } from "../src/utils/dashboardSuggestions.js";
import { useKeyboardHandler } from "../src/hooks/useKeyboardHandler.js";
import { useDashboardKeyboard } from "../src/hooks/useDashboardKeyboard.js";
import { registry } from "../src/core/commands/registry.js";
import { terminalCommand } from "../src/core/commands/terminalCommand.js";

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

describe("Bang (!) Shortcut Suggestions and Tab Completion", () => {
  beforeEach(() => {
    inputCallbacks = [];
    vi.clearAllMocks();
    if (!registry.get("terminal")) {
      registry.register(terminalCommand);
    }
  });

  it("should return mapped suggestions for query starting with bang", () => {
    // ! -> should map internally to /terminal and suggest !init, !bg, etc.
    const suggestions = getDashboardSuggestions("!");
    expect(suggestions).toContain("!init");
    expect(suggestions).toContain("!bg");
    expect(suggestions).toContain("!all");
    expect(suggestions).toContain("!preset");

    // !bg -> should suggest !bg preset
    const suggestionsBg = getDashboardSuggestions("!bg");
    expect(suggestionsBg).toContain("!bg preset");
  });

  it("should trigger tab completion in useKeyboardHandler when input starts with bang", () => {
    const setInputMock = vi.fn();
    const setLastTabPrefixMock = vi.fn();
    const suggestions = ["!init", "!bg"];

    useKeyboardHandler({
      input: "!",
      setInput: setInputMock,
      lastTabPrefix: null,
      setLastTabPrefix: setLastTabPrefixMock,
      suggestions,
      commands: ["!init", "!bg"],
      isProcessing: false,
    } as any);

    expect(inputCallbacks.length).toBeGreaterThan(0);
    const cb = inputCallbacks[0];
    cb("", { tab: true });

    expect(setLastTabPrefixMock).toHaveBeenCalledWith("!");
    expect(setInputMock).toHaveBeenCalledWith("!init");
  });

  it("should trigger tab completion in useDashboardKeyboard when query starts with bang", () => {
    const setQueryMock = vi.fn();
    const setLastTabPrefixMock = vi.fn();
    const suggestions = ["!init", "!bg"];

    useDashboardKeyboard({
      query: "!",
      setQuery: setQueryMock,
      lastTabPrefix: null,
      setLastTabPrefix: setLastTabPrefixMock,
      suggestions,
      focusArea: "input",
      isProcessing: false,
      setIsPasted: vi.fn(),
    } as any);

    expect(inputCallbacks.length).toBeGreaterThan(0);
    const cb = inputCallbacks[0];
    cb("", { tab: true });

    expect(setLastTabPrefixMock).toHaveBeenCalledWith("!");
    expect(setQueryMock).toHaveBeenCalledWith("!init");
  });
});
