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
  /** Group index (position in the groups array) for collapsible tracking */
  groupIndex?: number;
  /** Nesting level: 0 = top-level, 1 = nested under parent agent message */
  nestLevel?: number;
  /** Merged result from TOOL:OK/FAIL patched onto the preceding TOOL:START group */
  mergedResult?: { isError: boolean; lines: string[] };
}

/** Labels that are collapsible in the multi-agent log view */
const COLLAPSIBLE_LABELS = new Set([
  "🔧 TOOL START",
  "✅ TOOL DONE",
  "✅ TOOL OK",
  "🚨 TOOL FAIL",
  "🧠 THINK",
  "⚙️ AUTO-APPROVE",
  "🔧 TOOL START",
]);

/** Returns true if the given label is collapsible */
export function isCollapsibleLabel(label: string): boolean {
  return COLLAPSIBLE_LABELS.has(label);
}

export interface LogGroupInfo {
  groupIndex: number;
  startLine: number;
  endLine: number;
  label: string;
  isCollapsible: boolean;
}

/** Compute group boundaries for click detection in the multi-agent dashboard */
export function computeLogGroupBoundaries(
  selectedSession: AgentSession,
  feedWidth: number,
  isHistoryTruncated: boolean,
  expandedGroups: Set<number>
): LogGroupInfo[] {
  const activeLogs = selectedSession.logs.map(l => l.trim()).filter(Boolean);
  const groups: LogGroup[] = [];
  for (let logIdx = 0; logIdx < activeLogs.length; logIdx++) {
    const logStr = activeLogs[logIdx];
    const isBoxLine = /^[┌├│└─]/.test(logStr);
    if (isBoxLine) {
      groups.push({ isBox: true, label: "", color: "gray", isBold: false, dimColor: false, parseMarkdown: false, rawLines: [logStr] });
      continue;
    }
    let label = "INFO";
    if (logStr.startsWith("[USER]")) label = "👤 USER";
    else if (logStr.startsWith("[MASTER]")) label = "🤖 SYSTEM";
    else if (logStr.startsWith("[AGENT]")) label = "🧠 AGENT";
    else if (logStr.startsWith("[TOOL START]") || logStr.startsWith("[TOOL:START]")) label = "🔧 TOOL START";
    else if (logStr.startsWith("[TOOL END]") || logStr.startsWith("[TOOL:OK]")) label = "✅ TOOL DONE";
    else if (logStr.startsWith("[TOOL:FAIL]")) label = "🚨 TOOL FAIL";
    else if (logStr.startsWith("[ERROR]")) label = "🚨 ERROR";
    else if (logStr.startsWith("[AUTO-APPROVE]")) label = "⚙️ AUTO-APPROVE";
    else if (logStr.startsWith("[QUESTION]")) label = "❓ QUESTION";
    else if (logStr.startsWith("[THINK]")) label = "🧠 THINK";

    const lastGroup = groups[groups.length - 1];
    if (lastGroup && !lastGroup.isBox && lastGroup.label === label) {
      lastGroup.rawLines.push(logStr);
    } else {
      groups.push({ isBox: false, label, color: "gray", isBold: false, dimColor: false, parseMarkdown: false, rawLines: [logStr] });
    }
  }

  // Assign group indexes
  groups.forEach((g, i) => { g.groupIndex = i; });

  // Nest TOOL groups under the preceding AGENT group (visual nesting)
  for (let gi = 1; gi < groups.length; gi++) {
    const g = groups[gi];
    if (g.isBox) continue;
    const isToolGroup = g.label.includes("TOOL") || g.label.includes("AUTO-APPROVE");
    if (!isToolGroup) continue;
    // Look back for the nearest non-box, non-tool group
    for (let j = gi - 1; j >= 0; j--) {
      const prev = groups[j];
      if (prev.isBox) continue;
      const isPrevTool = prev.label.includes("TOOL") || prev.label.includes("AUTO-APPROVE");
      if (isPrevTool) continue;
      if (prev.label === "🧠 AGENT" || prev.label === "👤 USER") {
        g.nestLevel = 1;
      }
      break;
    }
  }

  const boundaries: LogGroupInfo[] = [];
  let currentLine = 0;

  for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
    const group = groups[groupIdx];
    const isCollapsible = !group.isBox && isCollapsibleLabel(group.label);
    const isCollapsed = isCollapsible && !expandedGroups.has(groupIdx);
    const isTool = (group.label.includes("TOOL") || group.label.includes("AUTO-APPROVE")) && (group.nestLevel || 0) > 0;

    if (group.isBox) {
      const lineCount = group.rawLines.length;
      boundaries.push({ groupIndex: groupIdx, startLine: currentLine, endLine: currentLine + lineCount - 1, label: group.label, isCollapsible: false });
      currentLine += lineCount;
      continue;
    }

    if (isCollapsed) {
      // Collapsed = 1 line (compact header)
      boundaries.push({ groupIndex: groupIdx, startLine: currentLine, endLine: currentLine, label: group.label, isCollapsible: true });
      currentLine += 1;
    } else {
      // Expanded: header + content lines + separator
      let lineCount = 1; // header
      let firstLine = true;
      for (const rawLine of group.rawLines) {
        const cleaned = rawLine.replace(/\r\n/g, "\n").replace(/\r/g, "");
        const subLines = isHistoryTruncated
          ? cleaned.split("\n")
          : wrapTextForDisplay(cleaned, Math.max(10, feedWidth - (isTool ? 14 : 9)));
        if (isTool && firstLine && subLines.length > 0) {
          // The first line of content is rendered inline in the header line
          lineCount += subLines.length - 1;
          firstLine = false;
        } else {
          lineCount += subLines.length;
        }
      }
      const nextGroup = groups[groupIdx + 1];
      const nextIsNested = nextGroup && (nextGroup.nestLevel || 0) > 0;
      if (groupIdx < groups.length - 1 && !nextIsNested) lineCount += 1; // separator
      boundaries.push({ groupIndex: groupIdx, startLine: currentLine, endLine: currentLine + lineCount - 1, label: group.label, isCollapsible: true });
      currentLine += lineCount;
    }
  }

  return boundaries;
}

export function computeWrappedLogs(
  selectedSession: AgentSession,
  feedWidth: number,
  isHistoryTruncated: boolean,
  expandedGroups?: Set<number>
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
      color = "blue";
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
      color = "blue";
    } else if (logStr.startsWith("[THINK]")) {
      label = "🧠 THINK";
      content = logStr.replace("[THINK]", "").trim();
      color = "blue";
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

  // Nest TOOL groups under the preceding AGENT group (visual nesting)
  for (let gi = 1; gi < groups.length; gi++) {
    const g = groups[gi];
    if (g.isBox) continue;
    const isToolGroup = g.label.includes("TOOL") || g.label.includes("AUTO-APPROVE");
    if (!isToolGroup) continue;
    // Look back for the nearest non-box, non-tool group
    for (let j = gi - 1; j >= 0; j--) {
      const prev = groups[j];
      if (prev.isBox) continue;
      const isPrevTool = prev.label.includes("TOOL") || prev.label.includes("AUTO-APPROVE");
      if (isPrevTool) continue;
      if (prev.label === "🧠 AGENT" || prev.label === "👤 USER") {
        g.nestLevel = 1;
      }
      break;
    }
  }

  // Merge TOOL:START + TOOL:OK/FAIL pairs into a single group
  // The result group is absorbed into the start group as mergedResult, then removed
  const mergedGroups: LogGroup[] = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const isStart = g.label === "🔧 TOOL START";
    const next = groups[gi + 1];
    if (
      isStart &&
      next &&
      !next.isBox &&
      (next.label === "✅ TOOL OK" || next.label === "✅ TOOL DONE" || next.label === "🚨 TOOL FAIL")
    ) {
      // Absorb next group as mergedResult on current TOOL:START group
      const isError = next.label.includes("FAIL");
      mergedGroups.push({ ...g, mergedResult: { isError, lines: next.rawLines } });
      gi++; // Skip the TOOL:OK/FAIL group
    } else {
      mergedGroups.push(g);
    }
  }
  // Replace groups with merged result
  groups.length = 0;
  groups.push(...mergedGroups);

  for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
    const group = groups[groupIdx];
    const useTruncate = isHistoryTruncated && !group.parseMarkdown && !group.noTruncate;
    const nestPrefix = (group.nestLevel || 0) > 0 ? "│    " : "";

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

    // Collapsed rendering for collapsible groups
    const groupIsCollapsible = isCollapsibleLabel(group.label);
    const groupIsCollapsed = groupIsCollapsible && (!expandedGroups || !expandedGroups.has(groupIdx));
    const isTool = (group.label.includes("TOOL") || group.label.includes("AUTO-APPROVE")) && (group.nestLevel || 0) > 0;

    if (groupIsCollapsed) {
      if (isTool) {
        const firstContent = group.rawLines[0] || "";
        const isAskQuestion = firstContent.includes("Asking user:");

        // ── Merged TOOL:START+OK/FAIL collapsed as single row ────────
        if (group.mergedResult && !isAskQuestion) {
          const merged = group.mergedResult;
          const statusIcon = merged.isError ? "✗" : "✓";
          const statusLabel = merged.isError ? "failed" : "done";
          const statusColor = merged.isError ? "red" : "green";
          const preview = firstContent.length > 50 ? firstContent.slice(0, 47) + "..." : firstContent;
          wrappedLines.push(
            <Box flexDirection="row" key={`log-collapsed-${groupIdx}`} width={feedWidth}>
              <Text color={group.color} dimColor={group.dimColor} wrap="truncate-end">
                {nestPrefix}    <Text bold color="cyan">↳ ⚙️ </Text><Text color={group.color}>{preview}</Text>
                <Text bold color={statusColor}> {statusIcon} {statusLabel}</Text>
                <Text dimColor italic>  (click to expand)</Text>
              </Text>
            </Box>
          );
          continue;
        }

        if (isAskQuestion) {
          const isStart = group.label.includes("TOOL START");
          const isError = group.label.includes("FAIL");
          if (isStart) {
            const question = firstContent.replace(/^⚡\s*Asking user:\s*/i, "").replace(/^Asking user:\s*/i, "").trim();
            wrappedLines.push(
              <Box flexDirection="row" key={`log-collapsed-${groupIdx}`} width={feedWidth}>
                <Text color={group.color} dimColor={group.dimColor} wrap="truncate-end">
                  {nestPrefix}    <Text bold color={group.color}>↳ ❓ Question: </Text><Text color={group.color}>{question}</Text>
                </Text>
              </Box>
            );
          } else {
            const question = firstContent.replace(/^[✓✗]\s*(Completed|Failed)\s*-\s*Asking user:\s*/i, "").replace(/^Asking user:\s*/i, "").trim();
            const outputLine = group.rawLines.find(l => l.trim().startsWith("Output:"));
            const answer = outputLine ? outputLine.replace(/^\s*Output:\s*/i, "").trim() : "";
            wrappedLines.push(
              <Box flexDirection="row" key={`log-collapsed-${groupIdx}`} width={feedWidth}>
                <Text color={group.color} dimColor={group.dimColor} wrap="truncate-end">
                  {nestPrefix}    <Text bold color={group.color}>{isError ? "↳ ✗ " : "↳ ✓ "}</Text><Text bold color={group.color}>Question: </Text><Text color={group.color}>{question}</Text><Text bold color={group.color}> | Answer: </Text><Text color={group.color}>{answer || "N/A"}</Text>
                </Text>
              </Box>
            );
          }
          continue;
        }

        const icon = group.label.includes("TOOL START") ? "⚙️ " :
                     group.label.includes("FAIL") ? "✗ " : "✓ ";
        const preview = firstContent.length > 50 ? firstContent.slice(0, 47) + "..." : firstContent;
        wrappedLines.push(
          <Box flexDirection="row" key={`log-collapsed-${groupIdx}`} width={feedWidth}>
            <Text color={group.color} dimColor={group.dimColor} wrap="truncate-end">
              {nestPrefix}    <Text bold color={group.color}>↳ {icon}</Text><Text color={group.color}>{preview}</Text> <Text dimColor italic>{group.label.includes("FAIL") ? "(click to view error)" : group.label.includes("START") ? "(click to view inputs)" : "(click to view output)"}</Text>
            </Text>
          </Box>
        );
        continue;
      }

      const prefix = nestPrefix + (groupIdx === 0 ? "┌───" : (groupIdx === groups.length - 1 ? "└───" : "├───"));
      const firstContent = group.rawLines[0] || "";
      const preview = firstContent.length > 50 ? firstContent.slice(0, 47) + "..." : firstContent;
      const icon = group.label.includes("TOOL START") ? "⚙️" :
                   group.label.includes("TOOL") && group.label.includes("DONE") ? "✅" :
                   group.label.includes("TOOL") && group.label.includes("OK") ? "✅" :
                   group.label.includes("FAIL") ? "🚨" :
                   group.label.includes("THINK") ? "🧠" :
                   group.label.includes("AUTO") ? "⚙️" : "▶";
      wrappedLines.push(
        <Box flexDirection="row" key={`log-collapsed-${groupIdx}`} width={feedWidth}>
          <Text color={group.color} dimColor wrap="truncate-end">
            {prefix} [ <Text bold color={group.color}>▶ {icon} {group.label}</Text> ] <Text dimColor>{preview}</Text> <Text italic dimColor>click to expand</Text>
          </Text>
        </Box>
      );
      continue;
    }

    const prefix = nestPrefix + (groupIdx === 0 ? "┌───" : (groupIdx === groups.length - 1 ? "└───" : "├───"));
    const subLinePrefix = nestPrefix + (groupIdx === groups.length - 1 ? "     " : "│    ");

    if (isTool) {
      const merged = group.mergedResult;
      const mergedColor = merged?.isError ? "red" : "green";
      const mergedIcon = merged?.isError ? "✗" : "✓";
      const icon = "\u2699\ufe0f ";
      const firstContent = group.rawLines[0] || "";
      const cleaned = firstContent.replace(/\r\n/g, "\n").replace(/\r/g, "");
      const firstLineText = cleaned.split("\n")[0] || "";
      wrappedLines.push(
        <Box flexDirection="row" key={`log-header-${groupIdx}`} width={feedWidth}>
          <Text color={group.color} bold={group.isBold} dimColor={group.dimColor} wrap={useTruncate ? "truncate-end" : undefined}>
            {nestPrefix}    <Text bold color={group.color}>▼ {icon}</Text><Text color={group.color}>{firstLineText}</Text>
            {merged && <Text bold color={mergedColor}> {mergedIcon}</Text>}
            <Text dimColor italic> (click to collapse)</Text>
          </Text>
        </Box>
      );
      // Render remaining input lines
    } else {
      wrappedLines.push(
        <Box flexDirection="row" key={`log-header-${groupIdx}`} width={feedWidth}>
          <Text color={group.color === "gray" ? "gray" : group.color} bold wrap={useTruncate ? "truncate-end" : undefined}>
            {prefix} <Text color="white" bold>[ </Text>
            <Text color={group.color === "gray" ? "gray" : group.color} bold>{group.label}</Text>
            <Text color="white" bold> ]</Text>
          </Text>
          {groupIsCollapsible && <Text dimColor italic> click to collapse</Text>}
        </Box>
      );
    }

    let inCode = false;
    for (let rawLineIdx = 0; rawLineIdx < group.rawLines.length; rawLineIdx++) {
      const content = group.rawLines[rawLineIdx];
      const cleanedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "");
      const subLines = useTruncate
        ? cleanedContent.split("\n")
        : wrapTextForDisplay(cleanedContent, Math.max(10, feedWidth - (isTool ? 14 : 9)));

      for (let i = 0; i < subLines.length; i++) {
        if (isTool && rawLineIdx === 0 && i === 0) {
          continue; // Rendered in header
        }
        const lineText = subLines[i];
        const trimmed = lineText.trim();
        const activeSubLinePrefix = isTool ? subLinePrefix + "    " : subLinePrefix;

        if (group.parseMarkdown) {
          if (trimmed.startsWith("```")) {
            inCode = !inCode;
            const codeLang = trimmed.slice(3).trim() || "TEXT";
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{activeSubLinePrefix}</Text>
                <Text color="gray" italic wrap={useTruncate ? "truncate-end" : undefined}>{inCode ? `┌─── [ CODE: ${codeLang} ]` : "└─── [ END CODE ]"}</Text>
              </Box>
            );
            continue;
          }

          if (inCode) {
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{activeSubLinePrefix}│  </Text>
                <Text color="green" wrap={useTruncate ? "truncate-end" : undefined}>{lineText}</Text>
              </Box>
            );
            continue;
          }

          if (trimmed.startsWith("# ")) {
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{activeSubLinePrefix}</Text>
                <Text bold color="yellow" wrap={useTruncate ? "truncate-end" : undefined}>{lineText.slice(2)}</Text>
              </Box>
            );
            continue;
          }
          if (trimmed.startsWith("## ")) {
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{activeSubLinePrefix}</Text>
                <Text bold color="cyan" wrap={useTruncate ? "truncate-end" : undefined}>{lineText.slice(3)}</Text>
              </Box>
            );
            continue;
          }
          if (trimmed.startsWith("### ")) {
            wrappedLines.push(
              <Box flexDirection="row" key={`log-line-${groupIdx}-${rawLineIdx}-${i}`} width={feedWidth}>
                <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{activeSubLinePrefix}</Text>
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
              <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{activeSubLinePrefix}</Text>
              {listPrefix ? <Text color="blue" bold>{listPrefix}</Text> : null}
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
              <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{activeSubLinePrefix}</Text>
              <Text color={group.color === "gray" ? "gray" : group.color} bold={group.isBold} dimColor={group.dimColor} wrap={useTruncate ? "truncate-end" : undefined}>{lineText}</Text>
            </Box>
          );
        }
      }
    }

    // Render merged output lines (TOOL:OK/FAIL) after the input content
    if (isTool && group.mergedResult) {
      const merged = group.mergedResult;
      const mergedColor = merged.isError ? "red" : "green";
      const outputSubLinePrefix = subLinePrefix + "    ";
      // Divider
      wrappedLines.push(
        <Box flexDirection="row" key={`log-divider-${groupIdx}`} width={feedWidth}>
          <Text color={mergedColor} dimColor>{outputSubLinePrefix}{"─".repeat(28)}</Text>
        </Box>
      );
      for (let mi = 0; mi < merged.lines.length; mi++) {
        const content = merged.lines[mi];
        const cleanedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "");
        const subLines = wrapTextForDisplay(cleanedContent, Math.max(10, feedWidth - 18));
        for (let i = 0; i < subLines.length; i++) {
          const lineText = subLines[i];
          wrappedLines.push(
            <Box flexDirection="row" key={`log-merged-${groupIdx}-${mi}-${i}`} width={feedWidth}>
              <Text color={mergedColor} dimColor={!merged.isError}>{outputSubLinePrefix}</Text>
              <Text color={merged.isError ? "white" : "gray"} dimColor={!merged.isError} wrap={useTruncate ? "truncate-end" : undefined}>{lineText}</Text>
            </Box>
          );
        }
      }
    }

    const nextGroup = groups[groupIdx + 1];
    const nextIsNested = nextGroup && (nextGroup.nestLevel || 0) > 0;
    if (groupIdx < groups.length - 1 && !nextIsNested) {
      wrappedLines.push(
        <Box flexDirection="row" key={`log-sep-${groupIdx}`}>
          <Text color={group.color === "gray" ? "gray" : group.color} dimColor={group.dimColor}>{isTool ? subLinePrefix + "    " : subLinePrefix}</Text>
        </Box>
      );
    }
  }


  return wrappedLines;
}
