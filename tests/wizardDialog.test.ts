import { describe, it, expect } from "vitest";
import React from "react";
import { render } from "ink";
import { Console } from "node:console";
import { Writable } from "node:stream";
import { WizardDialog } from "../src/components/wizard-dialog.js";

// Restore console.Console if Vitest mocked or removed it
if (!console.Console) {
  console.Console = Console;
}

class TestStream extends Writable {
  output = "";
  _write(chunk: any, encoding: any, callback: any) {
    this.output += chunk.toString();
    callback();
  }
}

describe("WizardDialog Scroll & Indicator Tests", () => {
  it("should render scrolling indicators when options count exceeds maxVisible", () => {
    const options = Array.from({ length: 15 }, (_, i) => `Option ${i + 1}`);
    const stream = new TestStream();
    const { unmount } = render(
      React.createElement(WizardDialog, {
        title: "Test Wizard",
        borderColor: "cyan",
        options,
        selectedIndex: 5,
        maxVisible: 10,
      }),
      { stdout: stream as any }
    );

    const frameOutput = stream.output;
    expect(frameOutput).toBeDefined();
    expect(frameOutput).toContain("Option 1");
    expect(frameOutput).toContain("Option 10");
    expect(frameOutput).not.toContain("Option 11");
    expect(frameOutput).toContain("▼ ... (5 more options below) ...");
    unmount();
  });

  it("should default maxVisible to 10 when not explicitly provided", () => {
    const options = Array.from({ length: 12 }, (_, i) => `Option ${i + 1}`);
    const stream = new TestStream();
    const { unmount } = render(
      React.createElement(WizardDialog, {
        title: "Test Wizard Default",
        borderColor: "cyan",
        options,
        selectedIndex: 0,
      }),
      { stdout: stream as any }
    );

    const frameOutput = stream.output;
    expect(frameOutput).toBeDefined();
    expect(frameOutput).toContain("Option 1");
    expect(frameOutput).toContain("Option 10");
    expect(frameOutput).not.toContain("Option 11");
    expect(frameOutput).toContain("▼ ... (2 more options below) ...");
    unmount();
  });

  it("should correctly highlight the selected option when selectedIndex is passed as a string", () => {
    const options = ["Option A", "Option B", "Option C"];
    const stream = new TestStream();
    const { unmount } = render(
      React.createElement(WizardDialog, {
        title: "Test String Index",
        borderColor: "cyan",
        options,
        selectedIndex: "1" as any,
      }),
      { stdout: stream as any }
    );

    const frameOutput = stream.output;
    expect(frameOutput).toBeDefined();
    expect(frameOutput).toContain("❯  Option B");
    expect(frameOutput).toContain("   Option A");
    unmount();
  });
});
