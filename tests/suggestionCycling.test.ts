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

import { useKeyboardHandler } from "../src/hooks/useKeyboardHandler.js";
import { useDashboardKeyboard } from "../src/hooks/useDashboardKeyboard.js";

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

describe("Tab Suggestion Cycling", () => {
  beforeEach(() => {
    inputCallbacks = [];
    vi.clearAllMocks();
  });

  it("should cycle suggestions in useKeyboardHandler (Single-Agent mode)", () => {
    const setInputMock = vi.fn();
    const setLastTabPrefixMock = vi.fn();
    const suggestions = ["/worktree", "/worktrees"];

    // First Tab press: starting cycle
    useKeyboardHandler({
      input: "/work",
      setInput: setInputMock,
      lastTabPrefix: null,
      setLastTabPrefix: setLastTabPrefixMock,
      suggestions,
      commands: ["/worktree", "/worktrees"],
      isProcessing: false,
    } as any);

    expect(inputCallbacks.length).toBeGreaterThan(0);
    const cb = inputCallbacks[0];
    cb("", { tab: true });

    expect(setLastTabPrefixMock).toHaveBeenCalledWith("/work");
    expect(setInputMock).toHaveBeenCalledWith("/worktree");

    // Second Tab press: cycling to next item
    inputCallbacks = [];
    useKeyboardHandler({
      input: "/worktree",
      setInput: setInputMock,
      lastTabPrefix: "/work",
      setLastTabPrefix: setLastTabPrefixMock,
      suggestions,
      commands: ["/worktree", "/worktrees"],
      isProcessing: false,
    } as any);

    const cb2 = inputCallbacks[0];
    cb2("", { tab: true });

    expect(setInputMock).toHaveBeenCalledWith("/worktrees");
  });

  it("should cycle suggestions in useDashboardKeyboard (Multi-Agent mode)", () => {
    const setQueryMock = vi.fn();
    const setLastTabPrefixMock = vi.fn();
    const suggestions = ["/worktree", "/worktrees"];

    // First Tab press: starting cycle
    useDashboardKeyboard({
      query: "/work",
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

    expect(setLastTabPrefixMock).toHaveBeenCalledWith("/work");
    expect(setQueryMock).toHaveBeenCalledWith("/worktree");

    // Second Tab press: cycling to next item
    inputCallbacks = [];
    useDashboardKeyboard({
      query: "/worktree",
      setQuery: setQueryMock,
      lastTabPrefix: "/work",
      setLastTabPrefix: setLastTabPrefixMock,
      suggestions,
      focusArea: "input",
      isProcessing: false,
      setIsPasted: vi.fn(),
    } as any);

    const cb2 = inputCallbacks[0];
    cb2("", { tab: true });

    expect(setQueryMock).toHaveBeenCalledWith("/worktrees");
  });
});
