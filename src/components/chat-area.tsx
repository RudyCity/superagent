import React, { useMemo, useEffect, memo } from "react";
import { Box, Text } from "ink";
import { Banner } from "./banner.js";
import { ChatLineComponent, renderMarkdown, truncateStreamDisplay } from "./chat-line.js";
import { LoadingIndicator, ToolLoadingIndicator } from "./common/LoadingIndicators.js";
import { getTruncatedAssistantIndexes, wrapTextForDisplay, renderScrollBar } from "../utils/responseScroll.js";
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

  const estimateChatLineHeight = (line: ChatLine, width: number): number => {
    let linesCount = 2; // Border header + spacing lines
    const textLines = line.content.split("\n");
    const maxContentLines = line.type === "assistant" ? maxAssistantResponseLines + 1 : Number.POSITIVE_INFINITY;
    for (const l of textLines) {
      let rawText = l;
      if (line.type === "user") {
        rawText = l.replace(/^❯ /, "");
      } else if (line.type === "tool_start") {
        rawText = l.replace(/^⚡ /, "");
      }
      linesCount += Math.max(1, Math.ceil(rawText.length / width));
      if (linesCount >= maxContentLines + 2) {
        return maxContentLines + 2;
      }
    }
    return linesCount;
  };

  const activeToolLines = activeToolOutput ? activeToolOutput.trim().split("\n").slice(-8) : [];
  const activeToolLinesCount = activeToolLines.length;

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
      const h = estimateChatLineHeight(lines[i], chatWidth);
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
      const h = estimateChatLineHeight(line, chatWidth);
      positions.push({
        index: i,
        startRow: currentRow,
        endRow: currentRow + h - 1,
        isTruncated: truncatedIndexes.includes(i),
        type: line.type,
      });
      currentRow += h;
    }
    return positions;
  }, [lines, scrollOffset, chatHeightLimit, chatWidth, chatContentStartRow, focusedResponseIndex, isProcessing, streamDisplay, truncatedIndexes]);

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
              {renderMarkdown(visibleText, "magenta")}
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
            const h = estimateChatLineHeight(lines[i], chatWidth);
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
                return (
                  <ChatLineComponent
                    key={originalIndex}
                    line={line}
                    isFirst={false}
                    tokensUp={tokensUp}
                    tokensDown={tokensDown}
                    modelName={modelName}
                    maxResponseLines={maxAssistantResponseLines}
                    chatWidth={chatWidth}
                  />
                );
              })}

              {shouldRenderStream && (
                <Box flexDirection="column">
                  <Text color="magenta">
                    {visibleLines.length === 0 ? "┌" : "├"}───[ <Text bold color="magenta">✦ COGNITIVE_NODE: SUPERAGENT (STREAMING...)</Text><Text dimColor> (▲{formatCompactNumber(tokensUp)} | ▼{formatCompactNumber(tokensDown + liveStreamTokens)})</Text> ]
                  </Text>
                  {renderMarkdown(
                    streamDisplay,
                    "magenta",
                    true
                  )}
                </Box>
              )}
            </>
          );
        })()}

        {scrollOffset === 0 && isProcessing && (!streamDisplay || streamDisplay.trim().length === 0) && !isExecutingTool && (
          <Box flexDirection="column" marginTop={2}>
            <Text color="magenta">
              {lines.length === 0 ? "┌" : "├"}───[ <Text bold color="magenta">✦ COGNITIVE_NODE: SUPERAGENT (THINKING...)</Text><Text dimColor> (▲{formatCompactNumber(tokensUp)} | ▼{formatCompactNumber(tokensDown)})</Text> ]
            </Text>
            <Box flexDirection="row">
              <Text color="magenta">│    </Text>
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
