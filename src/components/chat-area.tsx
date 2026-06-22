import React, { useMemo, useEffect, memo } from "react";
import { Box, Text } from "ink";
import { Banner } from "./banner.js";
import { ChatLineComponent, renderMarkdown, truncateStreamDisplay, isCollapsibleType } from "./chat-line.js";
import { LoadingIndicator, ToolLoadingIndicator } from "./common/LoadingIndicators.js";
import { getTruncatedAssistantIndexes, wrapTextForDisplay, renderScrollBar, capDisplayLines } from "../utils/responseScroll.js";
import type { ChatLine } from "../core/slash-commands.js";
import type { ChatLinePosition } from "../hooks/useMouseScroll.js";

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
  /** Set of expanded line indexes (for collapsible tool/system/error messages) */
  expandedLines?: Set<number>;
  /** Toggle expand/collapse for a specific line index */
  toggleLineExpand?: (index: number) => void;
  /** Map of parent line index -> Set of expanded child indexes (for nested tool children) */
  expandedChildren?: Map<number, Set<number>>;
  /** Toggle expand/collapse for a nested child line */
  toggleChildExpand?: (parentIndex: number, childIndex: number) => void;
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
  } = props;

  const chatWidth = Math.max(20, terminalWidth - 6);

  const estimateMarkdownLines = (text: string, width: number): number => {
    let count = 0;
    const rawLines = text.split("\n");
    for (const l of rawLines) {
      count += Math.max(1, Math.ceil(l.length / width));
    }
    return count;
  };

  const estimateChatLineHeight = (line: ChatLine, width: number, isLastAssistant: boolean = false, lineIdx: number = -1): number => {
    // Collapsed items are just 1 line (compact header)
    if (lineIdx >= 0 && isCollapsibleType(line.type) && !expandedLines.has(lineIdx)) {
      return 1;
    }

    // Content width accounts for the "│    " prefix (5 visual chars) in assistant rendering
    const assistantContentWidth = Math.max(10, width - 5);
    // Nested child content width: indent("│    " = 5) + "│    " (5) + indicator("▼ ✓ " = 4) = 14 chars prefix
    const childContentWidth = Math.max(10, width - 14);

    let linesCount = 2; // Border header + closing lines

    if (line.type === "assistant" && !isLastAssistant) {
      // Apply capDisplayLines like the actual rendering does
      const capped = capDisplayLines(line.content, maxAssistantResponseLines + 1, assistantContentWidth);
      const textLines = capped.text.split("\n");
      for (const l of textLines) {
        linesCount += Math.max(1, Math.ceil(l.length / assistantContentWidth));
      }
      if (capped.truncated) linesCount += 1; // truncation indicator line
    } else {
      const textLines = line.content.split("\n");
      for (const l of textLines) {
        let rawText = l;
        if (line.type === "user") {
          rawText = l.replace(/^❯ /, "");
        } else if (line.type === "tool_start") {
          rawText = l.replace(/^⚡ /, "");
        }
        linesCount += Math.max(1, Math.ceil(rawText.length / width));
      }
    }

    // Account for nested children
    if (line.children && line.children.length > 0) {
      const childExpanded = expandedChildren.get(lineIdx) || new Set();
      for (let ci = 0; ci < line.children.length; ci++) {
        const child = line.children[ci];
        const childIsCollapsed = isCollapsibleType(child.type) && !childExpanded.has(ci);
        if (childIsCollapsed) {
          linesCount += 1; // Collapsed = 1 line (compact summary)
        } else {
          // Expanded = just content lines (no header/closing)
          const childLines = child.content.split("\n");
          for (const cl of childLines) {
            linesCount += Math.max(1, Math.ceil(cl.length / childContentWidth));
          }
        }
      }
    }
    return linesCount;
  };

  const activeToolLines = activeToolOutput ? activeToolOutput.trim().split("\n").slice(-8) : [];
  const activeToolLinesCount = activeToolLines.length;

  // Find the last assistant message index in the full lines array.
  // When streaming, the live response is shown separately (always untruncated),
  // so all completed messages in `lines` count as "previous" and may be truncated.
  // When NOT streaming, the last assistant message is the "final" response
  // and should be shown in full without hide/truncate.
  const shouldRenderStreamNow = scrollOffset === 0 && isProcessing && streamDisplay && streamDisplay.trim().length > 0;
  const lastAssistantIdx = useMemo(() => {
    if (shouldRenderStreamNow) return -1;
    for (let j = lines.length - 1; j >= 0; j--) {
      if (lines[j].type === "assistant") return j;
    }
    return -1;
  }, [lines, shouldRenderStreamNow]);

  // Calculate visible line positions for mouse click detection
  const truncatedIndexes = useMemo(
    () => getTruncatedAssistantIndexes(lines, maxAssistantResponseLines, chatWidth),
    [lines, maxAssistantResponseLines, chatWidth]
  );

  const visibleLinePositions = useMemo(() => {
    if (focusedResponseIndex !== null) return [];

    const shouldRenderStream = scrollOffset === 0 && isProcessing && streamDisplay && streamDisplay.trim().length > 0;
    let startIndex = lines.length;
    let accumulatedHeight = 0;
    const endIndex = scrollOffset === 0 ? lines.length : Math.max(0, lines.length - scrollOffset);

    let effectiveLimit = chatHeightLimit;
    if (shouldRenderStream) {
      effectiveLimit = Math.max(0, chatHeightLimit - estimateMarkdownLines(streamDisplay, chatWidth));
    }

    for (let i = endIndex - 1; i >= 0; i--) {
      const h = estimateChatLineHeight(lines[i], chatWidth, i === lastAssistantIdx, i);
      if (accumulatedHeight + h > effectiveLimit) {
        if (i === endIndex - 1 && effectiveLimit > 0) startIndex = i;
        break;
      }
      accumulatedHeight += h;
      startIndex = i;
    }

    let currentRow = chatContentStartRow;
    const positions: ChatLinePosition[] = [];
    for (let i = startIndex; i < endIndex; i++) {
      const line = lines[i];
      const h = estimateChatLineHeight(line, chatWidth, i === lastAssistantIdx, i);
      const isCollapsible = isCollapsibleType(line.type);

      if (line.type === "assistant" && line.children && line.children.length > 0) {
        // Calculate parent text height (header + text + truncation + closing, without children)
        // Use contentWidth to account for "│    " prefix (5 chars) in renderMarkdown
        const contentWidth = Math.max(10, chatWidth - 5);
        let parentH = 2; // header + closing

        if (i !== lastAssistantIdx) {
          // Apply capDisplayLines like the actual rendering does
          const capped = capDisplayLines(line.content, (maxAssistantResponseLines || 12) + 1, contentWidth);
          const textLines = capped.text.split("\n");
          for (const l of textLines) {
            parentH += Math.max(1, Math.ceil(l.length / contentWidth));
          }
          if (capped.truncated) parentH += 1; // truncation indicator line
        } else {
          const textLines = line.content.split("\n");
          for (const l of textLines) {
            parentH += Math.max(1, Math.ceil(l.length / contentWidth));
          }
        }
        // Calculate parent text height without the closing line
        const parentHWithoutClosing = parentH - 1;

        // Parent top part position (header + text)
        positions.push({
          index: i,
          startRow: currentRow,
          endRow: currentRow + parentHWithoutClosing - 1,
          isTruncated: truncatedIndexes.includes(i),
          type: "assistant",
          isCollapsible: false,
        });
        currentRow += parentHWithoutClosing;

        // Child positions
        // Nested child content width: indent("│    " = 5) + "│    " (5) + indicator("▼ ✓ " = 4) = 14 chars prefix
        const childContentWidth = Math.max(10, chatWidth - 14);
        const childExpanded = expandedChildren.get(i) || new Set();
        for (let ci = 0; ci < line.children.length; ci++) {
          const child = line.children[ci];
          const childIsCollapsible = isCollapsibleType(child.type);
          const childIsCollapsed = childIsCollapsible && !childExpanded.has(ci);
          let childH: number;
          if (childIsCollapsed) {
            childH = 1;
          } else {
            // Expanded = just content lines (no header/closing)
            const childLines = child.content.split("\n");
            childH = 0;
            for (const cl of childLines) {
              childH += Math.max(1, Math.ceil(cl.length / childContentWidth));
            }
            if (childH === 0) childH = 1; // minimum 1 row for empty content
          }
          positions.push({
            index: i,
            parentIndex: i,
            childIndex: ci,
            startRow: currentRow,
            endRow: currentRow + childH - 1,
            isTruncated: false,
            type: child.type,
            isCollapsible: childIsCollapsible,
          });
          currentRow += childH;
        }

        // Parent closing line position (1 row)
        positions.push({
          index: i,
          startRow: currentRow,
          endRow: currentRow,
          isTruncated: truncatedIndexes.includes(i),
          type: "assistant",
          isCollapsible: false,
        });
        currentRow += 1;
      } else {
        positions.push({
          index: i,
          startRow: currentRow,
          endRow: currentRow + h - 1,
          isTruncated: truncatedIndexes.includes(i),
          type: line.type,
          isCollapsible,
        });
        currentRow += h;
      }
    }
    return positions;
  }, [lines, scrollOffset, chatHeightLimit, chatWidth, chatContentStartRow, focusedResponseIndex, isProcessing, streamDisplay, truncatedIndexes, lastAssistantIdx, expandedLines, expandedChildren]);

  useEffect(() => {
    if (onVisibleLinesChange) {
      onVisibleLinesChange(visibleLinePositions);
    }
  }, [visibleLinePositions, onVisibleLinesChange]);

  return (
    <>
      {showBanner && <Banner />}

      {/* Messages Header */}
      <Box flexDirection="row" justifyContent="space-between" paddingX={1} marginBottom={0}>
        <Text color={focusMode === "chat" ? "green" : "cyan"}>
          ┌───[ <Text bold color={focusMode === "chat" ? "green" : "cyan"}>💬 CONVERSATION LOG</Text>
          {focusMode === "chat" && <Text dimColor> [↑/▼ Scroll • Esc Exit]</Text>} ]
        </Text>
        {scrollOffset > 0 && (
          <Text color="yellow" bold>
            [Scroll: -{scrollOffset} lines/msgs - Esc to snap bottom]
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
                ┌───[ <Text bold color="yellow">RESPONSE_SCROLL</Text><Text dimColor> {currentPosition + 1}/{Math.max(1, truncatedIndexes.length)} line {safeOffset + 1}-{visibleEnd} / {responseLines.length} {renderScrollBar(safeOffset, focusWindowHeight, responseLines.length)} | ↑/↓ scroll | Esc close | click to close</Text> ]
              </Text>
              {renderMarkdown(visibleText, "blue")}
              <Text color="yellow">└───[ focused assistant response #{focusedResponseIndex + 1} ]</Text>
            </Box>
          );
        })() : (() => {
          const shouldRenderStream = scrollOffset === 0 && isProcessing && streamDisplay && streamDisplay.trim().length > 0;
          let startIndex = lines.length;
          let accumulatedHeight = 0;
          const endIndex = scrollOffset === 0 ? lines.length : Math.max(0, lines.length - scrollOffset);

          let effectiveChatHeightLimit = chatHeightLimit;
          if (shouldRenderStream) {
            const totalStreamLines = estimateMarkdownLines(streamDisplay, chatWidth);
            effectiveChatHeightLimit = Math.max(0, chatHeightLimit - totalStreamLines);
          }

          for (let i = endIndex - 1; i >= 0; i--) {
            const h = estimateChatLineHeight(lines[i], chatWidth, i === lastAssistantIdx, i);
            if (accumulatedHeight + h > effectiveChatHeightLimit) {
              if (i === endIndex - 1 && effectiveChatHeightLimit > 0) {
                startIndex = i; // Show at least the latest line if there is any history space
              }
              break;
            }
            accumulatedHeight += h;
            startIndex = i;
          }

          const visibleLines = lines.slice(startIndex, endIndex);

          return (
            <>
              {visibleLines.map((line, i) => {
                const originalIndex = startIndex + i;
                const isCollapsible = isCollapsibleType(line.type);
                const isCollapsed = isCollapsible && !expandedLines.has(originalIndex);
                return (
                  <ChatLineComponent
                    key={originalIndex}
                    line={line}
                    isFirst={false}
                    lineIndex={originalIndex}
                    tokensUp={tokensUp}
                    tokensDown={tokensDown}
                    modelName={modelName}
                    maxResponseLines={maxAssistantResponseLines}
                    chatWidth={chatWidth}
                    isLastAssistant={originalIndex === lastAssistantIdx}
                    isCollapsed={isCollapsed}
                    expandedChildren={expandedChildren.get(originalIndex) || new Set()}
                    toggleChildExpand={toggleChildExpand ? (childIdx: number) => toggleChildExpand(originalIndex, childIdx) : undefined}
                  />
                );
              })}

              {shouldRenderStream && (
                <Box flexDirection="column">
                  <Text color="blue">
                    {visibleLines.length === 0 ? "┌" : "├"}───[ <Text bold color="blue">✦ COGNITIVE_NODE: SUPERAGENT (STREAMING...)</Text><Text dimColor> (▲{formatCompactNumber(tokensUp)} | ▼{formatCompactNumber(tokensDown + liveStreamTokens)})</Text> ]
                  </Text>
                  {renderMarkdown(
                    streamDisplay,
                    "blue",
                    true
                  )}
                </Box>
              )}
            </>
          );
        })()}

        {scrollOffset === 0 && isProcessing && (!streamDisplay || streamDisplay.trim().length === 0) && !isExecutingTool && (
          <Box flexDirection="column" marginTop={2}>
            <Text color="blue">
              {lines.length === 0 ? "┌" : "├"}───[ <Text bold color="blue">✦ COGNITIVE_NODE: SUPERAGENT (THINKING...)</Text><Text dimColor> (▲{formatCompactNumber(tokensUp)} | ▼{formatCompactNumber(tokensDown)})</Text> ]
            </Text>
            <Box flexDirection="row">
              <Text color="blue">│    </Text>
              <LoadingIndicator />
            </Box>
          </Box>
        )}

        {scrollOffset === 0 && isExecutingTool && (
          <Box flexDirection="column" marginTop={2}>
            <Text color="yellow">
              {lines.length === 0 ? "┌" : "├"}───[ <Text bold color="yellow">⚙️ SYSTEM_CALL: EXECUTING...{timeLeft !== null ? ` (${timeLeft}s left)` : ""}</Text> ]
            </Text>
            <Box flexDirection="row">
              <Text color="yellow">│    </Text>
              <ToolLoadingIndicator />
            </Box>
            {activeToolLinesCount > 0 && (
              <>
                <Text color="yellow">
                  ├───[ <Text bold color="yellow">⚙️ SYSTEM_CALL_OUTPUT (LIVE)</Text> ]
                </Text>
                {activeToolLines.map((line, idx) => (
                  <Box key={idx} flexDirection="row">
                    <Text color="yellow">│    </Text>
                    <Text color="gray">{line}</Text>
                  </Box>
                ))}
              </>
            )}
          </Box>
        )}
      </Box>
    </>
  );
});
