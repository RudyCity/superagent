import { afterEach, describe, it, expect, vi } from "vitest";
import React from "react";
import { render } from "ink";
import { PassThrough } from "node:stream";
import { WizardDialog } from "../src/components/wizard-dialog.js";

interface RenderedWizard {
  output: () => string;
  cleanup: () => void;
}

const cleanups: Array<() => void> = [];

async function renderWizard(props: React.ComponentProps<typeof WizardDialog>): Promise<RenderedWizard> {
  const stdout = new PassThrough();
  Object.assign(stdout, { columns: props.terminalWidth ?? 120, isTTY: false });
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: false });
  const stderr = new PassThrough();
  let text = "";
  stdout.on("data", (chunk) => { text += chunk.toString(); });

  const app = render(React.createElement(WizardDialog, props), {
    stdout: stdout as NodeJS.WriteStream,
    stdin: stdin as NodeJS.ReadStream,
    stderr: stderr as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  const cleanup = () => {
    app.unmount();
    app.cleanup();
    stdout.destroy();
    stdin.destroy();
    stderr.destroy();
  };
  cleanups.push(cleanup);

  // Ink commits asynchronously. Wait for the actual frame instead of reading
  // stdout immediately, which races rendering and can silently assert on "".
  await vi.waitFor(() => expect(text).toContain(props.title));
  return {
    output: () => text.replace(/\x1b\[[0-9;]*m/g, ""),
    cleanup,
  };
}

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

describe("WizardDialog scroll and indicator rendering", () => {
  it("shows only maxVisible options and reports remaining options below", async () => {
    const options = Array.from({ length: 15 }, (_, i) => `Option ${i + 1}`);
    const wizard = await renderWizard({
      title: "Test Wizard",
      borderColor: "cyan",
      options,
      selectedIndex: 0,
      maxVisible: 10,
      marginTop: 0,
      marginBottom: 0,
    });

    const output = wizard.output();
    expect(output).toContain("Option 1");
    expect(output).toContain("Option 10");
    expect(output).not.toContain("Option 11");
    expect(output).toContain("▼ ... (5 more options below) ...");
  });

  it("defaults maxVisible to 10 when the prop is omitted", async () => {
    const options = Array.from({ length: 12 }, (_, i) => `Option ${i + 1}`);
    const wizard = await renderWizard({
      title: "Test Wizard Default",
      borderColor: "cyan",
      options,
      selectedIndex: 0,
      marginTop: 0,
      marginBottom: 0,
    });

    const output = wizard.output();
    expect(output).toContain("Option 1");
    expect(output).toContain("Option 10");
    expect(output).not.toContain("Option 11");
    expect(output).toContain("▼ ... (2 more options below) ...");
  });

  it("normalizes a string selectedIndex and highlights the matching option", async () => {
    const wizard = await renderWizard({
      title: "Test String Index",
      borderColor: "cyan",
      options: ["Option A", "Option B", "Option C"],
      selectedIndex: "1" as any,
      marginTop: 0,
      marginBottom: 0,
    });

    const output = wizard.output();
    expect(output).toContain("❯  Option B");
    expect(output).toContain("   Option A");
  });
});
