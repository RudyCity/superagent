import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Isolated temp config dir
const tmpDir = path.join(os.tmpdir(), `superagent-test-macros-${Date.now()}`);
process.env.SUPERAGENT_CONFIG_DIR = tmpDir;

import {
  getBrowserMacros,
  saveBrowserMacro,
  deleteBrowserMacro,
  interpolateStep,
  resolveSteps,
  dryRunSteps,
  buildRepairHint,
  type BrowserMacro,
  type StepRunResult,
  getBrowserMacrosPath,
} from "../src/core/config/browserMacros.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function cleanFile() {
  const p = getBrowserMacrosPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────
describe("browserMacros — CRUD", () => {
  beforeEach(cleanFile);
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("returns empty array when no macros file exists", () => {
    expect(getBrowserMacros()).toEqual([]);
  });

  it("saves and retrieves a macro", () => {
    saveBrowserMacro({
      name: "test_macro",
      description: "A test macro",
      steps: [{ action: "navigate", target: "https://example.com" }],
    });
    const macros = getBrowserMacros();
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe("test_macro");
    expect(macros[0].steps).toHaveLength(1);
  });

  it("overwrites macro with same name (case-insensitive)", () => {
    saveBrowserMacro({
      name: "medium_post",
      description: "Old",
      steps: [{ action: "navigate", target: "https://medium.com" }],
    });
    saveBrowserMacro({
      name: "MEDIUM_POST",
      description: "New",
      steps: [
        { action: "navigate", target: "https://medium.com/new" },
        { action: "type", target: "#title", value: "{{title}}" },
      ],
    });
    const macros = getBrowserMacros();
    expect(macros).toHaveLength(1);
    expect(macros[0].description).toBe("New");
    expect(macros[0].steps).toHaveLength(2);
  });

  it("saves multiple distinct macros", () => {
    saveBrowserMacro({ name: "macro_a", description: "A", steps: [{ action: "navigate", target: "https://a.com" }] });
    saveBrowserMacro({ name: "macro_b", description: "B", steps: [{ action: "navigate", target: "https://b.com" }] });
    expect(getBrowserMacros()).toHaveLength(2);
  });

  it("deletes a macro by name", () => {
    saveBrowserMacro({ name: "to_delete", description: "D", steps: [{ action: "navigate", target: "https://x.com" }] });
    saveBrowserMacro({ name: "to_keep",   description: "K", steps: [{ action: "navigate", target: "https://y.com" }] });
    expect(deleteBrowserMacro("to_delete")).toBe(true);
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

// ─── Fix 3: Versioning ────────────────────────────────────────────────────────
describe("Fix 3 — versioning & timestamps", () => {
  beforeEach(cleanFile);

  it("sets version=1 and createdAt/updatedAt on first save", () => {
    const before = Date.now();
    const saved = saveBrowserMacro({
      name: "versioned",
      description: "v1",
      steps: [{ action: "navigate", target: "https://a.com" }],
    });
    const after = Date.now();
    expect(saved.version).toBe(1);
    expect(new Date(saved.createdAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(saved.updatedAt).getTime()).toBeLessThanOrEqual(after);
    expect(saved.createdAt).toBe(saved.updatedAt);
  });

  it("increments version and preserves createdAt on subsequent saves", () => {
    const first = saveBrowserMacro({
      name: "versioned",
      description: "v1",
      steps: [{ action: "navigate", target: "https://a.com" }],
    });
    const second = saveBrowserMacro({
      name: "versioned",
      description: "v2",
      steps: [{ action: "navigate", target: "https://b.com" }],
    });
    expect(second.version).toBe(2);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.description).toBe("v2");
  });

  it("persists versioning metadata to disk", () => {
    saveBrowserMacro({ name: "persist_v", description: "x", steps: [{ action: "navigate", target: "https://x.com" }] });
    saveBrowserMacro({ name: "persist_v", description: "y", steps: [{ action: "navigate", target: "https://y.com" }] });
    const macros = getBrowserMacros();
    expect(macros[0].version).toBe(2);
    expect(macros[0].createdAt).toBeTruthy();
    expect(macros[0].updatedAt).toBeTruthy();
  });
});

// ─── Fix 4: Per-step onError policy ──────────────────────────────────────────
describe("Fix 4 — per-step onError fields preserved in resolveSteps", () => {
  it("preserves onError and maxRetries through resolveSteps", () => {
    const steps = [
      { action: "navigate", target: "{{url}}", onError: "retry" as const, maxRetries: 3 },
      { action: "click",    target: ".btn",     onError: "skip"  as const },
      { action: "type",     target: "#q",        value: "{{q}}", onError: "stop" as const },
    ];
    const resolved = resolveSteps(steps, { url: "https://example.com", q: "hello" });
    expect(resolved[0].onError).toBe("retry");
    expect(resolved[0].maxRetries).toBe(3);
    expect(resolved[0].target).toBe("https://example.com");
    expect(resolved[1].onError).toBe("skip");
    expect(resolved[2].onError).toBe("stop");
    expect(resolved[2].value).toBe("hello");
  });

  it("preserves label through resolveSteps", () => {
    const steps = [{ action: "navigate", target: "{{url}}", label: "Go to site" }];
    const resolved = resolveSteps(steps, { url: "https://test.com" });
    expect(resolved[0].label).toBe("Go to site");
    expect(resolved[0].target).toBe("https://test.com");
  });
});

// ─── Fix 5: Dry-run ───────────────────────────────────────────────────────────
describe("Fix 5 — dryRunSteps", () => {
  it("returns dry-run entries without executing", () => {
    const steps = [
      { action: "navigate", target: "{{url}}", label: "Open site" },
      { action: "type",     target: "#q",      value: "{{query}}" },
      { action: "click",    target: "button" },
    ];
    const results = dryRunSteps(steps, { url: "https://test.com", query: "hello" });
    expect(results).toHaveLength(3);
    expect(results[0].status).toBe("dry-run");
    expect(results[0].target).toBe("https://test.com");
    expect(results[0].label).toBe("Open site");
    expect(results[1].value).toBe("hello");
    expect(results[2].output).toContain("[DRY-RUN]");
  });

  it("correctly interpolates placeholders in dry-run output", () => {
    const steps = [{ action: "navigate", target: "https://{{domain}}/{{path}}" }];
    const results = dryRunSteps(steps, { domain: "medium.com", path: "new" });
    expect(results[0].target).toBe("https://medium.com/new");
    expect(results[0].output).toContain("https://medium.com/new");
  });

  it("leaves unmatched placeholders as-is in dry-run", () => {
    const steps = [{ action: "type", target: "#x", value: "{{missing}}" }];
    const results = dryRunSteps(steps, {});
    expect(results[0].value).toBe("{{missing}}");
  });
});

// ─── Fix 6: Repair hints ──────────────────────────────────────────────────────
describe("Fix 6 — buildRepairHint", () => {
  it("returns empty string when no failed steps", () => {
    const results: StepRunResult[] = [
      { index: 1, label: "Step 1", action: "navigate", status: "ok", output: "done" },
    ];
    expect(buildRepairHint("my_macro", results)).toBe("");
  });

  it("returns repair hint when steps have failed status", () => {
    const results: StepRunResult[] = [
      { index: 1, label: "Step 1", action: "navigate", status: "ok",     output: "done" },
      { index: 2, label: "Step 2", action: "click",    status: "failed",  error: "Element not found", target: ".btn" },
    ];
    const hint = buildRepairHint("my_macro", results);
    expect(hint).toContain("REPAIR HINT");
    expect(hint).toContain("my_macro");
    expect(hint).toContain("click");
    expect(hint).toContain(".btn");
    expect(hint).toContain("Element not found");
    expect(hint).toContain("control_browser_macro_save");
  });

  it("lists all failed steps in the hint", () => {
    const results: StepRunResult[] = [
      { index: 1, label: "Step 1", action: "click", status: "failed", error: "err1", target: ".a" },
      { index: 2, label: "Step 2", action: "type",  status: "failed", error: "err2", target: ".b" },
    ];
    const hint = buildRepairHint("m", results);
    expect(hint).toContain("err1");
    expect(hint).toContain("err2");
    expect(hint).toContain(".a");
    expect(hint).toContain(".b");
  });
});

// ─── interpolateStep (regression) ────────────────────────────────────────────
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
