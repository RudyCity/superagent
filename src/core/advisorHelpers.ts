import type { ToolCall, ToolResult } from "./conversation.js";

export const WRITE_TOOLS = new Set([
  "write_to_file",
  "replace_file_content",
  "apply_patch",
  "patch",
  "edit_file",
  "edit",
  "write",
  "write_file",
  "superagent_write_file",
]);

export const READ_TOOLS = new Set([
  "read",
  "view_file",
  "view",
  "cat",
  "read_file",
  "superagent_read_file",
]);

export interface ReadTarget {
  filePath: string;
  rangeKey: string;
  rangeLabel: string;
  isChunk: boolean;
}

export interface HistoryEntry {
  callKey: string;
  toolNames: string[];
  resultSig: string;
  isMutating: boolean;
}

export interface CycleDetectionResult {
  detected: boolean;
  isPause: boolean;
  cyclePeriod: number;
  occurrences: number;
  toolNames: string[];
}

const POLLING_STATUS_ACTIONS = new Set(["list", "status", "report", "logs", "violations"]);
const BG_PROCESS_ACTIONS = new Set(["list", "status", "stream", "logs", "log", "tail", "head", "read", "slice", "grep", "search", "list_logs"]);

/**
 * Truncates and sanitizes large payload parameters to keep callKey fingerprinting
 * memory-efficient and fast (under 1ms even for 1MB+ file contents or image base64).
 */
export function sanitizeToolArgsForFingerprint(args: unknown): unknown {
  if (args === null || typeof args !== "object") {
    return args;
  }
  if (Array.isArray(args)) {
    return args.slice(0, 20).map(sanitizeToolArgsForFingerprint);
  }
  const source = args as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(source)) {
    if (typeof val === "string") {
      // Truncate huge code or image payloads while keeping identity keys intact
      if (val.length > 256) {
        result[key] = `${val.slice(0, 128)}...[len:${val.length}]`;
      } else {
        result[key] = val;
      }
    } else if (typeof val === "object" && val !== null) {
      result[key] = sanitizeToolArgsForFingerprint(val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Fast stable JSON serialization with sorted keys and payload truncation.
 */
export function sortedJsonStringify(obj: unknown): string {
  const sanitized = sanitizeToolArgsForFingerprint(obj);
  if (sanitized === null || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return JSON.stringify(sanitized);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(sanitized as Record<string, unknown>).sort()) {
    sorted[key] = (sanitized as Record<string, unknown>)[key];
  }
  return JSON.stringify(sorted);
}

/**
 * Generates a fast, memory-bounded call key string for single or batched tool calls.
 */
export function buildCallKey(toolCalls: ToolCall[]): string {
  if (toolCalls.length === 0) return "";
  if (toolCalls.length === 1) {
    const tc = toolCalls[0];
    return `${tc.name}:${sortedJsonStringify(tc.args)}`;
  }
  const callKeys = new Array<string>(toolCalls.length);
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    callKeys[i] = `${tc.name}:${sortedJsonStringify(tc.args)}`;
  }
  callKeys.sort();
  return callKeys.join("|");
}

export function extractReadTargets(tc: ToolCall): ReadTarget[] {
  const targets: ReadTarget[] = [];
  if (!tc.args || typeof tc.args !== "object") return targets;
  const args = tc.args as Record<string, unknown>;

  const globalOffset = args.offset !== undefined ? Number(args.offset) : undefined;
  const globalLimit = args.limit !== undefined ? Number(args.limit) : undefined;
  const globalStartLine =
    args.StartLine !== undefined ? Number(args.StartLine)
    : args.start_line !== undefined ? Number(args.start_line)
    : args.startLine !== undefined ? Number(args.startLine)
    : args.line_start !== undefined ? Number(args.line_start)
    : undefined;
  const globalEndLine =
    args.EndLine !== undefined ? Number(args.EndLine)
    : args.end_line !== undefined ? Number(args.end_line)
    : args.endLine !== undefined ? Number(args.endLine)
    : args.line_end !== undefined ? Number(args.line_end)
    : undefined;
  const globalContentOffset = args.ContentOffset !== undefined ? Number(args.ContentOffset) : undefined;

  const buildRange = (
    offset?: number,
    limit?: number,
    startLine?: number,
    endLine?: number,
    contentOffset?: number
  ): { rangeKey: string; rangeLabel: string; isChunk: boolean } => {
    if (startLine !== undefined || endLine !== undefined) {
      const s = startLine ?? 1;
      const e = endLine !== undefined ? String(endLine) : "end";
      return {
        rangeKey: `lines:${s}-${e}`,
        rangeLabel: `lines ${s}-${e}`,
        isChunk: true,
      };
    }
    if (offset !== undefined || limit !== undefined) {
      const o = offset ?? 1;
      const l = limit !== undefined ? String(limit) : "all";
      return {
        rangeKey: `offset:${o},limit:${l}`,
        rangeLabel: `offset ${o}, limit ${l}`,
        isChunk: true,
      };
    }
    if (contentOffset !== undefined) {
      return {
        rangeKey: `contentOffset:${contentOffset}`,
        rangeLabel: `byte offset ${contentOffset}`,
        isChunk: true,
      };
    }
    return {
      rangeKey: "full",
      rangeLabel: "entire file",
      isChunk: false,
    };
  };

  const addPath = (
    rawPath: string,
    itemOffset?: number,
    itemLimit?: number,
    itemStartLine?: number,
    itemEndLine?: number
  ) => {
    if (!rawPath || typeof rawPath !== "string") return;
    const off = itemOffset ?? globalOffset;
    const lim = itemLimit ?? globalLimit;
    const sLine = itemStartLine ?? globalStartLine;
    const eLine = itemEndLine ?? globalEndLine;
    const { rangeKey, rangeLabel, isChunk } = buildRange(off, lim, sLine, eLine, globalContentOffset);
    targets.push({
      filePath: rawPath,
      rangeKey,
      rangeLabel,
      isChunk,
    });
  };

  if (typeof args.filePath === "string") addPath(args.filePath);
  if (typeof args.path === "string") addPath(args.path);
  if (typeof args.AbsolutePath === "string") addPath(args.AbsolutePath);

  if (Array.isArray(args.filePaths)) {
    for (const item of args.filePaths) {
      if (typeof item === "string") {
        addPath(item);
      } else if (item && typeof item === "object") {
        const itemObj = item as Record<string, unknown>;
        const p =
          typeof itemObj.path === "string" ? itemObj.path
          : typeof itemObj.filePath === "string" ? itemObj.filePath
          : undefined;
        if (p) {
          const itemOff = itemObj.offset !== undefined ? Number(itemObj.offset) : undefined;
          const itemLim = itemObj.limit !== undefined ? Number(itemObj.limit) : undefined;
          const itemStart =
            itemObj.StartLine !== undefined ? Number(itemObj.StartLine)
            : itemObj.start_line !== undefined ? Number(itemObj.start_line)
            : itemObj.startLine !== undefined ? Number(itemObj.startLine)
            : undefined;
          const itemEnd =
            itemObj.EndLine !== undefined ? Number(itemObj.EndLine)
            : itemObj.end_line !== undefined ? Number(itemObj.end_line)
            : itemObj.endLine !== undefined ? Number(itemObj.endLine)
            : undefined;
          addPath(p, itemOff, itemLim, itemStart, itemEnd);
        }
      }
    }
  }

  return targets;
}

export function extractReadPaths(tc: ToolCall): string[] {
  return extractReadTargets(tc).map(t => t.filePath);
}

export function isPollingOrStatusCall(name: string, args: any): boolean {
  const normalizedName = name.startsWith("default_api:") ? name.slice(12) : name;

  switch (normalizedName) {
    case "manage_subagents":
    case "manage_superagents": {
      const action = args?.action;
      return typeof action === "string" && POLLING_STATUS_ACTIONS.has(action);
    }
    case "manage_background_process": {
      const action = args?.action;
      return typeof action === "string" && BG_PROCESS_ACTIONS.has(action);
    }
    case "inspect_background_log":
    case "view_background_processes":
      return true;
    case "manage_tasks":
      return args?.action === "list";
    case "manage_task": {
      const action = args?.action;
      return action === "status" || action === "list";
    }
    default:
      return false;
  }
}

export function hasStateMutatingAction(toolCalls: ToolCall[], toolResults: ToolResult[]): boolean {
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    const res = toolResults.find(r => r.toolCallId === tc.id) || toolResults[i];
    if (res?.isError) continue;

    const name = tc.name.toLowerCase();
    if (WRITE_TOOLS.has(name)) return true;

    if (name === "control_chrome_cdp") {
      const args = tc.args as Record<string, unknown> | undefined;
      const cmd = String(args?.command || args?.cmd || "").toLowerCase();
      if (["navigate", "click", "type", "activate", "new_tab", "close_tab", "scroll", "submit", "key", "wait_for"].includes(cmd)) {
        return true;
      }
    }
    if (name === "control_chrome_vision") {
      const args = tc.args as Record<string, unknown> | undefined;
      const cmd = String(args?.command || args?.cmd || "").toLowerCase();
      if (["click_label", "type_label", "press_key"].includes(cmd)) {
        return true;
      }
    }
    if (name.startsWith("chrome_") || name.includes("remote_chrome")) {
      if (["click", "type", "navigate", "select", "submit", "open_tab", "close_tab", "press"].some(a => name.includes(a))) {
        return true;
      }
    }
    if (name.includes("invoke_subagent") || name.includes("invoke_superagent") || name.includes("merge_superagents")) {
      return true;
    }
  }
  return false;
}

export function computeResultSignature(toolResults: ToolResult[]): string {
  if (!toolResults || toolResults.length === 0) return "";
  return toolResults
    .map(r => `${r.name}:${r.isError ? "ERR" : "OK"}:${(r.result || "").trim().slice(0, 160)}`)
    .join("|");
}

export function generateCycleSuggestion(toolNames: string[]): string {
  const isBrowser = toolNames.some(t => t.includes("chrome") || t.includes("browser") || t.includes("url"));
  if (isBrowser) {
    return "Do not alternate between the same repeated browser actions. Try a different interaction or summarize your findings.";
  }
  const isSearchOrRead = toolNames.some(t => t.includes("read") || t.includes("grep") || t.includes("find") || t.includes("list") || t.includes("view"));
  if (isSearchOrRead) {
    return "Do not alternate between repeated search or read calls. Synthesize collected findings or change your search criteria.";
  }
  const isEdit = toolNames.some(t => WRITE_TOOLS.has(t.toLowerCase()));
  if (isEdit) {
    return "Do not alternate between repeated failing edits. Inspect file contents directly before attempting another edit.";
  }
  return "Do not alternate between repeated tool calls. Change strategy, use alternative tools, or conclude your task.";
}

export function generateRecoverySuggestion(toolNames: string[], hasError: boolean): string {
  if (toolNames.some(t => t.includes("chrome") || t.includes("browser"))) {
    return hasError
      ? "Check Chrome connection, target tab, or selector syntax before retrying browser action."
      : "Page content or state has not changed. Try navigating to another URL, interacting with a different element, or summarizing audit findings.";
  }
  if (toolNames.includes("edit") || toolNames.includes("replace_file_content")) {
    return hasError
      ? "Check exact string match or line range using 'read' before editing."
      : "The file might already contain the requested changes. Verify file content using 'read'.";
  }
  if (toolNames.includes("run_command") || toolNames.includes("bash")) {
    return "Check command syntax, dependencies, or environment variables.";
  }
  if (toolNames.includes("manage_subagents")) {
    return "Use 'schedule' or allow subagent background execution to proceed without continuous polling.";
  }
  return "Try an alternative tool or read relevant context before repeating the action.";
}

/**
 * Rigorous Period-2 and Period-3 cycle detector.
 * Returns a CycleDetectionResult only when actions oscillate with identical call keys AND results.
 */
export function detectCycle(
  history: HistoryEntry[],
  warningThreshold: number,
  pauseThreshold: number
): CycleDetectionResult | null {
  const n = history.length - 1;
  if (n < 4) return null;

  for (const P of [2, 3]) {
    const minStepsForWarning = (warningThreshold - 1) * P + 1;
    if (history.length < minStepsForWarning) continue;

    // Check distinct call keys within one period
    const periodKeys = new Set<string>();
    for (let i = 0; i < P; i++) {
      periodKeys.add(history[n - i].callKey);
    }
    if (periodKeys.size !== P) {
      continue;
    }

    let matchCount = 0;
    let allResultsMatch = true;
    for (let k = 0; k <= n; k++) {
      const current = history[n - k];
      const expected = history[n - (k % P)];

      if (current.callKey !== expected.callKey) {
        break;
      }
      if (current.resultSig !== expected.resultSig) {
        allResultsMatch = false;
        break;
      }
      matchCount++;
    }

    if (!allResultsMatch) {
      continue;
    }

    const occurrences = Math.floor(matchCount / P) + (matchCount % P > 0 ? 1 : 0);

    if (occurrences >= warningThreshold) {
      const toolNamesSet = new Set<string>();
      for (let i = 0; i < matchCount; i++) {
        for (const name of history[n - i].toolNames) {
          toolNamesSet.add(name);
        }
      }
      return {
        detected: true,
        isPause: occurrences >= pauseThreshold,
        cyclePeriod: P,
        occurrences,
        toolNames: Array.from(toolNamesSet),
      };
    }
  }

  return null;
}
