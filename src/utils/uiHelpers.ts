import type { ChatLine } from "../core/commands/types.js";
import type { Message, ToolResult } from "../core/conversation.js";
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

export function reconstructChatLines(msgs: Message[]): ChatLine[] {
  const loadedLines: ChatLine[] = [];

  // Map to store all tool results by their toolCallId
  const toolResultsMap = new Map<string, ToolResult>();
  for (const m of msgs) {
    if (m.toolResults) {
      for (const r of m.toolResults) {
        toolResultsMap.set(r.toolCallId, r);
      }
    }
  }

  for (const m of msgs) {
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
      let assistantLine: ChatLine | null = null;
      if (stringContent) {
        assistantLine = {
          type: "assistant",
          content: stringContent,
          timestamp: m.timestamp,
          reasoning: m.reasoning,
          children: [],
        };
      } else if (m.toolCalls && m.toolCalls.length > 0) {
        assistantLine = {
          type: "assistant",
          content: "",
          timestamp: m.timestamp,
          reasoning: m.reasoning,
          children: [],
        };
      }

      if (assistantLine) {
        if (m.toolCalls && m.toolCalls.length > 0) {
          for (const tc of m.toolCalls) {
            const description = getToolDescription(tc);
            const toolStartChild: ChatLine = {
              type: "tool_start",
              content: `⚡ ${description}\n   Detail: ${tc.name}(${formatArgs(tc.args)})`,
              timestamp: m.timestamp,
            };

            const tr = toolResultsMap.get(tc.id);
            if (tr) {
              let customTitleEnd = description;
              if (tc.name === "read" && typeof tc.args?.filePath === "string") {
                const filePath = tc.args.filePath;
                if (filePath.includes("skills") && filePath.endsWith("SKILL.md")) {
                  const parts = filePath.replace(/\\/g, "/").split("/");
                  const skillName = parts[parts.length - 2] || "unknown";
                  customTitleEnd = `[SKILL] Loaded instructions for: ${skillName}`;
                }
              }
              const resultContent = tr.isError
                ? `Detail: ${tr.result}`
                : `Output: ${tr.result.slice(0, 500)}${tr.result.length > 500 ? "..." : ""}`;

              toolStartChild.mergedResult = {
                isError: !!tr.isError,
                content: resultContent,
                description: customTitleEnd,
              };
            }
            assistantLine.children!.push(toolStartChild);
          }
        }
        loadedLines.push(assistantLine);
      }
    }
  }

  return loadedLines;
}

