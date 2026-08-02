import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import * as inkModule from "ink";
import { Console } from "node:console";

if (!console.Console) {
  console.Console = Console;
}

import { getDashboardSuggestions } from "../src/utils/dashboardSuggestions.js";
import { useKeyboardHandler } from "../src/hooks/useKeyboardHandler.js";
import { useDashboardKeyboard } from "../src/hooks/useDashboardKeyboard.js";
import { registry } from "../src/core/commands/registry.js";
import { terminalCommand } from "../src/core/commands/terminalCommand.js";

describe("Bang (!) Shortcut Suggestions and Tab Completion", () => {
  let inputCallbacks: any[] = [];

  beforeEach(() => {
    inputCallbacks = [];
    vi.restoreAllMocks();

    vi.spyOn(inkModule, "useApp").mockReturnValue({ exit: vi.fn() });
    vi.spyOn(inkModule, "useInput").mockImplementation((cb: any) => {
      inputCallbacks.push(cb);
    });

    if (!registry.get("terminal")) {
      registry.register(terminalCommand);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return mapped suggestions for query starting with bang", () => {
    const suggestions = getDashboardSuggestions("!");
    expect(suggestions).toContain("!init");
    expect(suggestions).toContain("!bg");
    expect(suggestions).toContain("!all");
    expect(suggestions).toContain("!preset");

    const suggestionsBg = getDashboardSuggestions("!bg");
    expect(suggestionsBg).toContain("!bg preset");
  });

  it("should trigger tab completion in useKeyboardHandler when input starts with bang", () => {
    const setInputMock = vi.fn();
    const setLastTabPrefixMock = vi.fn();
    const suggestions = ["!init", "!bg"];

    const TestComponent = () => {
      useKeyboardHandler({
        input: "!",
        setInput: setInputMock,
        lastTabPrefix: null,
        setLastTabPrefix: setLastTabPrefixMock,
        suggestions,
        commands: ["!init", "!bg"],
        isProcessing: false,
      } as any);
      return null;
    };

    const { unmount } = inkModule.render(React.createElement(TestComponent));

    expect(inputCallbacks.length).toBeGreaterThan(0);
    const cb = inputCallbacks[0];
    cb("", { tab: true });

    expect(setLastTabPrefixMock).toHaveBeenCalledWith("!");
    expect(setInputMock).toHaveBeenCalledWith("!init");
    unmount();
  });

  it("should trigger tab completion in useDashboardKeyboard when query starts with bang", () => {
    const setQueryMock = vi.fn();
    const setLastTabPrefixMock = vi.fn();
    const suggestions = ["!init", "!bg"];

    const TestComponent = () => {
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
      return null;
    };

    const { unmount } = inkModule.render(React.createElement(TestComponent));

    expect(inputCallbacks.length).toBeGreaterThan(0);
    const cb = inputCallbacks[0];
    cb("", { tab: true });

    expect(setLastTabPrefixMock).toHaveBeenCalledWith("!");
    expect(setQueryMock).toHaveBeenCalledWith("!init");
    unmount();
  });

  it("should return preset suggestions when query is /mp or starts with /mp", () => {
    const mpSuggestions = getDashboardSuggestions("/mp");
    expect(mpSuggestions.length).toBeGreaterThan(0);
    expect(mpSuggestions.some(s => s.startsWith("/mp"))).toBe(true);

    const mpDashSuggestions = getDashboardSuggestions("/mp-");
    expect(mpDashSuggestions.length).toBeGreaterThan(0);
    expect(mpDashSuggestions.some(s => s.startsWith("/mp-"))).toBe(true);
  });
});
