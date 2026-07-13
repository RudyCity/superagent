import fs from "fs";
import path from "path";
import { getRootConfigDir } from "./paths.js";

/**
 * A single browser action step inside a macro.
 * `target` and `value` support template placeholders like {{title}} or {{url}}
 * that get replaced with actual args when the macro is executed.
 */
export interface BrowserMacroStep {
  action: string;
  target?: string;
  value?: string;
}

/**
 * A named, reusable sequence of browser actions with optional parameter descriptions.
 */
export interface BrowserMacro {
  name: string;
  description: string;
  /** Describes what template args are expected, e.g. { "title": "Article title", "content": "Body text" } */
  params?: Record<string, string>;
  steps: BrowserMacroStep[];
}

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

/** Saves a macro to disk. Overwrites any existing macro with the same name (case-insensitive). */
export function saveBrowserMacro(macro: BrowserMacro): void {
  const macros = getBrowserMacros();
  const index = macros.findIndex(m => m.name.toLowerCase() === macro.name.toLowerCase());
  if (index >= 0) {
    macros[index] = macro;
  } else {
    macros.push(macro);
  }
  const rootDir = getRootConfigDir();
  if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(getBrowserMacrosPath(), JSON.stringify(macros, null, 2), "utf-8");
}

/** Deletes a macro by name. Returns true if deleted, false if not found. */
export function deleteBrowserMacro(name: string): boolean {
  const macros = getBrowserMacros();
  const filtered = macros.filter(m => m.name.toLowerCase() !== name.toLowerCase());
  if (filtered.length === macros.length) return false;
  fs.writeFileSync(getBrowserMacrosPath(), JSON.stringify(filtered, null, 2), "utf-8");
  return true;
}

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
 */
export function resolveSteps(steps: BrowserMacroStep[], args: Record<string, string>): BrowserMacroStep[] {
  return steps.map(step => ({
    action: step.action,
    target: step.target ? interpolateStep(step.target, args) : undefined,
    value: step.value ? interpolateStep(step.value, args) : undefined,
  }));
}
