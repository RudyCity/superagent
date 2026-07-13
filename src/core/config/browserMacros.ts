import fs from "fs";
import path from "path";
import { getRootConfigDir } from "./paths.js";

// ─── Interfaces ───────────────────────────────────────────────────────────────

/**
 * Per-step error recovery policy.
 * - stop   (default): abort macro on failure
 * - skip:  log error and continue to next step
 * - retry: retry up to maxRetries times before applying onError fallback
 */
export type StepErrorPolicy = "stop" | "skip" | "retry";

/**
 * A single browser action step inside a macro.
 * `target` and `value` support template placeholders like {{title}} or {{url}}
 * that get replaced with actual args when the macro is executed.
 */
export interface BrowserMacroStep {
  action: string;
  target?: string;
  value?: string;
  /** Error handling policy for this step. Default: "stop" */
  onError?: StepErrorPolicy;
  /** Max retry attempts when onError === "retry". Default: 2 */
  maxRetries?: number;
  /** Optional human-readable label shown in run output */
  label?: string;
}

/**
 * A named, reusable sequence of browser actions with optional parameter descriptions.
 * Includes versioning metadata set automatically on every save.
 */
export interface BrowserMacro {
  name: string;
  description: string;
  /** Describes what template args are expected, e.g. { "title": "Article title" } */
  params?: Record<string, string>;
  steps: BrowserMacroStep[];
  /** Increments on each update. Starts at 1. */
  version: number;
  /** ISO timestamp when macro was first created. */
  createdAt: string;
  /** ISO timestamp when macro was last saved/updated. */
  updatedAt: string;
}

// ─── Step run result (used internally and for dry-run output) ─────────────────

export interface StepRunResult {
  index: number;
  label: string;
  action: string;
  target?: string;
  value?: string;
  status: "ok" | "skipped" | "failed" | "dry-run";
  output?: string;
  error?: string;
  attempts?: number;
}

// ─── Disk helpers ─────────────────────────────────────────────────────────────

/** Returns path to the global browser macros JSON file. */
export function getBrowserMacrosPath(): string {
  return path.join(getRootConfigDir(), "browser-macros.json");
}

/** Reads all saved macros from disk. Returns empty array if file is missing/corrupt. */
export function getBrowserMacros(): BrowserMacro[] {
  const filePath = getBrowserMacrosPath();
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data) as BrowserMacro[];
  } catch {
    return [];
  }
}

/**
 * Saves a macro to disk, auto-managing version and timestamps.
 * - New macro: version=1, createdAt=now, updatedAt=now
 * - Existing macro (same name, case-insensitive): version++, updatedAt=now, createdAt preserved
 */
export function saveBrowserMacro(macro: Omit<BrowserMacro, "version" | "createdAt" | "updatedAt"> & Partial<Pick<BrowserMacro, "version" | "createdAt" | "updatedAt">>): BrowserMacro {
  const macros = getBrowserMacros();
  const now = new Date().toISOString();
  const index = macros.findIndex(m => m.name.toLowerCase() === macro.name.toLowerCase());

  let saved: BrowserMacro;
  if (index >= 0) {
    const existing = macros[index];
    saved = {
      ...macro,
      version: (existing.version ?? 0) + 1,
      createdAt: existing.createdAt ?? now,
      updatedAt: now,
    } as BrowserMacro;
    macros[index] = saved;
  } else {
    saved = {
      ...macro,
      version: 1,
      createdAt: now,
      updatedAt: now,
    } as BrowserMacro;
    macros.push(saved);
  }

  const rootDir = getRootConfigDir();
  if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(getBrowserMacrosPath(), JSON.stringify(macros, null, 2), "utf-8");
  return saved;
}

/** Deletes a macro by name. Returns true if deleted, false if not found. */
export function deleteBrowserMacro(name: string): boolean {
  const macros = getBrowserMacros();
  const filtered = macros.filter(m => m.name.toLowerCase() !== name.toLowerCase());
  if (filtered.length === macros.length) return false;
  fs.writeFileSync(getBrowserMacrosPath(), JSON.stringify(filtered, null, 2), "utf-8");
  return true;
}

// ─── Interpolation ────────────────────────────────────────────────────────────

/**
 * Interpolates template placeholders (e.g. {{key}}) in a string using the given args map.
 * Unmatched placeholders are left as-is.
 */
export function interpolateStep(text: string, args: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => args[key] ?? `{{${key}}}`);
}

/**
 * Applies argument interpolation to all step fields of a macro.
 * Returns a new array of steps with placeholders replaced.
 * Non-interpolated fields (onError, maxRetries, label) are preserved as-is.
 */
export function resolveSteps(steps: BrowserMacroStep[], args: Record<string, string>): BrowserMacroStep[] {
  return steps.map(step => ({
    ...step,
    target: step.target ? interpolateStep(step.target, args) : undefined,
    value:  step.value  ? interpolateStep(step.value,  args) : undefined,
  }));
}

// ─── Dry-run ──────────────────────────────────────────────────────────────────

/**
 * Returns a dry-run preview of all resolved steps without executing them.
 * Useful for verifying arg substitution and step order before a real run.
 */
export function dryRunSteps(steps: BrowserMacroStep[], args: Record<string, string>): StepRunResult[] {
  const resolved = resolveSteps(steps, args);
  return resolved.map((step, i) => ({
    index: i + 1,
    label: step.label ?? `Step ${i + 1}`,
    action: step.action,
    target: step.target,
    value: step.value,
    status: "dry-run" as const,
    output: `[DRY-RUN] Would execute: ${step.action}${step.target ? ` on "${step.target}"` : ""}${step.value ? ` with value "${step.value}"` : ""}`,
  }));
}

// ─── Macro repair hint ────────────────────────────────────────────────────────

/**
 * Generates a structured repair hint from a failed step run.
 * Returned in macro run output to guide AI auto-repair via control_browser_macro_save.
 */
export function buildRepairHint(macroName: string, failedResults: StepRunResult[]): string {
  const failedSteps = failedResults.filter(r => r.status === "failed");
  if (failedSteps.length === 0) return "";
  const lines = [
    `\n--- REPAIR HINT ---`,
    `Macro "${macroName}" failed at ${failedSteps.length} step(s).`,
    `To auto-repair: inspect the target page DOM, then call control_browser_macro_save with updated steps.`,
    `Failed steps:`,
    ...failedSteps.map(s =>
      `  Step ${s.index} [${s.action}]${s.target ? ` target="${s.target}"` : ""}: ${s.error}`
    ),
    `Suggested actions:`,
    `  1. Use control_browser_tab(action:'screenshot') to see current page state.`,
    `  2. Use control_browser_tab(action:'html') to re-inspect DOM selectors.`,
    `  3. Call control_browser_macro_save with corrected steps to update this macro.`,
  ];
  return lines.join("\n");
}
