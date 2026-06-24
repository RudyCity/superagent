import type { ChatLine } from "../core/commands/types.js";
import type { Message, ToolResult } from "../core/conversation.js";
import { getToolDescription } from "../core/permissions.js";
import { formatArgs } from "./text.js";

export function stripSgrMouseSequences(value: string): string {
  return value.replace(/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/g, "");
}

export function getInsertion(oldVal: string, newVal: string): { prefix: string; inserted: string; suffix: string } {
  let start = 0;
  while (start < oldVal.length && start < newVal.length && oldVal[start] === newVal[start]) {
    start++;
  }
  let endOld = oldVal.length - 1;
  let endNew = newVal.length - 1;
  while (endOld >= start && endNew >= start && oldVal[endOld] === newVal[endNew]) {
    endOld--;
    endNew--;
  }
  const prefix = oldVal.slice(0, start);
  const inserted = newVal.slice(start, endNew + 1);
  const suffix = oldVal.slice(endOld + 1);
  return { prefix, inserted, suffix };
}

export function getPasteSplit(currentInput: string, prefixLen: number, suffixLen: number) {
  const prefix = currentInput.slice(0, Math.min(currentInput.length, prefixLen));
  const suffix = suffixLen > 0 ? currentInput.slice(Math.max(prefix.length, currentInput.length - suffixLen)) : "";
  const inserted = currentInput.slice(prefix.length, currentInput.length - suffix.length);
  return { prefix, inserted, suffix };
}

export function getLatestSubagentAction(logs: string[]): string {
  if (!logs || logs.length === 0) return "Initializing...";
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
        return clean.length > 80 ? clean.slice(0, 80) + "..." : clean;
      }
    }
  }
  return "Processing...";
}

export function getLatestSuperagentAction(logs: string[]): string {
  if (!logs || logs.length === 0) return "Initializing...";
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
        return clean.length > 80 ? clean.slice(0, 80) + "..." : clean;
      }
    }
  }
  return "Processing...";
}

export function truncateStreamDisplay(text: string, maxLines: number, width: number): string {
  const rawLines = text.split("\n");
  let accumulated = 0;
  const resultLines: string[] = [];

  for (let i = rawLines.length - 1; i >= 0; i--) {
    const wrappedCount = Math.max(1, Math.ceil(rawLines[i].length / width));
    if (accumulated + wrappedCount > maxLines) {
      if (resultLines.length === 0) {
        resultLines.unshift(rawLines[i]);
      } else {
        resultLines.unshift("... [older output hidden to fit screen] ...");
      }
      break;
    }
    accumulated += wrappedCount;
    resultLines.unshift(rawLines[i]);
  }
  return resultLines.join("\n");
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
    if (m.role === "user") {
      loadedLines.push({
        type: "user",
        content: `❯ ${m.content}`,
        timestamp: m.timestamp,
      });
    } else if (m.role === "system") {
      if (m.content && m.content.startsWith("[ERROR]")) {
        loadedLines.push({
          type: "error",
          content: m.content.replace("[ERROR]", "").trim(),
          timestamp: m.timestamp,
        });
      } else if (m.content) {
        loadedLines.push({
          type: "system",
          content: m.content,
          timestamp: m.timestamp,
        });
      }
    } else if (m.role === "assistant") {
      let assistantLine: ChatLine | null = null;
      if (m.content) {
        assistantLine = {
          type: "assistant",
          content: m.content,
          timestamp: m.timestamp,
          children: [],
        };
      } else if (m.toolCalls && m.toolCalls.length > 0) {
        const desc = getToolDescription(m.toolCalls[0]);
        assistantLine = {
          type: "assistant",
          content: `[SYS] Initiating action: ${desc}...`,
          timestamp: m.timestamp,
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

