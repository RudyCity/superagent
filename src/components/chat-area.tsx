import React, { useMemo, useEffect, memo } from "react";
import { Box, Text } from "ink";
import { Banner } from "./banner.js";
import { ChatLineComponent, renderMarkdown, truncateStreamDisplay, isCollapsibleType } from "./chat-line.js";
import { LoadingIndicator, ToolLoadingIndicator } from "./common/LoadingIndicators.js";
import { getTruncatedAssistantIndexes, wrapTextForDisplay, renderScrollBar, capDisplayLines } from "../utils/responseScroll.js";
import { formatCompactNumber, minimizePathInDescription } from "../utils/text.js";
import type { ChatLine } from "../core/slash-commands.js";
import type { ChatLinePosition } from "../hooks/useMouseScroll.js";

export interface WrappedChatLine {
  node: React.ReactNode;
  lineIndex: number;
  childIndex?: number;
  type: string;
  isHeader?: boolean;
  isSeparator?: boolean;
  isCollapsible?: boolean;
  isTruncated?: boolean;
}

function visibleLength(str: string): number {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").length;
}

function renderBoldTargetText(text: string): React.ReactNode {
  const regex = /(5\.\s+Struktur\s+Direktori\s+Tools|Struktur\s+Direktori\s+Tools)/gi;
  if (!regex.test(text)) {
    return text;
  }
  regex.lastIndex = 0;
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, index) => {
        if (regex.test(part)) {
          return (
            <Text key={index} bold color="yellow">
              {part}
            </Text>
          );
        }
        return part;
      })}
    </>
  );
}

export function renderInlineMarkdown(text: string, defaultColor: string = "white"): React.ReactNode {
  const parsedElements: React.ReactNode[] = [];
  let currentText = text;

  while (currentText.length > 0) {
    const boldIdx = currentText.indexOf("**");
    const codeIdx = currentText.indexOf("`");
    const linkIdx = currentText.indexOf("[");
    
    // Check for raw URLs (file:///, http://, https://)
    const fileUrlIdx = currentText.indexOf("file://");
    const httpUrlIdx = currentText.indexOf("http://");
    const httpsUrlIdx = currentText.indexOf("https://");
    
    let rawUrlIdx = -1;
    if (fileUrlIdx !== -1) rawUrlIdx = fileUrlIdx;
    if (httpUrlIdx !== -1 && (rawUrlIdx === -1 || httpUrlIdx < rawUrlIdx)) rawUrlIdx = httpUrlIdx;
    if (httpsUrlIdx !== -1 && (rawUrlIdx === -1 || httpsUrlIdx < rawUrlIdx)) rawUrlIdx = httpsUrlIdx;

    let minIdx = -1;
    let tokenType: "bold" | "code" | "link" | "rawUrl" | "none" = "none";

    if (boldIdx !== -1) {
      minIdx = boldIdx;
      tokenType = "bold";
    }

    if (codeIdx !== -1 && (minIdx === -1 || codeIdx < minIdx)) {
      minIdx = codeIdx;
      tokenType = "code";
    }

    if (linkIdx !== -1 && (minIdx === -1 || linkIdx < minIdx)) {
      const closeBracketIdx = currentText.indexOf("]", linkIdx);
      if (closeBracketIdx !== -1 && currentText[closeBracketIdx + 1] === "(") {
        const closeParenIdx = currentText.indexOf(")", closeBracketIdx + 2);
        if (closeParenIdx !== -1) {
          minIdx = linkIdx;
          tokenType = "link";
        }
      }
    }

    if (rawUrlIdx !== -1 && (minIdx === -1 || rawUrlIdx < minIdx)) {
      const remainingFromUrl = currentText.slice(rawUrlIdx);
      const match = remainingFromUrl.match(/^(file:\/\/\/[^\s`'"\(\)\[\]<>]+|https?:\/\/[^\s`'"\(\)\[\]<>]+)/);
      if (match) {
        minIdx = rawUrlIdx;
        tokenType = "rawUrl";
      }
    }

    if (tokenType === "none" || minIdx === -1) {
      parsedElements.push(<Text key={parsedElements.length} color={defaultColor}>{renderBoldTargetText(currentText)}</Text>);
      break;
    }

    if (minIdx > 0) {
      parsedElements.push(<Text key={parsedElements.length} color={defaultColor}>{renderBoldTargetText(currentText.slice(0, minIdx))}</Text>);
    }

    currentText = currentText.slice(minIdx);

    if (tokenType === "bold") {
      const nextBoldIdx = currentText.indexOf("**", 2);
      if (nextBoldIdx !== -1) {
        const boldContent = currentText.slice(2, nextBoldIdx);
        parsedElements.push(<Text key={parsedElements.length} bold color="yellow">{boldContent}</Text>);
        currentText = currentText.slice(nextBoldIdx + 2);
      } else {
        parsedElements.push(<Text key={parsedElements.length} color={defaultColor}>{currentText.slice(0, 2)}</Text>);
        currentText = currentText.slice(2);
      }
    } else if (tokenType === "code") {
      const nextCodeIdx = currentText.indexOf("`", 1);
      if (nextCodeIdx !== -1) {
        const codeContent = currentText.slice(1, nextCodeIdx);
        parsedElements.push(<Text key={parsedElements.length} color="cyan" bold>{codeContent}</Text>);
        currentText = currentText.slice(nextCodeIdx + 1);
      } else {
        parsedElements.push(<Text key={parsedElements.length} color={defaultColor}>{currentText.slice(0, 1)}</Text>);
        currentText = currentText.slice(1);
      }
    } else if (tokenType === "link") {
      const closeBracketIdx = currentText.indexOf("]");
      const closeParenIdx = currentText.indexOf(")", closeBracketIdx + 2);
      const linkText = currentText.slice(1, closeBracketIdx);
      const linkUrl = currentText.slice(closeBracketIdx + 2, closeParenIdx);
      
      const osc8Link = `\u001B]8;;${linkUrl}\u0007${linkText}\u001B]8;;\u0007`;
      parsedElements.push(
        <Text key={parsedElements.length} color="cyan" underline>
          {osc8Link}
        </Text>
      );
      currentText = currentText.slice(closeParenIdx + 1);
    } else if (tokenType === "rawUrl") {
      const match = currentText.match(/^(file:\/\/\/[^\s`'"\(\)\[\]<>]+|https?:\/\/[^\s`'"\(\)\[\]<>]+)/);
      if (match) {
        let url = match[0];
        while (url.length > 0 && /[.,;:!?]$/.test(url)) {
          url = url.slice(0, -1);
        }
        const osc8Link = `\u001B]8;;${url}\u0007${url}\u001B]8;;\u0007`;
        parsedElements.push(
          <Text key={parsedElements.length} color="cyan" underline>
            {osc8Link}
          </Text>
        );
        currentText = currentText.slice(url.length);
      } else {
        parsedElements.push(<Text key={parsedElements.length} color={defaultColor}>{currentText[0]}</Text>);
        currentText = currentText.slice(1);
      }
    }
  }

  return <>{parsedElements}</>;
}

const streamLineWrapCache = new Map<string, WrappedChatLine[]>();

export function wrapMarkdownToLines(
  content: string,
  themeColor: string,
  chatWidth: number,
  lineIndex: number
): WrappedChatLine[] {
  const cleanContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "");
  const rawLines = cleanContent.split("\n");
  const result: WrappedChatLine[] = [];

  if (streamLineWrapCache.size > 10000) {
    streamLineWrapCache.clear();
  }

  let inCodeBlock = false;
  let codeLanguage = "";

  for (let idx = 0; idx < rawLines.length; idx++) {
    const l = rawLines[idx];
    const isLastLine = idx === rawLines.length - 1;
    const cacheKey = `${themeColor}_${chatWidth}_${inCodeBlock}_${codeLanguage}_${lineIndex}_${l}`;

    if (!isLastLine) {
      const cached = streamLineWrapCache.get(cacheKey);
      if (cached) {
        const trimmed = l.trim();
        if (trimmed.startsWith("```")) {
          inCodeBlock = !inCodeBlock;
          codeLanguage = trimmed.slice(3).trim();
        }
        result.push(...cached);
        continue;
      }
    }

    const lineResult: WrappedChatLine[] = [];
    const trimmed = l.trim();

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      codeLanguage = trimmed.slice(3).trim();
      
      const node = (
        <Box flexDirection="row">
          <Text color={themeColor}>│    </Text>
          <Text color="gray" italic>
            {inCodeBlock ? `┌─── [ CODE: ${codeLanguage || "TEXT"} ]` : "└─── [ END CODE ]"}
          </Text>
        </Box>
      );
      lineResult.push({ node, lineIndex, type: "assistant" });
    } else if (inCodeBlock) {
      const subLines = wrapTextForDisplay(l, chatWidth - 8);
      for (const subLine of subLines) {
        const node = (
          <Box flexDirection="row">
            <Text color={themeColor}>│    │  </Text>
            <Text color="gray">{subLine}</Text>
          </Box>
        );
        lineResult.push({ node, lineIndex, type: "assistant" });
      }
    } else if (l.startsWith("# ")) {
      const subLines = wrapTextForDisplay(l.slice(2), chatWidth - 5);
      for (const subLine of subLines) {
        const node = (
          <Box flexDirection="row">
            <Text color={themeColor}>│    </Text>
            <Text bold color="yellow">{subLine}</Text>
          </Box>
        );
        lineResult.push({ node, lineIndex, type: "assistant" });
      }
    } else if (l.startsWith("## ")) {
      const subLines = wrapTextForDisplay(l.slice(3), chatWidth - 5);
      for (const subLine of subLines) {
        const node = (
          <Box flexDirection="row">
            <Text color={themeColor}>│    </Text>
            <Text bold color="cyan">{subLine}</Text>
          </Box>
        );
        lineResult.push({ node, lineIndex, type: "assistant" });
      }
    } else if (l.startsWith("### ")) {
      const subLines = wrapTextForDisplay(l.slice(4), chatWidth - 5);
      for (const subLine of subLines) {
        const node = (
          <Box flexDirection="row">
            <Text color={themeColor}>│    </Text>
            <Text bold color="blue">{subLine}</Text>
          </Box>
        );
        lineResult.push({ node, lineIndex, type: "assistant" });
      }
    } else {
      let listPrefix = "";
      let isSysLine = false;
      let remainingText = l;
      if (l.trim().startsWith("[SYS]")) {
        isSysLine = true;
        const sysIndex = l.indexOf("[SYS]");
        listPrefix = l.slice(0, sysIndex);
        remainingText = l.slice(sysIndex + 5);
      } else if (l.trim().startsWith("- ")) {
        const indent = l.indexOf("- ");
        listPrefix = " ".repeat(indent) + "• ";
        remainingText = l.slice(indent + 2);
      } else if (l.trim().startsWith("* ")) {
        const indent = l.indexOf("* ");
        listPrefix = " ".repeat(indent) + "• ";
        remainingText = l.slice(indent + 2);
      } else if (/^\d+\.\s/.test(l.trim())) {
        const match = l.match(/^(\s*)(\d+\.\s)(.*)/);
        if (match) {
          listPrefix = match[1] + match[2];
          remainingText = match[3];
        }
      }

      const subLines = wrapTextForDisplay(remainingText, chatWidth - 5 - visibleLength(listPrefix));
      for (let sIdx = 0; sIdx < subLines.length; sIdx++) {
        const subLine = subLines[sIdx];
        const isFirstSubLine = sIdx === 0;
        
        const node = (
          <Box flexDirection="row">
            <Text color={themeColor}>│    </Text>
            {isSysLine ? (
              isFirstSubLine ? (
                <Text>
                  {listPrefix}
                  <Text bold color="yellow">[SYS]</Text>
                </Text>
              ) : (
                <Text>{" ".repeat(listPrefix.length + 5)}</Text>
              )
            ) : listPrefix ? (
              isFirstSubLine ? (
                <Text color="blue" bold>{listPrefix}</Text>
              ) : (
                <Text>{" ".repeat(listPrefix.length)}</Text>
              )
            ) : null}
            <Box flexShrink={1}>
              <Text>{renderInlineMarkdown(subLine, "white")}</Text>
            </Box>
          </Box>
        );
        lineResult.push({ node, lineIndex, type: "assistant" });
      }
    }

    if (!isLastLine) {
      streamLineWrapCache.set(cacheKey, lineResult);
    }
    result.push(...lineResult);
  }

  return result;
}

function wrapNestedChild(
  rawChild: ChatLine,
  childIdx: number,
  isCollapsed: boolean,
  parentIndex: number,
  chatWidth: number
): WrappedChatLine[] {
  const indent = "│        ";
  const child = {
    ...rawChild,
    content: rawChild.content.replace(/\r\n/g, "\n").replace(/\r/g, "")
  };
  const result: WrappedChatLine[] = [];

  if (child.type === "tool_start") {
    const content = child.content.replace(/^[⚡📖] /, "");
    const firstLine = content.split("\n")[0];
    const cleanDescRaw = firstLine.replace(/^Detail:\s*/i, "").trim();
    const minimizedDesc = minimizePathInDescription(cleanDescRaw);
    const cleanDesc = minimizedDesc.length > 60 ? minimizedDesc.slice(0, 57) + "..." : minimizedDesc;

    const isAskQuestion = cleanDescRaw.startsWith("Asking user:");
    const questionText = isAskQuestion ? cleanDescRaw.replace(/^Asking user:\s*/i, "").trim() : "";
    const merged = child.mergedResult;

    if (isCollapsed) {
      // ── Collapsed with merged result (tool completed) ──────────────
      if (merged) {
        const statusIcon = merged.isError ? "✗" : "✓";
        const statusLabel = merged.isError ? "failed" : "done";
        const statusColor = merged.isError ? "red" : "gray";
        const mergedDesc = minimizePathInDescription(merged.description);
        const displayDesc = mergedDesc.length > 55 ? mergedDesc.slice(0, 52) + "..." : mergedDesc;
        if (isAskQuestion) {
          const outputLine = merged.content.split("\n").find(l => l.startsWith("Output:"));
          const answerText = outputLine ? outputLine.substring("Output:".length).trim() : "";
          const node = (
            <Box flexDirection="row">
              <Text color={statusColor}>
                {indent}<Text bold color={statusColor}>{statusIcon} ❓ </Text><Text color="yellow">{questionText}</Text><Text bold color={statusColor}> → </Text><Text color={statusColor}>{answerText || "N/A"}</Text> <Text dimColor italic>(Ctrl+O)</Text>
              </Text>
            </Box>
          );
          result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isCollapsible: true });
        } else {
          // Parse diff stats from tool result (format: "Changed: +7 -2\nFile: ...")
          const diffMatch = merged.content.match(/\+(\d+)\s+-(\d+)/);
          const diffStats = diffMatch
            ? { added: parseInt(diffMatch[1], 10), removed: parseInt(diffMatch[2], 10) }
            : null;
          const node = (
            <Box flexDirection="row">
              <Text color="gray">
                {indent}<Text bold color="gray">↳ </Text><Text color="gray">{displayDesc}</Text>
                {diffStats && diffStats.added === 0 && diffStats.removed === 0 ? null : diffStats ? (
                  <Text>
                    <Text bold color="green"> +{diffStats.added}</Text>
                    <Text bold color="red"> -{diffStats.removed}</Text>
                  </Text>
                ) : null}
                <Text bold color={statusColor}> {statusIcon} {statusLabel}</Text>
                <Text dimColor italic>  (Ctrl+O)</Text>
              </Text>
            </Box>
          );
          result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isCollapsible: true });
        }
      } else {
        // ── Collapsed, tool still running ────────────────────────────
        const node = isAskQuestion ? (
          <Box flexDirection="row">
            <Text color="yellow">
              {indent}<Text bold color="yellow">↳ ❓ Question: </Text><Text color="yellow">{questionText}</Text>
            </Text>
          </Box>
        ) : (
          <Box flexDirection="row">
            <Text color="gray">
              {indent}<Text bold color="gray">↳ </Text><Text color="gray">{cleanDesc}</Text> <Text dimColor italic>(click to view inputs)</Text>
            </Text>
          </Box>
        );
        result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isCollapsible: true });
      }
    } else {
      // ── Expanded: Input block + divider + Output block ─────────────
      const inputLines = content.split("\n");
      const mergedOutputLines = merged ? merged.content.split("\n") : [];
      const mergedColor = merged?.isError ? "red" : "gray";
      const mergedIcon = merged?.isError ? "✗" : "✓";

      // Header row
      const expandedDiffMatch = merged ? merged.content.match(/\+(\d+)\s+-(\d+)/) : null;
      const expandedDiffStats = expandedDiffMatch
        ? { added: parseInt(expandedDiffMatch[1], 10), removed: parseInt(expandedDiffMatch[2], 10) }
        : null;
      const headerNode = (
        <Box flexDirection="row">
          <Text color="gray">{indent}{"▼ "}</Text>
          <Text color="gray">{cleanDesc}</Text>
          {merged && <Text bold color={mergedColor}> {mergedIcon}</Text>}
          {expandedDiffStats && !(expandedDiffStats.added === 0 && expandedDiffStats.removed === 0) && (
            <Text>
              <Text bold color="green"> +{expandedDiffStats.added}</Text>
              <Text bold color="red"> -{expandedDiffStats.removed}</Text>
            </Text>
          )}
          <Text dimColor italic> (click to collapse)</Text>
        </Box>
      );
      result.push({ node: headerNode, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isHeader: true, isCollapsible: true });

      // Input lines (skip line 0, already in header)
      for (let idx = 1; idx < inputLines.length; idx++) {
        const l = inputLines[idx];
        const subLines = wrapTextForDisplay(l, chatWidth - 14);
        for (const subLine of subLines) {
          const node = (
            <Box flexDirection="row">
              <Text color="gray">{indent}{"    "}</Text>
              <Text bold color="white">{subLine}</Text>
            </Box>
          );
          result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isCollapsible: true });
        }
      }

      // Divider + Output (only if merged result exists)
      if (merged) {
        const dividerNode = (
          <Box flexDirection="row">
            <Text color={mergedColor}>{indent}{"    "}{"─".repeat(30)}</Text>
          </Box>
        );
        result.push({ node: dividerNode, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isSeparator: true, isCollapsible: true });

        for (const l of mergedOutputLines) {
          if (l.startsWith("Output:") || l.startsWith("Detail:")) {
            const labelType = l.startsWith("Output:") ? "Output: " : "Detail: ";
            const rest = l.substring(labelType.length);
            const subLines = wrapTextForDisplay(rest, chatWidth - 14 - labelType.length);
            for (let sIdx = 0; sIdx < subLines.length; sIdx++) {
              const sub = subLines[sIdx];
              const isFirstSub = sIdx === 0;
              const node = (
                <Box flexDirection="row">
                  <Text color={mergedColor}>{indent}{"    "}</Text>
                  {isFirstSub ? (
                    <Text>
                      <Text bold color={merged.isError ? "cyan" : "gray"} dimColor={!merged.isError}>{labelType}</Text>
                      <Text dimColor>{sub}</Text>
                    </Text>
                  ) : (
                    <Text>
                      {" ".repeat(labelType.length)}
                      <Text dimColor>{sub}</Text>
                    </Text>
                  )}
                </Box>
              );
              result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isCollapsible: true });
            }
          } else {
            const subLines = wrapTextForDisplay(l, chatWidth - 14);
            for (const subLine of subLines) {
              const node = (
                <Box flexDirection="row">
                  <Text color={mergedColor}>{indent}{"    "}</Text>
                  <Text color={merged.isError ? "white" : "gray"} dimColor={!merged.isError}>{subLine}</Text>
                </Box>
              );
              result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isCollapsible: true });
            }
          }
        }
      }
    }
  } else if (child.type === "tool_end") {
    const isError = child.content.startsWith("✗") || child.content.startsWith("🚨");
    const contentText = child.content.substring(2);
    const themeColor = isError ? "red" : "gray";
    const firstLine = contentText.split("\n")[0];
    const cleanDescRaw = firstLine.replace(/^(Completed|Failed|Loaded instructions)\s*-\s*/i, "").trim();
    const minimizedDesc = minimizePathInDescription(cleanDescRaw);
    const cleanDesc = minimizedDesc.length > 60 ? minimizedDesc.slice(0, 57) + "..." : minimizedDesc;

    const isAskQuestion = cleanDescRaw.startsWith("Asking user:");
    const questionText = isAskQuestion ? cleanDescRaw.replace(/^Asking user:\s*/i, "").trim() : "";

    if (isCollapsed) {
      const node = isAskQuestion ? (() => {
        const lines = contentText.split("\n");
        const outputLine = lines.find(l => l.startsWith("Output:"));
        const answerText = outputLine ? outputLine.substring("Output:".length).trim() : "";
        return (
          <Box flexDirection="row">
            <Text color={themeColor}>
              {indent}<Text bold color={themeColor}>{isError ? "↳ ✗ " : "↳ ✓ "}</Text><Text bold color={themeColor}>Question: </Text><Text color={themeColor}>{questionText}</Text><Text bold color={themeColor}> | Answer: </Text><Text color={themeColor}>{answerText || "N/A"}</Text>
            </Text>
          </Box>
        );
      })() : (
        <Box flexDirection="row">
          <Text color={themeColor}>
            {indent}<Text bold color={themeColor}>{isError ? "↳ ✗ " : "↳ ✓ "}</Text><Text color={themeColor}>{cleanDesc}</Text> <Text dimColor italic>{isError ? "(click to view error)" : "(click to view output)"}</Text>
          </Text>
        </Box>
      );
      result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_end", isCollapsible: true });
    } else {
      const contentLines = contentText.split("\n");
      for (let idx = 0; idx < contentLines.length; idx++) {
        const l = contentLines[idx];
        const isFirstLine = idx === 0;
        const cleanLine = l.replace(/^(Completed|Failed|Loaded instructions)\s*-\s*/i, "").trim();

        const subLines = wrapTextForDisplay(isFirstLine ? cleanLine : l, chatWidth - 14);
        for (let sIdx = 0; sIdx < subLines.length; sIdx++) {
          const subLine = subLines[sIdx];
          const isFirstSub = isFirstLine && sIdx === 0;

          const node = (
            <Box flexDirection="row">
              <Text color={themeColor}>
                {indent}{isFirstSub ? (isError ? "▼ ✗ " : "▼ ✓ ") : "    "}
              </Text>
              {isFirstSub ? (
                <Text color={themeColor}>
                  {subLine}
                  <Text dimColor italic> (click to collapse)</Text>
                </Text>
              ) : subLine.startsWith("Output:") || subLine.startsWith("Detail:") ? (() => {
                const type = subLine.startsWith("Output:") ? "Output: " : "Detail: ";
                const rest = subLine.substring(type.length);
                return (
                  <Text>
                    <Text bold color={isError ? "cyan" : "gray"} dimColor={!isError}>{type}</Text>
                    <Text dimColor>{rest}</Text>
                  </Text>
                );
              })() : (
                <Text color={isError ? "white" : "gray"} dimColor={!isError}>{subLine}</Text>
              )}
            </Box>
          );
          result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_end", isCollapsible: true });
        }
      }
    }
  } else {
    const contentLines = child.content.split("\n");
    for (const l of contentLines) {
      const subLines = wrapTextForDisplay(l, chatWidth - 14);
      for (const subLine of subLines) {
        const node = (
          <Box flexDirection="row">
            <Text color="gray">{indent}│    </Text>
            <Text>{subLine}</Text>
          </Box>
        );
        result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: child.type });
      }
    }
  }

  return result;
}

export function wrapChatLineToLines({
  line,
  isFirst,
  lineIndex,
  tokensUp,
  tokensDown,
  modelName,
  maxResponseLines,
  chatWidth,
  isLastAssistant,
  isCollapsed,
  expandedChildren,
}: {
  line: ChatLine;
  isFirst: boolean;
  lineIndex: number;
  tokensUp: number;
  tokensDown: number;
  modelName: string;
  maxResponseLines: number;
  chatWidth: number;
  isLastAssistant: boolean;
  isCollapsed: boolean;
  expandedChildren: Set<number>;
}): WrappedChatLine[] {
  const result: WrappedChatLine[] = [];

  switch (line.type) {
    case "user": {
      const content = line.content.replace(/^❯ /, "");
      const headerNode = (
        <Box flexDirection="row">
          <Text color="cyan">
            {isFirst ? "┌" : "├"}─── [ <Text bold color="cyan">👤 ACCESS_POINT: USER</Text> ]{lineIndex !== undefined ? <Text dimColor> [#{lineIndex}]</Text> : null}
          </Text>
        </Box>
      );
      result.push({ node: headerNode, lineIndex, type: "user", isHeader: true });

      const subLines = wrapTextForDisplay(content, chatWidth - 5);
      for (const subLine of subLines) {
        const node = (
          <Box flexDirection="row">
            <Text color="cyan">│    </Text>
            <Text>{renderBoldTargetText(subLine)}</Text>
          </Box>
        );
        result.push({ node, lineIndex, type: "user" });
      }

      const separatorNode = (
        <Box flexDirection="row">
          <Text color="cyan">│ </Text>
        </Box>
      );
      result.push({ node: separatorNode, lineIndex, type: "user", isSeparator: true });
      break;
    }
    case "assistant": {
      const capped = isLastAssistant
        ? { text: line.content, truncated: false }
        : capDisplayLines(line.content, maxResponseLines || 12, chatWidth || 80);

      const headerNode = (
        <Box flexDirection="row">
          <Text color="gray">
            {isFirst ? "┌" : "├"}─── [ <Text bold color="gray">✦ SUPERAGENT</Text> ]{lineIndex !== undefined ? <Text color="gray"> [#{lineIndex}]</Text> : null}
          </Text>
        </Box>
      );
      result.push({ node: headerNode, lineIndex, type: "assistant", isHeader: true, isTruncated: capped.truncated });

      const contentLines = wrapMarkdownToLines(capped.text, "gray", chatWidth, lineIndex);
      for (const wrappedContentLine of contentLines) {
        result.push({
          ...wrappedContentLine,
          isTruncated: capped.truncated,
        });
      }

      if (capped.truncated) {
        const noticeNode = (
          <Box flexDirection="row">
            <Text color="gray">│    </Text>
            <Text color="yellow">... [long response truncated; click to open scroll view, mouse scroll / ↑↓] ...</Text>
          </Box>
        );
        result.push({ node: noticeNode, lineIndex, type: "assistant", isTruncated: true });
      }

      const children = line.children || [];
      if (children.length > 0) {
        for (let childIdx = 0; childIdx < children.length; childIdx++) {
          const isChildCollapsed = isCollapsibleType(children[childIdx].type) && !expandedChildren.has(childIdx);
          const childLines = wrapNestedChild(children[childIdx], childIdx, isChildCollapsed, lineIndex, chatWidth);
          result.push(...childLines);
        }
      }

      const separatorNode = (
        <Box flexDirection="row">
          <Text color="gray">│ </Text>
        </Box>
      );
      result.push({ node: separatorNode, lineIndex, type: "assistant", isSeparator: true, isTruncated: capped.truncated });
      break;
    }
    case "tool_start": {
      const content = line.content.replace(/^⚡ /, "");
      const extractToolName = (str: string): string => {
        const match = str.match(/Detail:\s*(\w+)/);
        return match ? match[1] : "tool";
      };
      const extractDescription = (str: string): string => {
        const firstLine = str.split("\n")[0].replace(/^[⚡✓✗📖🚨]\s*/, "").trim();
        const minimized = minimizePathInDescription(firstLine);
        return minimized.length > 60 ? minimized.slice(0, 57) + "..." : minimized;
      };

      if (isCollapsed) {
        const toolName = extractToolName(line.content);
        const desc = extractDescription(content);
        const node = (
          <Box flexDirection="row">
            <Text color="gray">
              ├─── [ <Text bold color="gray">▶ {desc}</Text><Text dimColor> ({toolName})</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
        result.push({ node, lineIndex, type: "tool_start", isCollapsible: true });
      } else {
        const headerNode = (
          <Box flexDirection="row">
            <Text color="gray">
              ├─── [ <Text bold color="gray">SYSTEM_INVOKING_MODULE</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
        result.push({ node: headerNode, lineIndex, type: "tool_start", isHeader: true, isCollapsible: true });

        const contentLines = content.split("\n");
        for (const l of contentLines) {
          if (l.includes("Detail:")) {
            const parts = l.split("Detail:");
            const prefix = parts[0] + "Detail: ";
            const rest = parts[1];
            const openParenIdx = rest.indexOf("(");
            if (openParenIdx !== -1) {
              const toolName = rest.slice(0, openParenIdx).trim();
              let remaining = rest.slice(openParenIdx + 1);
              let hasClose = false;
              if (remaining.endsWith(")")) {
                remaining = remaining.slice(0, -1);
                hasClose = true;
              }

              const detailSubLines = wrapTextForDisplay(remaining, chatWidth - 5 - (prefix.length + toolName.length + 2));
              for (let sIdx = 0; sIdx < detailSubLines.length; sIdx++) {
                const sub = detailSubLines[sIdx];
                const isFirstSub = sIdx === 0;

                const node = (
                  <Box flexDirection="row">
                    <Text color="gray">│    </Text>
                    {isFirstSub ? (
                      <Text>
                        <Text dimColor>{prefix}</Text>
                        <Text bold color="green">{toolName}</Text>
                        <Text color="cyan">(</Text>
                        <Text color="gray">{sub}</Text>
                        {hasClose && detailSubLines.length === 1 && <Text color="cyan">)</Text>}
                      </Text>
                    ) : (
                      <Text>
                        {" ".repeat(prefix.length + toolName.length + 1)}
                        <Text color="gray">{sub}</Text>
                        {hasClose && sIdx === detailSubLines.length - 1 && <Text color="cyan">)</Text>}
                      </Text>
                    )}
                  </Box>
                );
                result.push({ node, lineIndex, type: "tool_start", isCollapsible: true });
              }
              continue;
            }
          }

          const subLines = wrapTextForDisplay(l, chatWidth - 5);
          for (const subLine of subLines) {
            const node = (
              <Box flexDirection="row">
                <Text color="gray">│    </Text>
                <Text bold color="white">{subLine}</Text>
              </Box>
            );
            result.push({ node, lineIndex, type: "tool_start", isCollapsible: true });
          }
        }

        const separatorNode = (
          <Box flexDirection="row">
            <Text color="gray">│ </Text>
          </Box>
        );
        result.push({ node: separatorNode, lineIndex, type: "tool_start", isSeparator: true, isCollapsible: true });
      }
      break;
    }
    case "tool_end": {
      const isError = line.content.startsWith("✗");
      const contentText = line.content.substring(2);
      const themeColor = isError ? "red" : "gray";
      const extractDescription = (str: string): string => {
        const firstLine = str.split("\n")[0].replace(/^[⚡✓✗📖🚨]\s*/, "").trim();
        const minimized = minimizePathInDescription(firstLine);
        return minimized.length > 60 ? minimized.slice(0, 57) + "..." : minimized;
      };

      if (isCollapsed) {
        const desc = extractDescription(contentText);
        const icon = isError ? "🔴" : "⚪";
        const status = isError ? "Failed" : "Done";
        const node = (
          <Box flexDirection="row">
            <Text color={themeColor}>
              ├─── [ <Text bold color={themeColor}>▶ {icon} {status}:</Text> <Text dimColor>{desc}</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
        result.push({ node, lineIndex, type: "tool_end", isCollapsible: true });
      } else {
        const headerNode = (
          <Box flexDirection="row">
            <Text color={themeColor}>
              ├─── [ <Text bold color={themeColor}>{isError ? "🔴 SYSTEM_CALL_FAILED" : "⚪ SYSTEM_CALL_SUCCESS"}</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
        result.push({ node: headerNode, lineIndex, type: "tool_end", isHeader: true, isCollapsible: true });

        const contentLines = contentText.split("\n");
        for (const l of contentLines) {
          if (l.startsWith("Output:") || l.startsWith("Detail:")) {
            const type = l.startsWith("Output:") ? "Output: " : "Detail: ";
            const rest = l.substring(type.length);

            const subLines = wrapTextForDisplay(rest, chatWidth - 5 - type.length);
            for (let sIdx = 0; sIdx < subLines.length; sIdx++) {
              const sub = subLines[sIdx];
              const isFirstSub = sIdx === 0;

              const node = (
                <Box flexDirection="row">
                  <Text color={themeColor}>│    </Text>
                  {isFirstSub ? (
                    <Text>
                      <Text bold color={isError ? "cyan" : "gray"} dimColor={!isError}>{type}</Text>
                      <Text dimColor>{sub}</Text>
                    </Text>
                  ) : (
                    <Text>
                      {" ".repeat(type.length)}
                      <Text dimColor>{sub}</Text>
                    </Text>
                  )}
                </Box>
              );
              result.push({ node, lineIndex, type: "tool_end", isCollapsible: true });
            }
            continue;
          }

          const subLines = wrapTextForDisplay(l, chatWidth - 5);
          for (const subLine of subLines) {
            const node = (
              <Box flexDirection="row">
                <Text color={themeColor}>│    </Text>
                <Text color={isError ? "white" : "gray"} dimColor={!isError}>{subLine}</Text>
              </Box>
            );
            result.push({ node, lineIndex, type: "tool_end", isCollapsible: true });
          }
        }

        const separatorNode = (
          <Box flexDirection="row">
            <Text color={themeColor}>│ </Text>
          </Box>
        );
        result.push({ node: separatorNode, lineIndex, type: "tool_end", isSeparator: true, isCollapsible: true });
      }
      break;
    }
    case "error": {
      const contentText = line.content.replace(/^Error: /, "");
      if (isCollapsed) {
        const firstLine = contentText.split("\n")[0];
        const preview = firstLine.length > 50 ? firstLine.slice(0, 47) + "..." : firstLine;
        const node = (
          <Box flexDirection="row">
            <Text color="red">
              ├─── [ <Text bold color="red">▶ 🚨 Error:</Text> <Text dimColor>{preview}</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
        result.push({ node, lineIndex, type: "error", isCollapsible: true });
      } else {
        const headerNode = (
          <Box flexDirection="row">
            <Text color="red">
              ├─── [ <Text bold color="red">🚨 ERROR_REPORT</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
        result.push({ node: headerNode, lineIndex, type: "error", isHeader: true, isCollapsible: true });

        const contentLines = contentText.split("\n");
        for (const l of contentLines) {
          const subLines = wrapTextForDisplay(l, chatWidth - 5);
          for (const subLine of subLines) {
            const node = (
              <Box flexDirection="row">
                <Text color="red">│    </Text>
                <Text color="red">{subLine}</Text>
              </Box>
            );
            result.push({ node, lineIndex, type: "error", isCollapsible: true });
          }
        }

        const separatorNode = (
          <Box flexDirection="row">
            <Text color="red">│ </Text>
          </Box>
        );
        result.push({ node: separatorNode, lineIndex, type: "error", isSeparator: true, isCollapsible: true });
      }
      break;
    }
    case "system": {
      if (isCollapsed) {
        const firstLine = line.content.split("\n")[0];
        const preview = firstLine.length > 50 ? firstLine.slice(0, 47) + "..." : firstLine;
        const node = (
          <Box flexDirection="row">
            <Text color="gray">
              ├─── [ <Text bold color="gray">▶ ℹ️ System:</Text> <Text dimColor>{preview}</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
        result.push({ node, lineIndex, type: "system", isCollapsible: true });
      } else {
        const headerNode = (
          <Box flexDirection="row">
            <Text color="gray">
              ├─── [ <Text bold color="gray">ℹ️ SYSTEM_INFO</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
        result.push({ node: headerNode, lineIndex, type: "system", isHeader: true, isCollapsible: true });

        const contentLines = line.content.split("\n");
        for (const l of contentLines) {
          const subLines = wrapTextForDisplay(l, chatWidth - 5);
          for (const subLine of subLines) {
            const node = (
              <Box flexDirection="row">
                <Text color="gray">│    </Text>
                <Text color="gray" italic>{subLine}</Text>
              </Box>
            );
            result.push({ node, lineIndex, type: "system", isCollapsible: true });
          }
        }

        const separatorNode = (
          <Box flexDirection="row">
            <Text color="gray">│ </Text>
          </Box>
        );
        result.push({ node: separatorNode, lineIndex, type: "system", isSeparator: true, isCollapsible: true });
      }
      break;
    }
    default: {
      const headerNode = (
        <Box flexDirection="row">
          <Text color="gray">
            ├─── [ <Text bold color="gray">COMM_PACKET</Text> ]
          </Text>
        </Box>
      );
      result.push({ node: headerNode, lineIndex, type: "default" });

      const contentLines = line.content.split("\n");
      for (const l of contentLines) {
        const subLines = wrapTextForDisplay(l, chatWidth - 5);
        for (const subLine of subLines) {
          const node = (
            <Box flexDirection="row">
              <Text color="gray">│    </Text>
              <Text>{subLine}</Text>
            </Box>
          );
          result.push({ node, lineIndex, type: "default" });
        }
      }

      const separatorNode = (
        <Box flexDirection="row">
          <Text color="gray">│ </Text>
        </Box>
      );
      result.push({ node: separatorNode, lineIndex, type: "default", isSeparator: true });
      break;
    }
  }

  return result;
}

const lineWrapCache = new Map<string, WrappedChatLine[]>();

function getLineCacheKey(
  line: ChatLine,
  idx: number,
  chatWidth: number,
  isCollapsed: boolean,
  childSet: Set<number>,
  isLastAssistant: boolean
): string {
  const childrenKey = line.children
    ? line.children.map((c, i) => `${c.type}:${c.content.length}:${c.mergedResult ? "m" : "n"}:${childSet.has(i)}`).join("|")
    : "";
  return [
    idx,
    chatWidth,
    isCollapsed,
    isLastAssistant,
    line.type,
    line.content.length,
    line.timestamp,
    line.mergedResult ? "m" : "n",
    childrenKey
  ].join(":");
}

export function computeWrappedLines({
  lines,
  chatWidth,
  maxAssistantResponseLines,
  expandedLines,
  expandedChildren,
  tokensUp,
  tokensDown,
  modelName,
  isProcessing,
  streamDisplay,
  isExecutingTool,
  activeToolOutput,
  timeLeft,
  formatCompactNumber,
}: {
  lines: ChatLine[];
  chatWidth: number;
  maxAssistantResponseLines: number;
  expandedLines: Set<number>;
  expandedChildren: Map<number, Set<number>>;
  tokensUp: number;
  tokensDown: number;
  modelName: string;
  isProcessing: boolean;
  streamDisplay: string;
  isExecutingTool: boolean;
  activeToolOutput: string;
  timeLeft: number | null;
  formatCompactNumber: (val: number) => string;
}): WrappedChatLine[] {
  const result: WrappedChatLine[] = [];

  if (lines.length === 0) {
    lineWrapCache.clear();
  }
  if (lineWrapCache.size > 2000) {
    lineWrapCache.clear();
  }

  const lastAssistantIdx = (() => {
    const shouldRenderStreamNow = isProcessing && streamDisplay && streamDisplay.trim().length > 0;
    if (shouldRenderStreamNow) return -1;
    for (let j = lines.length - 1; j >= 0; j--) {
      if (lines[j].type === "assistant") return j;
    }
    return -1;
  })();

  // 1. Process all completed lines
  for (let idx = 0; idx < lines.length; idx++) {
    const isFirst = idx === 0;
    const isCollapsed = (lines[idx].type === "error" || lines[idx].type === "system")
      ? expandedLines.has(idx)
      : (isCollapsibleType(lines[idx].type) && !expandedLines.has(idx));
    const childSet = expandedChildren.get(idx) || new Set<number>();
    const isLastAssistant = idx === lastAssistantIdx;

    const cacheKey = getLineCacheKey(lines[idx], idx, chatWidth, isCollapsed, childSet, isLastAssistant);
    let wrapped = lineWrapCache.get(cacheKey);

    if (!wrapped) {
      wrapped = wrapChatLineToLines({
        line: lines[idx],
        isFirst,
        lineIndex: idx,
        tokensUp,
        tokensDown,
        modelName,
        maxResponseLines: maxAssistantResponseLines,
        chatWidth,
        isLastAssistant,
        isCollapsed,
        expandedChildren: childSet,
      });
      lineWrapCache.set(cacheKey, wrapped);
    }
    result.push(...wrapped);
  }

  // 2. Append Live Streaming / Thinking / Tool Output
  const isLastLinesEmpty = lines.length === 0;
  const borderPrefix = isLastLinesEmpty ? "┌" : "├";

  const shouldRenderStream = isProcessing && streamDisplay && streamDisplay.trim().length > 0;
  if (shouldRenderStream) {
    const headerNode = (
      <Box flexDirection="row">
        <Text color="gray">
          {borderPrefix}─── [ <Text bold color="gray">✦ SUPERAGENT (STREAMING...)</Text> ]
        </Text>
      </Box>
    );
    result.push({ node: headerNode, lineIndex: -1, type: "assistant", isHeader: true });

    const contentLines = wrapMarkdownToLines(streamDisplay, "gray", chatWidth, -1);
    result.push(...contentLines);
  }

  const shouldRenderThinking = isProcessing && (!streamDisplay || streamDisplay.trim().length === 0) && !isExecutingTool;
  if (shouldRenderThinking) {
    const headerNode = (
      <Box flexDirection="row">
        <Text color="gray">
          {borderPrefix}─── [ <Text bold color="gray">✦ SUPERAGENT (THINKING...)</Text> ]
        </Text>
      </Box>
    );
    result.push({ node: headerNode, lineIndex: -1, type: "assistant", isHeader: true });

    const bodyNode = (
      <Box flexDirection="row">
        <Text color="gray">│    </Text>
        <LoadingIndicator />
      </Box>
    );
    result.push({ node: bodyNode, lineIndex: -1, type: "assistant" });
  }

  if (isExecutingTool) {
    const headerNode = (
      <Box flexDirection="row">
        <Text color="gray">
          {borderPrefix}─── [ <Text bold color="gray">SYSTEM_CALL: EXECUTING...{timeLeft !== null ? ` (${timeLeft}s left)` : ""}</Text> ]
        </Text>
      </Box>
    );
    result.push({ node: headerNode, lineIndex: -1, type: "tool_start", isHeader: true });

    const spinnerNode = (
      <Box flexDirection="row">
        <Text color="gray">│    </Text>
        <ToolLoadingIndicator />
      </Box>
    );
    result.push({ node: spinnerNode, lineIndex: -1, type: "tool_start" });

    const activeToolLines = activeToolOutput ? activeToolOutput.trim().split("\n").slice(-8) : [];
    if (activeToolLines.length > 0) {
      const liveOutputHeader = (
        <Box flexDirection="row">
          <Text color="gray">├─── [ <Text bold color="gray">SYSTEM_CALL_OUTPUT (LIVE)</Text> ]</Text>
        </Box>
      );
      result.push({ node: liveOutputHeader, lineIndex: -1, type: "tool_start" });

      for (const line of activeToolLines) {
        const subLines = wrapTextForDisplay(line, chatWidth - 5);
        for (const subLine of subLines) {
          const node = (
            <Box flexDirection="row">
              <Text color="gray">│    </Text>
              <Text color="gray">{subLine}</Text>
            </Box>
          );
          result.push({ node, lineIndex: -1, type: "tool_start" });
        }
      }
    }
  }

  return result;
}

export interface ChatAreaProps {
  showBanner: boolean;
  focusMode: string;
  scrollOffset: number;
  focusedResponseIndex: number | null;
  setFocusedResponseIndex: React.Dispatch<React.SetStateAction<number | null>>;
  focusedResponseOffset: number;
  setFocusedResponseOffset: React.Dispatch<React.SetStateAction<number>>;
  lines: ChatLine[];
  chatHeightLimit: number;
  terminalHeight: number;
  terminalWidth: number;
  isProcessing: boolean;
  streamDisplay: string;
  tokensUp: number;
  tokensDown: number;
  liveStreamTokens: number;
  modelName: string;
  maxAssistantResponseLines: number;
  isExecutingTool: boolean;
  timeLeft: number | null;
  activeToolOutput: string;
  formatCompactNumber: (val: number) => string;
  onVisibleLinesChange?: (positions: ChatLinePosition[]) => void;
  chatContentStartRow?: number;
  expandedLines?: Set<number>;
  toggleLineExpand?: (index: number) => void;
  expandedChildren?: Map<number, Set<number>>;
  toggleChildExpand?: (parentIndex: number, childIndex: number) => void;
  wrappedLines?: WrappedChatLine[];
}

export const ChatArea = memo(function ChatArea(props: ChatAreaProps) {
  const {
    showBanner,
    focusMode,
    scrollOffset,
    focusedResponseIndex,
    setFocusedResponseIndex,
    focusedResponseOffset,
    setFocusedResponseOffset,
    lines,
    chatHeightLimit,
    terminalHeight,
    terminalWidth,
    isProcessing,
    streamDisplay,
    tokensUp,
    tokensDown,
    liveStreamTokens,
    modelName,
    maxAssistantResponseLines,
    isExecutingTool,
    timeLeft,
    activeToolOutput,
    formatCompactNumber,
    onVisibleLinesChange,
    chatContentStartRow = 2,
    expandedLines = new Set(),
    toggleLineExpand,
    expandedChildren = new Map(),
    toggleChildExpand,
    wrappedLines: passedWrappedLines,
  } = props;

  const chatWidth = Math.max(20, terminalWidth - 6);

  const localWrappedLines = useMemo(() => {
    if (passedWrappedLines) return passedWrappedLines;
    return computeWrappedLines({
      lines,
      chatWidth,
      maxAssistantResponseLines,
      expandedLines,
      expandedChildren,
      tokensUp,
      tokensDown,
      modelName,
      isProcessing,
      streamDisplay,
      isExecutingTool,
      activeToolOutput,
      timeLeft,
      formatCompactNumber,
    });
  }, [
    passedWrappedLines,
    lines,
    chatWidth,
    maxAssistantResponseLines,
    expandedLines,
    expandedChildren,
    tokensUp,
    tokensDown,
    modelName,
    isProcessing,
    streamDisplay,
    isExecutingTool,
    activeToolOutput,
    timeLeft,
    formatCompactNumber,
  ]);

  const visibleLinePositions = useMemo(() => {
    if (focusedResponseIndex !== null) return [];

    const endIdx = localWrappedLines.length - scrollOffset;
    const startIdx = Math.max(0, endIdx - chatHeightLimit);
    const visibleWrappedLines = localWrappedLines.slice(startIdx, endIdx);

    const positions: ChatLinePosition[] = [];
    let currentBlockIndex = -1;
    let currentChildIndex = -1;
    let activePos: ChatLinePosition | null = null;

    for (let i = 0; i < visibleWrappedLines.length; i++) {
      const line = visibleWrappedLines[i];
      const y = chatContentStartRow + i;

      if (line.lineIndex === -1) {
        if (activePos) {
          positions.push(activePos);
          activePos = null;
        }
        currentBlockIndex = -1;
        currentChildIndex = -1;
        continue;
      }

      const hasChild = line.childIndex !== undefined;
      const isNewGroup =
        line.lineIndex !== currentBlockIndex ||
        (hasChild && line.childIndex !== currentChildIndex) ||
        (!hasChild && currentChildIndex !== -1);

      if (isNewGroup) {
        if (activePos) {
          positions.push(activePos);
        }
        activePos = {
          index: line.lineIndex,
          parentIndex: hasChild ? line.lineIndex : undefined,
          childIndex: line.childIndex,
          startRow: y,
          endRow: y,
          isTruncated: line.isTruncated || false,
          type: line.type,
          isCollapsible: line.isCollapsible || false,
        };
        currentBlockIndex = line.lineIndex;
        currentChildIndex = hasChild ? (line.childIndex ?? -1) : -1;
      } else {
        if (activePos) {
          activePos.endRow = y;
          if (line.isTruncated) {
            activePos.isTruncated = true;
          }
          if (line.isCollapsible) {
            activePos.isCollapsible = true;
          }
        }
      }
    }

    if (activePos) {
      positions.push(activePos);
    }

    return positions;
  }, [localWrappedLines, scrollOffset, chatHeightLimit, chatContentStartRow, focusedResponseIndex]);

  useEffect(() => {
    if (onVisibleLinesChange) {
      onVisibleLinesChange(visibleLinePositions);
    }
  }, [visibleLinePositions, onVisibleLinesChange]);

  const endIdx = localWrappedLines.length - scrollOffset;
  const startIdx = Math.max(0, endIdx - chatHeightLimit);
  const visibleWrappedLines = localWrappedLines.slice(startIdx, endIdx);

  return (
    <>
      {showBanner && <Banner />}

      {/* Messages Header */}
      <Box flexDirection="row" justifyContent="space-between" paddingX={1} marginBottom={0}>
        <Text color={focusMode === "chat" ? "gray" : "cyan"}>
          ┌─── [ <Text bold color={focusMode === "chat" ? "gray" : "cyan"}>💬 CONVERSATION LOG</Text>
          {focusMode === "chat" && <Text dimColor> [↑/▼ Scroll • Esc Exit]</Text>} ]
        </Text>
        {scrollOffset > 0 && (
          <Text color="yellow" bold>
            [Scroll: -{scrollOffset} lines - Esc to snap bottom]
          </Text>
        )}
      </Box>
 
      {/* Messages */}
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        {focusedResponseIndex !== null ? (() => {
          const width = Math.max(20, chatWidth - 6);
          const maxLines = Math.max(8, Math.min(18, Math.floor(terminalHeight * 0.45)));
          const truncatedIndexes = getTruncatedAssistantIndexes(lines, maxLines, chatWidth);
          const currentPosition = Math.max(0, truncatedIndexes.indexOf(focusedResponseIndex));
          const focusedLine = lines[focusedResponseIndex];
          if (!focusedLine || focusedLine.type !== "assistant") return null;
          const focusWindowHeight = Math.max(5, chatHeightLimit - 3);
          const responseLines = wrapTextForDisplay(focusedLine.content, width);
          const maxOffset = Math.max(0, responseLines.length - focusWindowHeight);
          const safeOffset = Math.min(focusedResponseOffset, maxOffset);
          const visibleText = responseLines.slice(safeOffset, safeOffset + focusWindowHeight).join("\n");
          const visibleEnd = Math.min(responseLines.length, safeOffset + focusWindowHeight);
          return (
            <Box flexDirection="column">
              <Text color="yellow">
                ┌─── [ <Text bold color="yellow">RESPONSE_SCROLL</Text><Text dimColor> {currentPosition + 1}/{Math.max(1, truncatedIndexes.length)} line {safeOffset + 1}-{visibleEnd} / {responseLines.length} {renderScrollBar(safeOffset, focusWindowHeight, responseLines.length)} | ↑/↓ scroll | Esc close | click to close</Text> ]
              </Text>
              {renderMarkdown(visibleText, "gray")}
              <Text color="yellow">└─── [ focused assistant response #{focusedResponseIndex + 1} ]</Text>
            </Box>
          );
        })() : (
          <>
            {visibleWrappedLines.map((line, idx) => (
              <Box key={idx} flexDirection="column">
                {line.node}
              </Box>
            ))}
          </>
        )}
      </Box>
    </>
  );
});
