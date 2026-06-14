import React from "react";
import { Box, Text } from "ink";
import { renderLogInlineStyles } from "../components/dashboard/inspector-panel.js";
import { wrapTextForDisplay } from "./responseScroll.js";
import { AgentSession } from "../components/multi-agent-dashboard.js";

interface LogGroup {
  isBox: boolean;
  label: string;
  color: string;
  isBold: boolean;
  dimColor: boolean;
  parseMarkdown: boolean;
  noTruncate?: boolean;
  rawLines: string[];
}

export function computeWrappedLogs(
  selectedSession: AgentSession,
  feedWidth: number,
  isHistoryTruncated: boolean
): React.ReactNode[] {
  const wrappedLines: React.ReactNode[] = [];
  const activeLogs = selectedSession.logs.map(l => l.trim()).filter(Boolean);

  const groups: LogGroup[] = [];
  for (let logIdx = 0; logIdx < activeLogs.length; logIdx++) {
    const logStr = activeLogs[logIdx];
    const isBoxLine = /^[┌├│└─]/.test(logStr);

    if (isBoxLine) {
      groups.push({
        isBox: true,
        label: "",
        color: selectedSession.type === "SUBAGENT" ? "green" : "gray",
        isBold: false,
        dimColor: false,
        parseMarkdown: false,
        rawLines: [logStr],
      });
      continue;
    }

    let label = "INFO";
    let content = logStr;
    let color = "green";
    let isBold = false;
    let dimColor = false;
    let parseMarkdown = false;
    let noTruncate = false;

    if (logStr.startsWith("[USER]")) {
      label = "👤 USER";
      content = logStr.replace("[USER]", "").trim();
      color = "cyan";
      isBold = true;
    } else if (logStr.startsWith("[MASTER]")) {
      label = "🤖 SYSTEM";
      content = logStr.replace("[MASTER]", "").trim();
      color = "yellow";
      dimColor = true;
    } else if (logStr.startsWith("[AGENT]")) {
      label = "🧠 AGENT";
      content = logStr.replace("[AGENT]", "").trim();
      color = "white";
      isBold = false;
      parseMarkdown = true;
    } else if (logStr.startsWith("[TOOL START]")) {
      label = "🔧 TOOL START";
      content = logStr.replace("[TOOL START]", "").trim();
      color = "magenta";
      noTruncate = true;
    } else if (logStr.startsWith("[TOOL END]")) {
      label = "✅ TOOL DONE";
      content = logStr.replace("[TOOL END]", "").trim();
      color = "gray";
      noTruncate = true;
    } else if (logStr.startsWith("[ERROR]")) {
      label = "🚨 ERROR";
      content = logStr.replace("[ERROR]", "").trim();
      color = "red";
      isBold = true;
      noTruncate = true;
    } else if (logStr.startsWith("[AUTO-APPROVE]")) {
      label = "⚙️ AUTO-APPROVE";
      content = logStr.replace("[AUTO-APPROVE]", "").trim();
      color = "blue";
      dimColor = true;
    } else if (logStr.startsWith("[QUESTION]")) {
      label = "❓ QUESTION";
      content = logStr.replace("[QUESTION]", "").trim();
      color = "magenta";
    } else if (logStr.startsWith("[THINK]")) {
      label = "🧠 THINK";
      content = logStr.replace("[THINK]", "").trim();
      color = "magenta";
      dimColor = true;
      parseMarkdown = true;
    } else if (logStr.startsWith("[TOOL:START]")) {
      label = "🔧 TOOL START";
      content = logStr.replace("[TOOL:START]", "").trim();
      color = "cyan";
      noTruncate = true;
    } else if (logStr.startsWith("[TOOL:OK]")) {
      label = "✅ TOOL OK";
      content = logStr.replace("[TOOL:OK]", "").trim();
      color = "gray";
      dimColor = true;
      noTruncate = true;
    } else if (logStr.startsWith("[TOOL:FAIL]")) {
      label = "🚨 TOOL FAIL";
      content = logStr.replace("[TOOL:FAIL]", "").trim();
      color = "red";
      isBold = true;
      noTruncate = true;
    }

    const lastGroup = groups[groups.length - 1];
    if (
      lastGroup &&
      !lastGroup.isBox &&
      lastGroup.label === label &&
      lastGroup.color === color &&
      lastGroup.isBold === isBold &&
      lastGroup.dimColor === dimColor &&
      lastGroup.parseMarkdown === parseMarkdown &&
      lastGroup.noTruncate === noTruncate
    ) {
      lastGroup.rawLines.push(content);
    } else {
      groups.push({
        isBox: false,
        label,
        color,
        isBold,
        dimColor,
        parseMarkdown,
        noTruncate,
        rawLines: [content],
      });
    }
  }

  for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
    const group = groups[groupIdx];
    const useTruncate = isHistoryTruncated && !group.parseMarkdown && !group.noTruncate;

    if (group.isBox) {
      for (const logStr of group.rawLines) {
        const cleanedLogStr = logStr.replace(/\r\n/g, "\n").replace(/\r/g, "");
        const subLines = useTruncate
          ? cleanedLogStr.split("\n")
          : wrapTextForDisplay(cleanedLogStr, feedWidth);
        for (let i = 0; i < subLines.length; i++) {
          const lineText = subLines[i];
          wrappedLines.push(
            <Box flexDirection="row" key={`log-line-${groupIdx}-${i}`} width={feedWidth}>
              <Text color={group.color} wrap={useTruncate ? "truncate-end" : undefined}>{lineText}</Text>
            </Box>
          );
        }
      }
      continue;
    }

    const prefix = groupIdx === 0 ? "┌───" : (groupIdx === groups.length - 1 ? "└───" : "├───");
    const subLinePrefix = groupIdx === groups.length - 1 ? "    " : "│   ";

    wrappedLines.push(
      <Box flexDirection="row" key={`log-header-${groupIdx}`} width={feedWidth}>
        <Text color={group.color === "gray" ? "gray" : group.color} bold wrap={useTruncate ? "truncate-end" : undefined}>
          {prefix} <Text color="white" bold>[ </Text>
          <Text color={group.color === "gray" ? "gray" : group.color} bold>{group.label}</Text>
          <Text color="white" bold> ]</Text>
        </Text>
      </Box>
    );

    let inCode = false;
    for (let rawLineIdx = 0; rawLineIdx < group.rawLines.length; rawLineIdx++) {
      const content = group.rawLines[rawLineIdx];
      const cleanedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "");
      const subLines = useTruncate
        ? cleanedContent.split("\n")
        : wrapTextForDisplay(cleanedContent, Math.max(10, feedWidth - 8));

      for (let i = 0; i < subLines.length; i++) {
        const lineText = subLines[i];
        const trimmed = lineText.trim();

        if (group.parseMarkdown) {
          if (trimmed.startsWith("```")) {
            inCode = !inCode;
            const codeLang = trimmed.slice(3).trim() || "TEXT";
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
                <Text color="gray" italic wrap={useTruncate ? "truncate-end" : undefined}>{inCode ? `┌─── [ CODE: ${codeLang} ]` : "└─── [ END CODE ]"}</Text>
              </Box>
            );
            continue;
          }

          if (inCode) {
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}│  </Text>
                <Text color="green" wrap={useTruncate ? "truncate-end" : undefined}>{lineText}</Text>
              </Box>
            );
            continue;
          }

          if (trimmed.startsWith("# ")) {
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
                <Text bold color="yellow" wrap={useTruncate ? "truncate-end" : undefined}>{lineText.slice(2)}</Text>
              </Box>
            );
            continue;
          }
          if (trimmed.startsWith("## ")) {
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
                <Text bold color="cyan" wrap={useTruncate ? "truncate-end" : undefined}>{lineText.slice(3)}</Text>
              </Box>
            );
            continue;
          }
          if (trimmed.startsWith("### ")) {
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
                <Text bold color="blue" wrap={useTruncate ? "truncate-end" : undefined}>{lineText.slice(4)}</Text>
              </Box>
            );
            continue;
          }

          let listPrefix = "";
          let remainingLine = lineText;
          if (trimmed.startsWith("- ")) {
            const indent = lineText.indexOf("- ");
            listPrefix = " ".repeat(indent) + "• ";
            remainingLine = lineText.slice(indent + 2);
          } else if (trimmed.startsWith("* ")) {
            const indent = lineText.indexOf("* ");
            listPrefix = " ".repeat(indent) + "• ";
            remainingLine = lineText.slice(indent + 2);
          } else if (/^\d+\.\s/.test(trimmed)) {
            const match = lineText.match(/^(\s*)(\d+\.\s)(.*)/);
            if (match) {
              listPrefix = match[1] + match[2];
              remainingLine = match[3];
            }
          }

          wrappedLines.push(
            <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
              <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
              {listPrefix ? <Text color="magenta" bold>{listPrefix}</Text> : null}
              <Box flexShrink={1}>
                <Text wrap={useTruncate ? "truncate-end" : undefined}>
                  {renderLogInlineStyles(remainingLine, group.color === "gray" ? "gray" : group.color, group.isBold, group.dimColor)}
                </Text>
              </Box>
            </Box>
          );
        } else {
          wrappedLines.push(
            <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
              <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
              <Text color={group.color === "gray" ? "gray" : group.color} bold={group.isBold} dimColor={group.dimColor} wrap={useTruncate ? "truncate-end" : undefined}>{lineText}</Text>
            </Box>
          );
        }
      }
    }

    if (groupIdx < groups.length - 1) {
      wrappedLines.push(
        <Box flexDirection="row" key={`log-sep-${groupIdx}`}>
          <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{subLinePrefix}</Text>
        </Box>
      );
    }
  }

  return wrappedLines;
}
