import type { ChatLine } from "../core/commands/types.js";
import type { Message, ToolCall, ToolResult } from "../core/conversation.js";
import { contentToString } from "../core/conversation.js";
import { getToolDescription } from "../core/permissions.js";
import { formatArgs } from "./text.js";

export function getLatestSubagentAction(logs: string[], prompt?: string): string {
  if (!logs || logs.length === 0) return prompt ? prompt : "Initializing...";
  for (let i = logs.length - 1; i >= 0; i--) {
    const raw = logs[i].replace(/\r/g, "").trim();
    if (raw) {
      let clean = raw
        .replace(/^.*?───\[\s*/, "")
        .replace(/\s*\]$/, "")
        .replace(/^[│┌├└─\s]+/, "")
        .trim();
      clean = clean.replace(/^Description:\s*/i, "");
      clean = clean.replace(/^Args:\s*/i, "");
      if (clean) {
        return clean;
      }
    }
  }
  return prompt ? prompt : "Processing...";
}

export function getSubagentActionStreams(logs: string[], prompt?: string): string[] {
  const streams: string[] = [];
  if (prompt && prompt.trim()) {
    streams.push(prompt.trim());
  }
  if (logs && logs.length > 0) {
    for (let i = 0; i < logs.length; i++) {
      const raw = logs[i].replace(/\r/g, "").trim();
      if (raw) {
        let clean = raw
          .replace(/^.*?───\[\s*/, "")
          .replace(/\s*\]$/, "")
          .replace(/^[│┌├└─\s]+/, "")
          .trim()
          .replace(/^Description:\s*/i, "")
          .replace(/^Args:\s*/i, "");
        if (clean && !streams.includes(clean)) {
          streams.push(clean);
        }
      }
    }
  }
  if (streams.length === 0) {
    return [prompt ? prompt : "Processing..."];
  }
  if (streams.length > 2) {
    const first = streams[0];
    const last = streams[streams.length - 1];
    const middle = streams.slice(1, -1);
    return [first, last, ...middle];
  }
  return streams;
}


export function getLatestSuperagentAction(logs: string[], task?: string): string {
  if (!logs || logs.length === 0) return task ? task : "Initializing...";
  for (let i = logs.length - 1; i >= 0; i--) {
    const raw = logs[i].replace(/\r/g, "").trim();
    if (raw) {
      let clean = raw
        .replace(/^\[THINK\]\s*/i, "")
        .replace(/^\[TOOL:START\]\s*/i, "")
        .replace(/^\[TOOL:SUCCESS\]\s*/i, "")
        .replace(/^\[TOOL:FAILED\]\s*/i, "")
        .replace(/^\[ERROR\]\s*/i, "")
        .replace(/^[│┌├└─\s]+/, "")
        .trim();
      if (clean) {
        return clean;
      }
    }
  }
  return task ? task : "Processing...";
}

function safeString(val: unknown): string {
  if (typeof val === "string") return val;
  if (val === null || val === undefined) return "";
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

function ensureArray<T>(val: unknown): T[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object") return [parsed];
    } catch {}
  }
  return [];
}

function formatToolResultContent(tc: ToolCall | undefined, tr: ToolResult): string {
  const rawResult = safeString(tr.result);
  if (tr.isError) {
    return `Detail: ${rawResult}`;
  }
  const tcArgs = tc?.args;
  if (tcArgs?.filePaths && Array.isArray(tcArgs.filePaths) && tcArgs.filePaths.length > 1) {
    const paths = tcArgs.filePaths.map((p: any) => typeof p === "string" ? p : (p?.path ?? String(p)));
    return `Output: Read ${paths.length} files:\n${paths.map((p) => `  ${p}`).join("\n")}`;
  }
  if (tcArgs?.edits && Array.isArray(tcArgs.edits) && tcArgs.edits.length > 0) {
    const uniquePaths = Array.from(new Set(tcArgs.edits.map((e: any) => e.filePath ?? e.path).filter(Boolean))) as string[];
    if (uniquePaths.length > 1) {
      return `Output: Edited ${uniquePaths.length} files:\n${uniquePaths.map((p) => `  ${p}`).join("\n")}`;
    }
  }
  if (tcArgs?.files && Array.isArray(tcArgs.files) && tcArgs.files.length > 1) {
    const paths = Array.from(new Set(tcArgs.files.map((f: any) => f.filePath ?? f.path).filter(Boolean))) as string[];
    return `Output: Wrote ${paths.length} files:\n${paths.map((p) => `  ${p}`).join("\n")}`;
  }
  if (tcArgs?.patches && Array.isArray(tcArgs.patches) && tcArgs.patches.length > 1) {
    const paths = Array.from(new Set(tcArgs.patches.map((p: any) => p.filePath ?? p.path).filter(Boolean))) as string[];
    return `Output: Patched ${paths.length} files:\n${paths.map((p) => `  ${p}`).join("\n")}`;
  }
  return `Output: ${rawResult.slice(0, 500)}${rawResult.length > 500 ? "..." : ""}`;
}

function getCustomToolTitle(tc: ToolCall, baseDescription: string): string {
  if (tc.name === "read" && typeof tc.args?.filePath === "string") {
    const filePath = tc.args.filePath;
    if (filePath.includes("skills") && filePath.endsWith("SKILL.md")) {
      const parts = filePath.replace(/\\/g, "/").split("/");
      const skillName = parts[parts.length - 2] || "unknown";
      return `[SKILL] Loaded instructions for: ${skillName}`;
    }
  }
  return baseDescription;
}

export function reconstructChatLines(msgs: Message[]): ChatLine[] {
  const loadedLines: ChatLine[] = [];

  const toolResultsById = new Map<string, ToolResult>();
  const toolResultsByName = new Map<string, ToolResult[]>();
  const usedResultIds = new Set<string>();

  // Pass 1: Collect all tool results across all messages
  for (const m of msgs) {
    const trList = ensureArray<ToolResult>(m.toolResults);
    for (const r of trList) {
      const callId = r.toolCallId || (r as any).tool_call_id || (r as any).tool_use_id || (r as any).id;
      if (callId) toolResultsById.set(callId, r);
      const name = r.name || (r as any).toolName;
      if (name) {
        if (!toolResultsByName.has(name)) toolResultsByName.set(name, []);
        toolResultsByName.get(name)!.push(r);
      }
    }
    if (m.role === "tool" && trList.length === 0) {
      const stringContent = m.content ? contentToString(m.content) : "";
      if (stringContent) {
        const callId = (m as any).toolCallId || (m as any).tool_call_id || (m as any).id || "";
        const name = (m as any).name || (m as any).toolName || "";
        const synthTr: ToolResult = {
          toolCallId: callId,
          name: name || "tool",
          result: stringContent,
        };
        if (callId) toolResultsById.set(callId, synthTr);
        if (name) {
          if (!toolResultsByName.has(name)) toolResultsByName.set(name, []);
          toolResultsByName.get(name)!.push(synthTr);
        }
      }
    }
  }

  // Pass 2: Reconstruct ChatLines
  for (let mIdx = 0; mIdx < msgs.length; mIdx++) {
    const m = msgs[mIdx];
    const stringContent = m.content ? contentToString(m.content) : "";

    if (m.role === "user") {
      if (stringContent.startsWith("[RMemory Agent Memory Context]:")) {
        continue;
      }
      loadedLines.push({
        type: "user",
        content: `❯ ${stringContent}`,
        timestamp: m.timestamp,
      });
    } else if (m.role === "system") {
      if (stringContent && stringContent.startsWith("[ERROR]")) {
        loadedLines.push({
          type: "error",
          content: stringContent.replace("[ERROR]", "").trim(),
          timestamp: m.timestamp,
        });
      } else if (stringContent) {
        loadedLines.push({
          type: "system",
          content: stringContent,
          timestamp: m.timestamp,
        });
      }
    } else if (m.role === "assistant") {
      const tcList = ensureArray<ToolCall>(m.toolCalls);
      const msgTrList = ensureArray<ToolResult>(m.toolResults);

      let assistantLine: ChatLine | null = null;
      if (stringContent) {
        assistantLine = {
          type: "assistant",
          content: stringContent,
          timestamp: m.timestamp,
          reasoning: m.reasoning,
          children: [],
        };
      } else if (tcList.length > 0) {
        assistantLine = {
          type: "assistant",
          content: "",
          timestamp: m.timestamp,
          reasoning: m.reasoning,
          children: [],
        };
      }

      if (assistantLine) {
        if (tcList.length > 0) {
          for (const tc of tcList) {
            const baseDescription = getToolDescription(tc);
            const customTitle = getCustomToolTitle(tc, baseDescription);
            const prefixEmoji = tc.name === "read" && typeof tc.args?.filePath === "string" && tc.args.filePath.endsWith("SKILL.md") ? "📖" : "⚡";
            const toolStartChild: ChatLine = {
              type: "tool_start",
              content: `${prefixEmoji} ${customTitle}\n   Detail: ${tc.name}(${formatArgs(tc.args)})`,
              timestamp: m.timestamp,
            };

            // Locate matching result
            let tr = msgTrList.find(
              (r) => (r.toolCallId && (r.toolCallId === tc.id || r.toolCallId === (tc as any).tool_call_id)) || (r.name && r.name === tc.name)
            );
            if (!tr && tc.id) {
              tr = toolResultsById.get(tc.id);
            }
            if (!tr && (tc as any).tool_call_id) {
              tr = toolResultsById.get((tc as any).tool_call_id);
            }
            if (!tr && tc.name && toolResultsByName.has(tc.name)) {
              const list = toolResultsByName.get(tc.name)!;
              const unused = list.find((item) => {
                const id = item.toolCallId || (item as any).tool_call_id;
                return !id || !usedResultIds.has(id);
              });
              if (unused) tr = unused;
            }

            if (tr) {
              const trId = tr.toolCallId || (tr as any).tool_call_id;
              if (trId) usedResultIds.add(trId);
              const resultContent = formatToolResultContent(tc, tr);
              toolStartChild.mergedResult = {
                isError: !!tr.isError,
                content: resultContent,
                description: customTitle,
              };
            }

            assistantLine.children!.push(toolStartChild);
          }
        }
        loadedLines.push(assistantLine);
      }
    } else if (m.role === "tool") {
      // Check for standalone tool results not attached to a preceding assistant line
      const trList = ensureArray<ToolResult>(m.toolResults);
      for (const tr of trList) {
        const trId = tr.toolCallId || (tr as any).tool_call_id;
        if (trId && usedResultIds.has(trId)) {
          continue; // Already associated
        }
        if (trId) usedResultIds.add(trId);
        const description = tr.name ? `Tool execution: ${tr.name}` : "Tool execution";
        const resultContent = formatToolResultContent(undefined, tr);
        const toolStartChild: ChatLine = {
          type: "tool_start",
          content: `⚡ ${description}\n   Detail: ${tr.name || "tool"}()`,
          timestamp: m.timestamp,
          mergedResult: {
            isError: !!tr.isError,
            content: resultContent,
            description,
          },
        };

        // Attach to the last assistant line if one exists, otherwise create a standalone assistant line
        const lastLine = loadedLines.length > 0 ? loadedLines[loadedLines.length - 1] : null;
        if (lastLine && lastLine.type === "assistant") {
          if (!lastLine.children) lastLine.children = [];
          lastLine.children.push(toolStartChild);
        } else {
          loadedLines.push({
            type: "assistant",
            content: "",
            timestamp: m.timestamp,
            children: [toolStartChild],
          });
        }
      }
    }
  }

  return loadedLines;
}

export function reconstructDashboardLogs(msgs: Message[]): string[] {
  const loadedLogs: string[] = [];
  const toolResultsById = new Map<string, ToolResult>();
  const toolResultsByName = new Map<string, ToolResult[]>();
  const usedResultIds = new Set<string>();

  // Pass 1: Collect all tool results
  for (const m of msgs) {
    const trList = ensureArray<ToolResult>(m.toolResults);
    for (const r of trList) {
      const callId = r.toolCallId || (r as any).tool_call_id || (r as any).tool_use_id || (r as any).id;
      if (callId) toolResultsById.set(callId, r);
      const name = r.name || (r as any).toolName;
      if (name) {
        if (!toolResultsByName.has(name)) toolResultsByName.set(name, []);
        toolResultsByName.get(name)!.push(r);
      }
    }
    if (m.role === "tool" && trList.length === 0) {
      const stringContent = m.content ? contentToString(m.content) : "";
      if (stringContent) {
        const callId = (m as any).toolCallId || (m as any).tool_call_id || (m as any).id || "";
        const name = (m as any).name || (m as any).toolName || "";
        const synthTr: ToolResult = {
          toolCallId: callId,
          name: name || "tool",
          result: stringContent,
        };
        if (callId) toolResultsById.set(callId, synthTr);
        if (name) {
          if (!toolResultsByName.has(name)) toolResultsByName.set(name, []);
          toolResultsByName.get(name)!.push(synthTr);
        }
      }
    }
  }

  // Pass 2: Reconstruct log events
  for (const m of msgs) {
    const stringContent = m.content ? contentToString(m.content) : "";
    if (m.role === "user") {
      if (stringContent.startsWith("[RMemory Agent Memory Context]:")) {
        continue;
      }
      const skillPrefixMatch = stringContent.match(
        /^I would like you to use the following skill:\s*"(.*?)"\.\nPlease read its instruction file at\s*"(.*?)"/
      );
      if (skillPrefixMatch) {
        loadedLogs.push(`[USER] 🛠️ [SKILL USE] ${skillPrefixMatch[1]} (${skillPrefixMatch[2]})`);
      } else {
        loadedLogs.push(`[USER] ${stringContent}`);
      }
    } else if (m.role === "assistant") {
      if (m.reasoning && m.reasoning.trim()) {
        loadedLogs.push(`[REASONING]${m.reasoning}`);
      }

      const tcList = ensureArray<ToolCall>(m.toolCalls);
      const msgTrList = ensureArray<ToolResult>(m.toolResults);

      if (tcList.length > 0) {
        for (const tc of tcList) {
          const baseDescription = getToolDescription(tc);
          const description = getCustomToolTitle(tc, baseDescription);
          loadedLogs.push(`[TOOL START] ${description}`);

          // Find matching result
          let tr = msgTrList.find(
            (r) => (r.toolCallId && (r.toolCallId === tc.id || r.toolCallId === (tc as any).tool_call_id)) || (r.name && r.name === tc.name)
          );
          if (!tr && tc.id) {
            tr = toolResultsById.get(tc.id);
          }
          if (!tr && (tc as any).tool_call_id) {
            tr = toolResultsById.get((tc as any).tool_call_id);
          }
          if (!tr && tc.name && toolResultsByName.has(tc.name)) {
            const list = toolResultsByName.get(tc.name)!;
            const unused = list.find((item) => {
              const id = item.toolCallId || (item as any).tool_call_id;
              return !id || !usedResultIds.has(id);
            });
            if (unused) tr = unused;
          }

          if (tr) {
            const trId = tr.toolCallId || (tr as any).tool_call_id;
            if (trId) usedResultIds.add(trId);

            const status = tr.isError ? "Failed" : "Completed";
            const prefix = tr.isError ? "✗" : "✓";
            const rawResult = safeString(tr.result);
            const snippet = rawResult.slice(0, 500) + (rawResult.length > 500 ? "..." : "");
            const resultStr = tr.isError
              ? `${prefix} ${status} - ${description}\nDetail: ${rawResult}`
              : `${prefix} ${status} - ${description}\nOutput: ${snippet}`;
            loadedLogs.push(`[TOOL END] ${resultStr}`);
          } else {
            loadedLogs.push(`[TOOL END] ✓ Completed - ${description}`);
          }
        }
      }

      if (stringContent) {
        loadedLogs.push(`[AGENT] ${stringContent}`);
      }
    } else if (m.role === "system") {
      if (stringContent && stringContent.startsWith("[ERROR]")) {
        loadedLogs.push(stringContent);
      } else if (stringContent) {
        loadedLogs.push(`[MASTER] ${stringContent}`);
      }
    } else if (m.role === "tool") {
      const trList = ensureArray<ToolResult>(m.toolResults);
      for (const tr of trList) {
        const trId = tr.toolCallId || (tr as any).tool_call_id;
        if (trId && usedResultIds.has(trId)) {
          continue;
        }
        if (trId) usedResultIds.add(trId);
        const description = tr.name ? `Tool execution: ${tr.name}` : "Tool execution";
        loadedLogs.push(`[TOOL START] ${description}`);
        const status = tr.isError ? "Failed" : "Completed";
        const prefix = tr.isError ? "✗" : "✓";
        const rawResult = safeString(tr.result);
        const snippet = rawResult.slice(0, 500) + (rawResult.length > 500 ? "..." : "");
        const resultStr = tr.isError
          ? `${prefix} ${status} - ${description}\nDetail: ${rawResult}`
          : `${prefix} ${status} - ${description}\nOutput: ${snippet}`;
        loadedLogs.push(`[TOOL END] ${resultStr}`);
      }
    }
  }

  return loadedLogs;
}


