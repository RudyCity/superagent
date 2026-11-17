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
    }));
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
    }));
    expect(inputHandler).toBeDefined();

    inputHandler!("", { escape: true });

    expect(onEscapeKey).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    view.unmount();
  });
});
