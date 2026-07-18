import fs from "fs/promises";
import path from "path";
import { Tool } from "./types.js";
import {
  getBrowserMacros,
  saveBrowserMacro,
  deleteBrowserMacro,
  resolveSteps,
  dryRunSteps,
  buildRepairHint,
  type BrowserMacroStep,
  type StepRunResult,
} from "../config/browserMacros.js";

export let browserControlHandler: ((action: string, target: string, value?: string) => Promise<string>) | null = null;

export function setBrowserControlHandler(handler: typeof browserControlHandler) {
  browserControlHandler = handler;
}

export const controlBrowserTabTool: Tool = {
  name: "control_browser_tab",
  description: "Automate browser actions on the user's active Chrome tab (requires the extension to be open). Actions: click (guides the user to click manually for stealth), type (human-like typing), paste (instant typing), navigate, scroll, screenshot, detect_ui (runs UI-DETR-1 to detect UI elements and coordinates), errors, text, hover, keypress, wait, html, reload, back, forward, open, close, list, switch, duplicate, pin, unpin, mute, unmute, move, group, ungroup, discard, new_window, close_window, top_sites (get top visited sites), reading_list_add (add reading list), reading_list_remove (remove reading list), reading_list_get (get reading list), group_update (update group title/color), group_get (get group info), history_search (search history), history_delete (delete URL from history), history_clear (clear all history), management_list (list extensions), management_get (get extension details), show_detections (shows visual bounding boxes), hide_detections (hides bounding boxes), dom_info (gets DOM info for coordinates), execute_chain (executes a JSON sequence of actions), highlight_element (highlights coordinates on webpage).",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "click", "type", "paste", "navigate", "scroll", "screenshot", "detect_ui", "errors", "text", "hover", "keypress", "wait", "html", "reload", "back", "forward",
          "open", "close", "list", "switch", "duplicate", "pin", "unpin", "mute", "unmute", "move", "group", "ungroup", "discard", "new_window", "close_window",
          "top_sites", "reading_list_add", "reading_list_remove", "reading_list_get", "group_update", "group_get", "history_search", "history_delete", "history_clear", "management_list", "management_get",
          "show_detections", "hide_detections", "dom_info", "execute_chain", "highlight_element"
        ],
        description: "The browser action to execute."
      },
      target: {
        type: "string",
        description: "CSS selector, destination URL, tab/window/group/extension ID, comma-separated tab IDs, history search query, or JSON chain string. Required for click, type, paste, navigate, scroll, hover, keypress, switch, move, group, ungroup, reading_list_add, reading_list_remove, group_update, history_delete, management_get, show_detections, dom_info, execute_chain, and highlight_element. For wait, either target (selector or duration) or value (duration) must be provided."
      },
      value: {
        type: "string",
        description: "Text to type/paste (type, paste), key to press (keypress), scroll offset, timeout in ms (wait), destination index (move), group ID (group), group metadata JSON or title (group_update), reading list title (reading_list_add), history maxResults (history_search), confidence threshold (detect_ui), or execute_chain values."
      }
    },
    required: ["action"]
  },
  async execute(args, cwd, signal) {
    if (!browserControlHandler) {
      return "Error: Browser control handler is not active. Please launch the Superagent Chrome Extension and connect to activate browser control.";
    }
    const handler = browserControlHandler!;
    const action = args.action as string;
    if (["click", "type", "paste", "navigate", "scroll", "hover", "keypress", "switch", "move", "group", "ungroup", "reading_list_add", "reading_list_remove", "group_update", "history_delete", "management_get", "show_detections", "dom_info", "execute_chain", "highlight_element"].includes(action) && !args.target) {
      return `Error: Target parameter is required for action "${action}".`;
    }
    if (action === "wait" && !args.target && !args.value) {
      return `Error: Either target (CSS selector or milliseconds) or value (milliseconds) is required for action "wait".`;
    }
    if (action === "detect_ui") {
      try {
        const screenshotResult = await handler("screenshot", "", "");
        if (screenshotResult.includes("Error") || screenshotResult.includes("failed")) {
          return `Failed to capture screenshot for detection: ${screenshotResult}`;
        }
        let screenshotBase64 = "";
        if (screenshotResult.startsWith("data:image/png;base64,")) {
          screenshotBase64 = screenshotResult.replace(/^data:image\/png;base64,/, "");
        } else {
          const match = screenshotResult.match(/Screenshot saved to workspace at: (.+)/);
          const screenshotPath = match ? match[1].trim() : path.join(cwd, "chrome_screenshot.png");
          try {
            screenshotBase64 = await fs.readFile(screenshotPath, { encoding: "base64" });
          } catch {}
        }
        
        const threshold = args.value ? parseFloat(String(args.value)) : 0.35;
        const response = await fetch("http://127.0.0.1:8095/detect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image_base64: screenshotBase64 || undefined,
            threshold: isNaN(threshold) ? 0.35 : threshold
          })
        });
        const data = await response.json() as any;
        if (data.error) {
          return `UI Detection failed: ${data.error}`;
        }
        if (data.success && Array.isArray(data.elements)) {
          if (data.elements.length === 0) {
            return "UI Detection finished: No elements detected on the page.";
          }
          try {
            await handler("show_detections", JSON.stringify(data.elements), "");
          } catch (_) {}

          const enriched = await Promise.all(
            data.elements.map(async (el: any) => {
              try {
                const [cx, cy] = el.center;
                const domRaw = await handler("dom_info", `${cx},${cy}`, "");
                const dom = JSON.parse(domRaw);
                return { ...el, dom };
              } catch {
                return el;
              }
            })
          );

          let responseStr = "Detected UI elements (coordinate or CSS selector):\n";
          for (const el of enriched) {
            const [cx, cy] = el.center;
            const score = Math.round(el.score * 100);
            const coordHint = `${cx},${cy}`;
            const selectorHint = el.dom?.id ? ` | #${el.dom.id}` : el.dom?.selector ? ` | ${el.dom.selector}` : "";
            const ariaHint = el.dom?.ariaLabel ? ` | aria: "${el.dom.ariaLabel}"` : el.dom?.innerText ? ` | text: "${el.dom.innerText.slice(0, 30)}"` : "";
            responseStr += `- ${el.label} @ ${coordHint}${selectorHint}${ariaHint} (${score}%)\n`;
          }
          return responseStr.trim();
        }
        return `UI Detection returned unexpected output: ${JSON.stringify(data)}`;
      } catch (err: any) {
        return `UI Detection execution failed: ${err.message || String(err)}`;
      }
    }
    try {
      const result = await handler(action, (args.target as string) || "", (args.value as string) || "");
      return result;
    } catch (err: any) {
      return `Browser control failed: ${err.message || String(err)}`;
    }
  }
};

export const controlBrowserMacroSaveTool: Tool = {
  name: "control_browser_macro_save",
  description: "Save a reusable browser control macro preset. A macro is a named sequence of browser actions (navigate, type, click, wait, etc.) that can be executed later in one call. Steps support: {{param}} placeholders, per-step onError policy (stop/skip/retry), maxRetries, and optional label. Version and timestamps are managed automatically.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Unique macro name in snake_case (e.g. medium_post, google_search)"
      },
      description: {
        type: "string",
        description: "What this macro does in plain English"
      },
      params: {
        type: "object",
        description: "Optional map of parameter names to descriptions, e.g. { \"title\": \"Article title\" }",
        additionalProperties: { type: "string" }
      },
      steps: {
        type: "array",
        description: "Ordered list of browser actions to execute",
        items: {
          type: "object",
          properties: {
            action: { type: "string", description: "Browser action (navigate, click, type, wait, scroll, screenshot, etc.)" },
            target: { type: "string", description: "CSS selector or URL. Supports {{param}} placeholders." },
            value: { type: "string", description: "Text or value to type. Supports {{param}} placeholders." },
            label: { type: "string", description: "Human-readable label for this step shown in run output." },
            onError: { type: "string", enum: ["stop", "skip", "retry"], description: "What to do if this step fails. Default: stop" },
            maxRetries: { type: "number", description: "Max retry attempts when onError=retry. Default: 2" }
          },
          required: ["action"]
        }
      },
      delete: {
        type: "boolean",
        description: "If true, deletes the macro with the given name instead of saving it."
      }
    },
    required: ["name"]
  },
  async execute(args) {
    const name = args.name as string;
    if (args.delete === true) {
      const deleted = deleteBrowserMacro(name);
      return deleted ? `Macro "${name}" deleted.` : `Error: Macro "${name}" not found.`;
    }
    if (!args.steps || !Array.isArray(args.steps) || (args.steps as any[]).length === 0) {
      return `Error: "steps" must be a non-empty array of browser action steps.`;
    }
    const saved = saveBrowserMacro({
      name,
      description: (args.description as string) || "",
      params: (args.params as Record<string, string>) || undefined,
      steps: args.steps as BrowserMacroStep[],
    });
    return `Macro "${name}" saved (v${saved.version}) with ${saved.steps.length} steps. Updated: ${saved.updatedAt}`;
  }
};

export const controlBrowserMacroRunTool: Tool = {
  name: "control_browser_macro_run",
  description: "Execute a saved browser macro preset by name. Replaces {{param}} placeholders in each step with 'args' values. Respects per-step onError policy (stop/skip/retry). Use dryRun=true to preview resolved steps without executing. Use name='list' to see all saved macros. On failure, returns a REPAIR HINT to guide updating the macro.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Macro name to execute (e.g. medium_post), or 'list' to see all saved macros."
      },
      args: {
        type: "object",
        description: "Key-value map of parameter values to inject into the macro steps.",
        additionalProperties: { type: "string" }
      },
      dryRun: {
        type: "boolean",
        description: "If true, preview resolved steps without executing them. Useful for verifying args and step order before a real run."
      }
    },
    required: ["name"]
  },
  async execute(args) {
    const name = args.name as string;
    const argsMap = (args.args as Record<string, string>) || {};
    const isDryRun = args.dryRun === true;

    if (name === "list") {
      const macros = getBrowserMacros();
      if (macros.length === 0) return "No macros saved yet.";
      return macros.map(m => {
        const paramList = m.params
          ? Object.entries(m.params).map(([k, v]) => `  - {{${k}}}: ${v}`).join("\n")
          : "  (none)";
        const meta = `v${m.version ?? 1} | created: ${m.createdAt ?? "unknown"} | updated: ${m.updatedAt ?? "unknown"}`;
        return `Macro: ${m.name} (${meta})\nDescription: ${m.description}\nParams:\n${paramList}\nSteps: ${m.steps.length} actions`;
      }).join("\n\n");
    }

    const macros = getBrowserMacros();
    const macro = macros.find(m => m.name.toLowerCase() === name.toLowerCase());
    if (!macro) return `Error: Macro "${name}" not found. Use name 'list' to see available macros.`;

    const resolvedSteps = resolveSteps(macro.steps, argsMap);

    if (isDryRun) {
      const preview = dryRunSteps(macro.steps, argsMap);
      const lines = [
        `DRY-RUN: Macro "${name}" (v${macro.version ?? 1}) — ${preview.length} steps`,
        `Args: ${JSON.stringify(argsMap)}`,
        "",
        ...preview.map(r => `  ${r.index}. [${r.action}]${r.label !== `Step ${r.index}` ? ` "${r.label}"` : ""}: ${r.output}`),
      ];
      return lines.join("\n");
    }

    if (!browserControlHandler) {
      return "Error: Browser control handler is not active. Please launch the Chrome Extension and connect to activate browser control.";
    }

    const results: StepRunResult[] = [];
    let aborted = false;

    for (let i = 0; i < resolvedSteps.length; i++) {
      const step = resolvedSteps[i];
      const policy = step.onError ?? "stop";
      const maxRetries = step.onError === "retry" ? (step.maxRetries ?? 2) : 0;
      const label = step.label ?? `Step ${i + 1}`;

      let lastError = "";
      let attempts = 0;
      let succeeded = false;
      let output = "";

      do {
        attempts++;
        try {
          output = await browserControlHandler(step.action, step.target || "", step.value || "");
          succeeded = true;
        } catch (err: any) {
          lastError = err.message || String(err);
        }
      } while (!succeeded && policy === "retry" && attempts <= maxRetries);

      if (succeeded) {
        results.push({ index: i + 1, label, action: step.action, target: step.target, value: step.value, status: "ok", output, attempts });
      } else {
        const result: StepRunResult = {
          index: i + 1, label, action: step.action, target: step.target, value: step.value,
          status: "failed", error: lastError, attempts
        };
        results.push(result);

        if (policy === "skip") {
          continue;
        } else {
          aborted = true;
          break;
        }
      }
    }

    const lines = results.map(r => {
      const retryNote = r.attempts && r.attempts > 1 ? ` (${r.attempts} attempts)` : "";
      if (r.status === "ok")     return `Step ${r.index} [${r.action}]${retryNote}: ${r.output}`;
      if (r.status === "skipped") return `Step ${r.index} [${r.action}] SKIPPED: ${r.error}`;
      return `Step ${r.index} [${r.action}] FAILED${retryNote}: ${r.error}`;
    });

    if (aborted) {
      lines.push(`\nAborted after step ${results.length} of ${resolvedSteps.length}.`);
      lines.push(buildRepairHint(name, results));
    } else {
      const ok = results.filter(r => r.status === "ok").length;
      const skipped = results.filter(r => r.status === "skipped").length;
      const failed = results.filter(r => r.status === "failed").length;
      lines.push(`\nCompleted: ${ok} ok, ${skipped} skipped, ${failed} failed.`);
      if (failed > 0) lines.push(buildRepairHint(name, results));
    }

    return lines.join("\n");
  }
};
