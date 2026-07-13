import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// --- Set up an isolated temp config dir before the module loads ---
const tmpDir = path.join(os.tmpdir(), `superagent-test-macros-${Date.now()}`);
process.env.SUPERAGENT_CONFIG_DIR = tmpDir;

import {
  getBrowserMacros,
  saveBrowserMacro,
  deleteBrowserMacro,
  interpolateStep,
  resolveSteps,
  type BrowserMacro,
  getBrowserMacrosPath,
} from "../src/core/config/browserMacros.js";

describe("browserMacros", () => {
  beforeEach(() => {
    // Clean up any existing file before each test
    const p = getBrowserMacrosPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("returns empty array when no macros file exists", () => {
    expect(getBrowserMacros()).toEqual([]);
  });

  it("saves and retrieves a macro", () => {
    const macro: BrowserMacro = {
      name: "test_macro",
      description: "A test macro",
      steps: [{ action: "navigate", target: "https://example.com" }],
    };
    saveBrowserMacro(macro);
    const macros = getBrowserMacros();
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe("test_macro");
    expect(macros[0].steps).toHaveLength(1);
  });

  it("overwrites an existing macro with the same name (case-insensitive)", () => {
    const original: BrowserMacro = {
      name: "medium_post",
      description: "Old description",
      steps: [{ action: "navigate", target: "https://medium.com" }],
    };
    const updated: BrowserMacro = {
      name: "MEDIUM_POST",
      description: "New description",
      steps: [
        { action: "navigate", target: "https://medium.com/new" },
        { action: "type", target: "#title", value: "{{title}}" },
      ],
    };
    saveBrowserMacro(original);
    saveBrowserMacro(updated);
    const macros = getBrowserMacros();
    expect(macros).toHaveLength(1);
    expect(macros[0].description).toBe("New description");
    expect(macros[0].steps).toHaveLength(2);
  });

  it("saves multiple distinct macros", () => {
    saveBrowserMacro({ name: "macro_a", description: "A", steps: [{ action: "navigate", target: "https://a.com" }] });
    saveBrowserMacro({ name: "macro_b", description: "B", steps: [{ action: "navigate", target: "https://b.com" }] });
    expect(getBrowserMacros()).toHaveLength(2);
  });

  it("deletes a macro by name", () => {
    saveBrowserMacro({ name: "to_delete", description: "D", steps: [{ action: "navigate", target: "https://x.com" }] });
    saveBrowserMacro({ name: "to_keep", description: "K", steps: [{ action: "navigate", target: "https://y.com" }] });
    const deleted = deleteBrowserMacro("to_delete");
    expect(deleted).toBe(true);
    const macros = getBrowserMacros();
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe("to_keep");
  });

  it("returns false when deleting a non-existent macro", () => {
    expect(deleteBrowserMacro("does_not_exist")).toBe(false);
  });

  it("deletes macro case-insensitively", () => {
    saveBrowserMacro({ name: "MyMacro", description: "M", steps: [{ action: "navigate", target: "https://z.com" }] });
    expect(deleteBrowserMacro("mymacro")).toBe(true);
    expect(getBrowserMacros()).toHaveLength(0);
  });
});

describe("interpolateStep", () => {
  it("replaces known placeholders", () => {
    expect(interpolateStep("https://{{domain}}/{{path}}", { domain: "example.com", path: "new" }))
      .toBe("https://example.com/new");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(interpolateStep("Hello {{unknown}}", {})).toBe("Hello {{unknown}}");
  });

  it("replaces multiple occurrences of the same placeholder", () => {
    expect(interpolateStep("{{x}} and {{x}}", { x: "foo" })).toBe("foo and foo");
  });

  it("returns original string if no placeholders", () => {
    expect(interpolateStep("no placeholders here", { x: "foo" })).toBe("no placeholders here");
  });
});

describe("resolveSteps", () => {
  it("interpolates target and value fields of all steps", () => {
    const steps = [
      { action: "navigate", target: "{{url}}" },
      { action: "type", target: "#field", value: "{{content}}" },
      { action: "click", target: "button" },
    ];
    const result = resolveSteps(steps, { url: "https://medium.com/new", content: "Hello World" });
    expect(result[0].target).toBe("https://medium.com/new");
    expect(result[1].value).toBe("Hello World");
    expect(result[2].target).toBe("button");
  });

  it("leaves steps with no matching args unchanged", () => {
    const steps = [{ action: "navigate", target: "{{missing}}" }];
    const result = resolveSteps(steps, {});
    expect(result[0].target).toBe("{{missing}}");
  });
});
