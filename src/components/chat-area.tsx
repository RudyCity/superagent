import React, { useMemo, useEffect, memo } from "react";
import { Box, Text } from "ink";
import { Banner } from "./banner.js";
import { ChatLineComponent, renderMarkdown, truncateStreamDisplay, isCollapsibleType } from "./chat-line.js";
import { LoadingIndicator, ToolLoadingIndicator } from "./common/LoadingIndicators.js";
import { getTruncatedAssistantIndexes, wrapTextForDisplay, renderScrollBar, capDisplayLines } from "../utils/responseScroll.js";
import { formatCompactNumber, minimizePathInDescription } from "../utils/text.js";
import type { ChatLine } from "../core/slash-commands.js";
import type { ChatLinePosition } from "../hooks/useMouseScroll.js";
import { getSettings } from "../core/config.js";

export interface WrappedChatLine {
  node: React.ReactNode;
  lineIndex: number;
  childIndex?: number;
  type: string;
  isHeader?: boolean;
  isSeparator?: boolean;
  isCollapsible?: boolean;
  isTruncated?: boolean;
  length?: number;
}

function visibleLength(str: string): number {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").length;
}

function renderDiffColors(text: string): React.ReactNode {
  const diffRegex = /(\+\d+|-\d+)/g;
  if (!diffRegex.test(text)) {
    return text;
  }
  diffRegex.lastIndex = 0;
  const parts = text.split(diffRegex);
  return (
    <>
      {parts.map((p, idx) => {
        if (p.startsWith("+")) {
          return (
            <Text key={idx} color="green" bold>
              {p}
            </Text>
          );
        }
        if (p.startsWith("-")) {
          return (
            <Text key={idx} color="red" bold>
              {p}
            </Text>
          );
        }
        return p;
      })}
    </>
  );
}

function renderBoldTargetText(text: string): React.ReactNode {
  const regex = /(5\.\s+Struktur\s+Direktori\s+Tools|Struktur\s+Direktori\s+Tools)/gi;
  if (!regex.test(text)) {
    return renderDiffColors(text);
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
        return renderDiffColors(part);
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
  lineIndex: number,
  hideTimeline: boolean
): WrappedChatLine[] {
  const cleanContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "");
  const rawLines = cleanContent.split("\n");
  const result: WrappedChatLine[] = [];

  if (streamLineWrapCache.size > 10000) {
    streamLineWrapCache.clear();
  }

  let inCodeBlock = false;
  let codeLanguage = "";

  const marginSpaces = hideTimeline ? "  " : "│    ";
  const innerCodeSpaces = hideTimeline ? "     " : "│    │  ";

  for (let idx = 0; idx < rawLines.length; idx++) {
    const l = rawLines[idx];
    const isLastLine = idx === rawLines.length - 1;
    const cacheKey = `${themeColor}_${chatWidth}_${inCodeBlock}_${codeLanguage}_${lineIndex}_${l}_${hideTimeline ? "h" : "s"}`;

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
          <Text color="gray" dimColor>{marginSpaces}</Text>
          <Text color="gray" italic>
            {inCodeBlock ? `┌─── [ CODE: ${codeLanguage || "TEXT"} ]` : "└─── [ END CODE ]"}
          </Text>
        </Box>
      );
      lineResult.push({ node, lineIndex, type: "assistant" });
    } else if (inCodeBlock) {
      const subLines = wrapTextForDisplay(l, chatWidth - innerCodeSpaces.length);
      for (const subLine of subLines) {
        const node = (
          <Box flexDirection="row">
            <Text color="gray" dimColor>{innerCodeSpaces}</Text>
            <Text color="gray">{subLine}</Text>
          </Box>
        );
        lineResult.push({ node, lineIndex, type: "assistant" });
      }
    } else if (l.startsWith("# ")) {
      const subLines = wrapTextForDisplay(l.slice(2), chatWidth - marginSpaces.length);
      for (const subLine of subLines) {
        const node = (
          <Box flexDirection="row">
            <Text color="gray" dimColor>{marginSpaces}</Text>
            <Text bold color="yellow">{subLine}</Text>
          </Box>
        );
        lineResult.push({ node, lineIndex, type: "assistant" });
      }
    } else if (l.startsWith("## ")) {
      const subLines = wrapTextForDisplay(l.slice(3), chatWidth - marginSpaces.length);
      for (const subLine of subLines) {
        const node = (
          <Box flexDirection="row">
            <Text color="gray" dimColor>{marginSpaces}</Text>
            <Text bold color="cyan">{subLine}</Text>
          </Box>
        );
        lineResult.push({ node, lineIndex, type: "assistant" });
      }
    } else if (l.startsWith("### ")) {
      const subLines = wrapTextForDisplay(l.slice(4), chatWidth - marginSpaces.length);
      for (const subLine of subLines) {
        const node = (
          <Box flexDirection="row">
            <Text color="gray" dimColor>{marginSpaces}</Text>
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

      const subLines = wrapTextForDisplay(remainingText, chatWidth - marginSpaces.length - visibleLength(listPrefix));
      for (let sIdx = 0; sIdx < subLines.length; sIdx++) {
        const subLine = subLines[sIdx];
        const isFirstSubLine = sIdx === 0;
        
        const node = (
          <Box flexDirection="row">
            <Text color="gray" dimColor>{marginSpaces}</Text>
            {isSysLine ? (
              isFirstSubLine ? (
                <Text>{listPrefix}</Text>
              ) : (
                <Text>{" ".repeat(listPrefix.length)}</Text>
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
  chatWidth: number,
  hideTimeline: boolean
): WrappedChatLine[] {
  const child = {
    ...rawChild,
    content: rawChild.content.replace(/\r\n/g, "\n").replace(/\r/g, "")
  };
  const result: WrappedChatLine[] = [];

  const childPrefix = hideTimeline ? "      " : "│        ";
  const nestedChildPrefix = hideTimeline ? "           " : "│        │    ";

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
              <Text color="gray" dimColor>{childPrefix}</Text>
              <Text color={statusColor}>
                <Text bold color={statusColor}>{statusIcon} ❓ </Text><Text color="yellow">{questionText}</Text><Text bold color={statusColor}> → </Text><Text color={statusColor}>{answerText || "N/A"}</Text> <Text dimColor italic>(Ctrl+O)</Text>
              </Text>
            </Box>
          );
          const plainText = childPrefix + statusIcon + " ❓ " + questionText + " → " + (answerText || "N/A") + " (Ctrl+O)";
          result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isCollapsible: true, length: visibleLength(plainText) });
        } else {
          const diffMatch = merged.content.match(/\+(\d+)\s+-(\d+)/);
          const diffStats = diffMatch
            ? { added: parseInt(diffMatch[1], 10), removed: parseInt(diffMatch[2], 10) }
            : null;
          const node = (
            <Box flexDirection="row">
              <Text color="gray" dimColor>{childPrefix}</Text>
              <Text color="gray">
                <Text bold color="gray">↳ </Text><Text color="gray">{displayDesc}</Text>
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
          const diffStatsText = diffStats && diffStats.added === 0 && diffStats.removed === 0 ? "" : diffStats ? (" +" + diffStats.added + " -" + diffStats.removed) : "";
          const plainText = childPrefix + "↳ " + displayDesc + diffStatsText + " " + statusIcon + " " + statusLabel + "  (Ctrl+O)";
          result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isCollapsible: true, length: visibleLength(plainText) });
        }
      } else {
        const node = isAskQuestion ? (
          <Box flexDirection="row">
            <Text color="gray" dimColor>{childPrefix}</Text>
            <Text color="yellow">
              <Text bold color="yellow">↳ ❓ Question: </Text><Text color="yellow">{questionText}</Text>
            </Text>
          </Box>
        ) : (
          <Box flexDirection="row">
            <Text color="gray" dimColor>{childPrefix}</Text>
            <Text color="gray">
              <Text bold color="gray">↳ </Text><Text color="gray">{cleanDesc}</Text> <Text dimColor italic>(click to view inputs)</Text>
            </Text>
          </Box>
        );
        const plainText = isAskQuestion ? (childPrefix + "↳ ❓ Question: " + questionText) : (childPrefix + "↳ " + cleanDesc + " (click to view inputs)");
        result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isCollapsible: true, length: visibleLength(plainText) });
      }
    } else {
      const inputLines = content.split("\n");
      const mergedOutputLines = merged ? merged.content.split("\n") : [];
      const mergedColor = merged?.isError ? "red" : "gray";
      const mergedIcon = merged?.isError ? "✗" : "✓";

      const expandedDiffMatch = merged ? merged.content.match(/\+(\d+)\s+-(\d+)/) : null;
      const expandedDiffStats = expandedDiffMatch
        ? { added: parseInt(expandedDiffMatch[1], 10), removed: parseInt(expandedDiffMatch[2], 10) }
        : null;
      const headerNode = (
        <Box flexDirection="row">
          <Text color="gray" dimColor>{childPrefix}</Text>
          <Text color="gray">▼ </Text>
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
      const diffStatsText = expandedDiffStats && !(expandedDiffStats.added === 0 && expandedDiffStats.removed === 0) ? (" +" + expandedDiffStats.added + " -" + expandedDiffStats.removed) : "";
      const plainText = childPrefix + "▼ " + cleanDesc + (merged ? " " + mergedIcon : "") + diffStatsText + " (click to collapse)";
      result.push({ node: headerNode, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isHeader: true, isCollapsible: true, length: visibleLength(plainText) });

      for (let idx = 1; idx < inputLines.length; idx++) {
        const l = inputLines[idx];
        const subLines = wrapTextForDisplay(l, chatWidth - nestedChildPrefix.length);
        for (const subLine of subLines) {
          const node = (
            <Box flexDirection="row">
              <Text color="gray" dimColor>{childPrefix}</Text>
              <Text color="gray">    </Text>
              <Text bold color="white">{subLine}</Text>
            </Box>
          );
          result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isCollapsible: true });
        }
      }

      if (merged) {
        const dividerNode = (
          <Box flexDirection="row">
            <Text color="gray" dimColor>{childPrefix}</Text>
            <Text color={mergedColor}>    {"─".repeat(30)}</Text>
          </Box>
        );
        result.push({ node: dividerNode, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isSeparator: true, isCollapsible: true });

        for (const l of mergedOutputLines) {
          if (l.startsWith("Output:") || l.startsWith("Detail:")) {
            const labelType = l.startsWith("Output:") ? "Output: " : "Detail: ";
            const rest = l.substring(labelType.length);
            const subLines = wrapTextForDisplay(rest, chatWidth - nestedChildPrefix.length - labelType.length);
            for (let sIdx = 0; sIdx < subLines.length; sIdx++) {
              const sub = subLines[sIdx];
              const isFirstSub = sIdx === 0;
              const node = (
                <Box flexDirection="row">
                  <Text color="gray" dimColor>{childPrefix}</Text>
                  {isFirstSub ? (
                    <Text>
                      <Text color={mergedColor}>    </Text>
                      <Text bold color={merged.isError ? "cyan" : "gray"} dimColor={!merged.isError}>{labelType}</Text>
                      <Text dimColor>{sub}</Text>
                    </Text>
                  ) : (
                    <Text>
                      <Text color={mergedColor}>    </Text>
                      {" ".repeat(labelType.length)}
                      <Text dimColor>{sub}</Text>
                    </Text>
                  )}
                </Box>
              );
              result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isCollapsible: true });
            }
          } else {
            const subLines = wrapTextForDisplay(l, chatWidth - nestedChildPrefix.length);
            for (const subLine of subLines) {
              const node = (
                <Box flexDirection="row">
                  <Text color="gray" dimColor>{childPrefix}</Text>
                  <Text color={mergedColor}>    </Text>
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
      let answerText = "";
      if (isAskQuestion) {
        const lines = contentText.split("\n");
        const outputLine = lines.find(l => l.startsWith("Output:"));
        answerText = outputLine ? outputLine.substring("Output:".length).trim() : "";
      }
      const node = isAskQuestion ? (
        <Box flexDirection="row">
          <Text color="gray" dimColor>{childPrefix}</Text>
          <Text color={themeColor}>
            <Text bold color={themeColor}>{isError ? "↳ ✗ " : "↳ ✓ "}</Text><Text bold color={themeColor}>Question: </Text><Text color={themeColor}>{questionText}</Text><Text bold color={themeColor}> | Answer: </Text><Text color={themeColor}>{answerText || "N/A"}</Text>
          </Text>
        </Box>
      ) : (
        <Box flexDirection="row">
          <Text color="gray" dimColor>{childPrefix}</Text>
          <Text color={themeColor}>
            <Text bold color={themeColor}>{isError ? "↳ ✗ " : "↳ ✓ "}</Text><Text color={themeColor}>{cleanDesc}</Text> <Text dimColor italic>{isError ? "(click to view error)" : "(click to view output)"}</Text>
          </Text>
        </Box>
      );
      const plainText = isAskQuestion
        ? (childPrefix + (isError ? "↳ ✗ " : "↳ ✓ ") + "Question: " + questionText + " | Answer: " + (answerText || "N/A"))
        : (childPrefix + (isError ? "↳ ✗ " : "↳ ✓ ") + cleanDesc + " " + (isError ? "(click to view error)" : "(click to view output)"));
      result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_end", isCollapsible: true, length: visibleLength(plainText) });
    } else {
      const contentLines = contentText.split("\n");
      for (let idx = 0; idx < contentLines.length; idx++) {
        const l = contentLines[idx];
        const isFirstLine = idx === 0;
        const cleanLine = l.replace(/^(Completed|Failed|Loaded instructions)\s*-\s*/i, "").trim();

        const subLines = wrapTextForDisplay(isFirstLine ? cleanLine : l, chatWidth - nestedChildPrefix.length);
        for (let sIdx = 0; sIdx < subLines.length; sIdx++) {
          const subLine = subLines[sIdx];
          const isFirstSub = isFirstLine && sIdx === 0;

          const node = (
            <Box flexDirection="row">
              <Text color="gray" dimColor>{childPrefix}</Text>
              <Text color={themeColor}>
                {isFirstSub ? (isError ? "▼ ✗ " : "▼ ✓ ") : "    "}
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
          const length = isFirstSub
            ? visibleLength(childPrefix + (isError ? "▼ ✗ " : "▼ ✓ ") + subLine + " (click to collapse)")
            : undefined;
          result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_end", isCollapsible: true, length });
        }
      }
    }
  } else {
    const contentLines = child.content.split("\n");
    for (const l of contentLines) {
      const subLines = wrapTextForDisplay(l, chatWidth - nestedChildPrefix.length);
      for (const subLine of subLines) {
        const node = (
          <Box flexDirection="row">
            <Text color="gray" dimColor>{nestedChildPrefix}</Text>
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
  hideTimeline,
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
  hideTimeline: boolean;
}): WrappedChatLine[] {
  const result: WrappedChatLine[] = [];

  const marginSpaces = hideTimeline ? "  " : "│    ";
  const separatorSpaces = hideTimeline ? " " : "│ ";
  const connectorPrefix = hideTimeline ? "  [ " : "├─── [ ";
  const connectorPlain = hideTimeline ? "  " : "├───";

  switch (line.type) {
    case "user": {
      const content = line.content.replace(/^❯ /, "");
      const headerNode = (
        <Box flexDirection="row">
          <Text color="gray" dimColor>
            {hideTimeline ? "  [ " : `${isFirst ? "┌" : "├"}─── [ `}<Text bold color="cyan">👤 ACCESS_POINT: USER</Text> ]{lineIndex !== undefined ? <Text dimColor> [#{lineIndex}]</Text> : null}
          </Text>
        </Box>
      );
      result.push({ node: headerNode, lineIndex, type: "user", isHeader: true });

      const subLines = wrapTextForDisplay(content, chatWidth - marginSpaces.length);
      for (const subLine of subLines) {
        const node = (
          <Box flexDirection="row">
            <Text color="gray" dimColor>{marginSpaces}</Text>
            <Text>{renderBoldTargetText(subLine)}</Text>
          </Box>
        );
        result.push({ node, lineIndex, type: "user" });
      }

      const separatorNode = (
        <Box flexDirection="row">
          <Text color="gray" dimColor>{separatorSpaces}</Text>
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
          <Text color="gray" dimColor>
            {hideTimeline ? "  [ " : `${isFirst ? "┌" : "├"}─── [ `}<Text bold color="gray">✦ SUPERAGENT</Text> ]{lineIndex !== undefined ? <Text color="gray"> [#{lineIndex}]</Text> : null}
          </Text>
        </Box>
      );
      result.push({ node: headerNode, lineIndex, type: "assistant", isHeader: true, isTruncated: capped.truncated });

      const contentLines = wrapMarkdownToLines(capped.text, "gray", chatWidth, lineIndex, hideTimeline);
      for (const wrappedContentLine of contentLines) {
        result.push({
          ...wrappedContentLine,
          isTruncated: capped.truncated,
        });
      }

      if (capped.truncated) {
        const noticeNode = (
          <Box flexDirection="row">
            <Text color="gray" dimColor>{marginSpaces}</Text>
            <Text color="yellow">... [long response truncated; click to open scroll view, mouse scroll / ↑↓] ...</Text>
          </Box>
        );
        result.push({ node: noticeNode, lineIndex, type: "assistant", isTruncated: true });
      }

      const children = line.children || [];
      if (children.length > 0) {
        for (let childIdx = 0; childIdx < children.length; childIdx++) {
          const isChildCollapsed = isCollapsibleType(children[childIdx].type) && !expandedChildren.has(childIdx);
          const childLines = wrapNestedChild(children[childIdx], childIdx, isChildCollapsed, lineIndex, chatWidth, hideTimeline);
          result.push(...childLines);
        }
      }

      const separatorNode = (
        <Box flexDirection="row">
          <Text color="gray" dimColor>{separatorSpaces}</Text>
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
            <Text color="gray" dimColor>
              {connectorPrefix}<Text bold color="gray">▶ {desc}</Text><Text dimColor> ({toolName})</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
        const plainText = `${connectorPlain} [ ▶ ${desc} (${toolName}) ] Ctrl+O`;
        result.push({ node, lineIndex, type: "tool_start", isCollapsible: true, length: visibleLength(plainText) });
      } else {
        const headerNode = (
          <Box flexDirection="row">
            <Text color="gray" dimColor>
              {connectorPrefix}<Text bold color="gray">SYSTEM_INVOKING_MODULE</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
        const plainText = `${connectorPlain} [ SYSTEM_INVOKING_MODULE ] Ctrl+O`;
        result.push({ node: headerNode, lineIndex, type: "tool_start", isHeader: true, isCollapsible: true, length: visibleLength(plainText) });

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

              const detailSubLines = wrapTextForDisplay(remaining, chatWidth - marginSpaces.length - (prefix.length + toolName.length + 2));
              for (let sIdx = 0; sIdx < detailSubLines.length; sIdx++) {
                const sub = detailSubLines[sIdx];
                const isFirstSub = sIdx === 0;

                const node = (
                  <Box flexDirection="row">
                    <Text color="gray" dimColor>{marginSpaces}</Text>
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

          const subLines = wrapTextForDisplay(l, chatWidth - marginSpaces.length);
          for (const subLine of subLines) {
            const node = (
              <Box flexDirection="row">
                <Text color="gray" dimColor>{marginSpaces}</Text>
                <Text bold color="white">{subLine}</Text>
              </Box>
            );
            result.push({ node, lineIndex, type: "tool_start", isCollapsible: true });
          }
        }

        const separatorNode = (
          <Box flexDirection="row">
            <Text color="gray" dimColor>{separatorSpaces}</Text>
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
            <Text color="gray" dimColor>
              {connectorPrefix}<Text bold color={themeColor}>▶ {icon} {status}:</Text> <Text dimColor>{desc}</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
        const plainText = `${connectorPlain} [ ▶ ${icon} ${status}: ${desc} ] Ctrl+O`;
        result.push({ node, lineIndex, type: "tool_end", isCollapsible: true, length: visibleLength(plainText) });
      } else {
        const headerNode = (
          <Box flexDirection="row">
            <Text color="gray" dimColor>
              {connectorPrefix}<Text bold color={themeColor}>{isError ? "🔴 SYSTEM_CALL_FAILED" : "⚪ SYSTEM_CALL_SUCCESS"}</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
        const label = isError ? "🔴 SYSTEM_CALL_FAILED" : "⚪ SYSTEM_CALL_SUCCESS";
        const plainText = `${connectorPlain} [ ${label} ] Ctrl+O`;
        result.push({ node: headerNode, lineIndex, type: "tool_end", isHeader: true, isCollapsible: true, length: visibleLength(plainText) });

        const contentLines = contentText.split("\n");
        for (const l of contentLines) {
          if (l.startsWith("Output:") || l.startsWith("Detail:")) {
            const type = l.startsWith("Output:") ? "Output: " : "Detail: ";
            const rest = l.substring(type.length);

            const subLines = wrapTextForDisplay(rest, chatWidth - marginSpaces.length - type.length);
            for (let sIdx = 0; sIdx < subLines.length; sIdx++) {
              const sub = subLines[sIdx];
              const isFirstSub = sIdx === 0;

              const node = (
                <Box flexDirection="row">
                  <Text color="gray" dimColor>{marginSpaces}</Text>
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

          const subLines = wrapTextForDisplay(l, chatWidth - marginSpaces.length);
          for (const subLine of subLines) {
            const node = (
              <Box flexDirection="row">
                <Text color="gray" dimColor>{marginSpaces}</Text>
                <Text color={isError ? "white" : "gray"} dimColor={!isError}>{subLine}</Text>
              </Box>
            );
            result.push({ node, lineIndex, type: "tool_end", isCollapsible: true });
          }
        }

        const separatorNode = (
          <Box flexDirection="row">
            <Text color="gray" dimColor>{separatorSpaces}</Text>
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
            <Text color="gray" dimColor>
              {connectorPrefix}<Text bold color="red">▶ 🚨 Error:</Text> <Text dimColor>{preview}</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
        const plainText = `${connectorPlain} [ ▶ 🚨 Error: ${preview} ] Ctrl+O`;
        result.push({ node, lineIndex, type: "error", isCollapsible: true, length: visibleLength(plainText) });
      } else {
        const headerNode = (
          <Box flexDirection="row">
            <Text color="gray" dimColor>
              {connectorPrefix}<Text bold color="red">🚨 ERROR_REPORT</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
        const plainText = `${connectorPlain} [ 🚨 ERROR_REPORT ] Ctrl+O`;
        result.push({ node: headerNode, lineIndex, type: "error", isHeader: true, isCollapsible: true, length: visibleLength(plainText) });

        const contentLines = contentText.split("\n");
        for (const l of contentLines) {
          const subLines = wrapTextForDisplay(l, chatWidth - marginSpaces.length);
          for (const subLine of subLines) {
            const node = (
              <Box flexDirection="row">
                <Text color="gray" dimColor>{marginSpaces}</Text>
                <Text color="red">{subLine}</Text>
              </Box>
            );
            result.push({ node, lineIndex, type: "error", isCollapsible: true });
          }
        }

        const separatorNode = (
          <Box flexDirection="row">
            <Text color="gray" dimColor>{separatorSpaces}</Text>
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
            <Text color="gray" dimColor>
              {connectorPrefix}<Text bold color="gray">▶ ℹ️ System:</Text> <Text dimColor>{preview}</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
        const plainText = `${connectorPlain} [ ▶ ℹ️ System: ${preview} ] Ctrl+O`;
        result.push({ node, lineIndex, type: "system", isCollapsible: true, length: visibleLength(plainText) });
      } else {
        const headerNode = (
          <Box flexDirection="row">
            <Text color="gray" dimColor>
              {connectorPrefix}<Text bold color="gray">ℹ️ SYSTEM_INFO</Text> ] <Text dimColor italic>Ctrl+O</Text>
            </Text>
          </Box>
        );
        const plainText = `${connectorPlain} [ ℹ️ SYSTEM_INFO ] Ctrl+O`;
        result.push({ node: headerNode, lineIndex, type: "system", isHeader: true, isCollapsible: true, length: visibleLength(plainText) });

        const contentLines = line.content.split("\n");
        for (const l of contentLines) {
          const subLines = wrapTextForDisplay(l, chatWidth - marginSpaces.length);
          for (const subLine of subLines) {
            const node = (
              <Box flexDirection="row">
                <Text color="gray" dimColor>{marginSpaces}</Text>
                <Text color="gray" italic>{subLine}</Text>
              </Box>
            );
            result.push({ node, lineIndex, type: "system", isCollapsible: true });
          }
        }

        const separatorNode = (
          <Box flexDirection="row">
            <Text color="gray" dimColor>{separatorSpaces}</Text>
          </Box>
        );
        result.push({ node: separatorNode, lineIndex, type: "system", isSeparator: true, isCollapsible: true });
      }
      break;
    }
    default: {
      const headerNode = (
        <Box flexDirection="row">
          <Text color="gray" dimColor>
            {connectorPrefix}<Text bold color="gray">COMM_PACKET</Text> ]
          </Text>
        </Box>
      );
      result.push({ node: headerNode, lineIndex, type: "default" });

      const contentLines = line.content.split("\n");
      for (const l of contentLines) {
        const subLines = wrapTextForDisplay(l, chatWidth - marginSpaces.length);
        for (const subLine of subLines) {
          const node = (
            <Box flexDirection="row">
              <Text color="gray" dimColor>{marginSpaces}</Text>
              <Text>{subLine}</Text>
            </Box>
          );
          result.push({ node, lineIndex, type: "default" });
        }
      }

      const separatorNode = (
        <Box flexDirection="row">
          <Text color="gray" dimColor>{separatorSpaces}</Text>
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
  isLastAssistant: boolean,
  hideTimeline: boolean
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
    childrenKey,
    hideTimeline ? "h" : "s"
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
  reasoningDisplay,
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
  reasoningDisplay?: string;
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

  const hideTimeline = getSettings().hideTimeline ?? false;

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

    const cacheKey = getLineCacheKey(lines[idx], idx, chatWidth, isCollapsed, childSet, isLastAssistant, hideTimeline);
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
        hideTimeline,
      });
      lineWrapCache.set(cacheKey, wrapped);
    }
    result.push(...wrapped);
  }

  // 2. Append Live Streaming / Thinking / Tool Output
  const isLastLinesEmpty = lines.length === 0;
  const borderPrefix = isLastLinesEmpty ? "┌" : "├";

  const marginSpaces = hideTimeline ? "  " : "│    ";
  const connectorPrefix = hideTimeline ? "  [ " : "├─── [ ";
  const connectorPlain = hideTimeline ? "  " : "├───";

  const shouldRenderStream = isProcessing && streamDisplay && streamDisplay.trim().length > 0;
  if (shouldRenderStream) {
    const headerNode = (
      <Box flexDirection="row">
        <Text color="gray" dimColor>
          {hideTimeline ? "  [ " : `${borderPrefix}─── [ `}<Text bold color="gray">✦ SUPERAGENT (STREAMING...)</Text> ]
        </Text>
      </Box>
    );
    result.push({ node: headerNode, lineIndex: -1, type: "assistant", isHeader: true });

    const contentLines = wrapMarkdownToLines(streamDisplay, "gray", chatWidth, -1, hideTimeline);
    result.push(...contentLines);
  }

  const shouldRenderThinking = isProcessing && (!streamDisplay || streamDisplay.trim().length === 0) && !isExecutingTool;
  if (shouldRenderThinking) {
    const headerNode = (
      <Box flexDirection="row">
        <Text color="gray" dimColor>
          {hideTimeline ? "  [ " : `${borderPrefix}─── [ `}<Text bold color="gray">✦ SUPERAGENT (THINKING...)</Text> ]
        </Text>
      </Box>
    );
    result.push({ node: headerNode, lineIndex: -1, type: "assistant", isHeader: true });

    if (reasoningDisplay && reasoningDisplay.trim().length > 0) {
      const rLines = reasoningDisplay.trim().split("\n");
      const reasoningHeader = (
        <Box flexDirection="row">
          <Text color="gray" dimColor>{marginSpaces}</Text>
          <Text color="gray" italic>[Reasoning]</Text>
        </Box>
      );
      result.push({ node: reasoningHeader, lineIndex: -1, type: "assistant" });

      for (const rLine of rLines) {
        const subLines = wrapTextForDisplay(rLine, chatWidth - marginSpaces.length - 2);
        for (const subLine of subLines) {
          const bodyNode = (
            <Box flexDirection="row">
              <Text color="gray" dimColor>{marginSpaces}</Text>
              <Text color="gray" dimColor>  {subLine}</Text>
            </Box>
          );
          result.push({ node: bodyNode, lineIndex: -1, type: "assistant" });
        }
      }
    } else {
      const bodyNode = (
        <Box flexDirection="row">
          <Text color="gray" dimColor>{marginSpaces}</Text>
          <LoadingIndicator />
        </Box>
      );
      result.push({ node: bodyNode, lineIndex: -1, type: "assistant" });
    }
  }

  if (isExecutingTool) {
    const headerNode = (
      <Box flexDirection="row">
        <Text color="gray" dimColor>
          {hideTimeline ? "  [ " : `${borderPrefix}─── [ `}<Text bold color="gray">SYSTEM_CALL: EXECUTING...{timeLeft !== null ? ` (${timeLeft}s left)` : ""}</Text> ]
        </Text>
      </Box>
    );
    result.push({ node: headerNode, lineIndex: -1, type: "tool_start", isHeader: true });

    const spinnerNode = (
      <Box flexDirection="row">
        <Text color="gray" dimColor>{marginSpaces}</Text>
        <ToolLoadingIndicator />
      </Box>
    );
    result.push({ node: spinnerNode, lineIndex: -1, type: "tool_start" });

    const activeToolLines = activeToolOutput ? activeToolOutput.trim().split("\n").slice(-8) : [];
    if (activeToolLines.length > 0) {
      const liveOutputHeader = (
        <Box flexDirection="row">
          <Text color="gray" dimColor>{connectorPrefix}</Text><Text bold color="gray">SYSTEM_CALL_OUTPUT (LIVE)</Text><Text color="gray" dimColor> ]</Text>
        </Box>
      );
      result.push({ node: liveOutputHeader, lineIndex: -1, type: "tool_start" });

      for (const line of activeToolLines) {
        const subLines = wrapTextForDisplay(line, chatWidth - marginSpaces.length);
        for (const subLine of subLines) {
          const node = (
            <Box flexDirection="row">
              <Text color="gray" dimColor>{marginSpaces}</Text>
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
  classifierStatus?: "offline" | "loading" | "online";
  embeddingStatus?: "offline" | "loading" | "online";
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
  reasoningDisplay?: string;
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
    classifierStatus,
    embeddingStatus,
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
    reasoningDisplay,
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
      reasoningDisplay,
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
    reasoningDisplay,
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
          length: line.length,
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
      {showBanner && <Banner classifierStatus={classifierStatus} embeddingStatus={embeddingStatus} />}

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
