import { Console } from "node:console";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import * as inkModule from "ink";
import { ChatTextInput } from "../src/components/ChatTextInput.js";

// Ink's patched console expects console.Console under Bun.
if (!console.Console) console.Console = Console;

describe("ChatTextInput Escape debounce regression", () => {
  let inputHandler: ((input: string, key: any) => void) | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    inputHandler = undefined;
    vi.spyOn(inkModule, "useInput").mockImplementation((handler: any) => {
      inputHandler = handler;
    });
    vi.spyOn(inkModule, "useStdin").mockReturnValue({
      internal_eventEmitter: { on: vi.fn(), off: vi.fn() },
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops a pending debounced draft instead of restoring it after ESC", async () => {
    const onChange = vi.fn();
    const view = inkModule.render(React.createElement(ChatTextInput, {
      value: "",
      onChange,
      focus: true,
    }), { patchConsole: false });
    expect(inputHandler).toBeDefined();

    inputHandler!("draft", {});
    inputHandler!("\x1b", { escape: false });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(onChange).toHaveBeenCalledWith("");
    expect(onChange).not.toHaveBeenCalledWith("draft");
    view.unmount();
  });

  it("does not override wizard navigation with an input clear", () => {
    const onChange = vi.fn();
    const onEscapeKey = vi.fn();
    const view = inkModule.render(React.createElement(ChatTextInput, {
      value: "wizard answer",
      onChange,
      onEscapeKey,
      immediate: true,
    }), { patchConsole: false });
    expect(inputHandler).toBeDefined();

    inputHandler!("", { escape: true });

    expect(onEscapeKey).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    view.unmount();
  });

  it("flushes pending debounce immediately when Tab key is pressed", () => {
    const onChange = vi.fn();
    const view = inkModule.render(React.createElement(ChatTextInput, {
      value: "",
      onChange,
      focus: true,
    }), { patchConsole: false });
    expect(inputHandler).toBeDefined();

    inputHandler!("mycom", {});
    expect(onChange).not.toHaveBeenCalledWith("mycom");

    inputHandler!("", { tab: true });
    expect(onChange).toHaveBeenCalledWith("mycom");
    view.unmount();
  });

  it("preserves cursor offset during rapid continuous typing", async () => {
    let parentValue = "";
    let cursorOffset = 0;
    const onChange = vi.fn((val: string) => {
      parentValue = val;
    });

    const view = inkModule.render(React.createElement(ChatTextInput, {
      value: parentValue,
      onChange,
      focus: true,
      onCursorOffsetChange: (offset: number) => {
        cursorOffset = offset;
      },
    }), { patchConsole: false });
    expect(inputHandler).toBeDefined();

    inputHandler!("h", {});
    inputHandler!("e", {});
    inputHandler!("l", {});
    inputHandler!("l", {});
    inputHandler!("o", {});

    expect(cursorOffset).toBe(5);

    // Wait for the 20ms debounce to settle
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(onChange).toHaveBeenCalledWith("hello");
    expect(cursorOffset).toBe(5);
    view.unmount();
  });
});
