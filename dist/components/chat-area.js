import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useMemo, useEffect, memo } from "react";
import { Box, Text } from "ink";
import { Banner } from "./banner.js";
import { ChatLineComponent, renderMarkdown } from "./chat-line.js";
import { LoadingIndicator, ToolLoadingIndicator } from "./common/LoadingIndicators.js";
import { getTruncatedAssistantIndexes, wrapTextForDisplay, renderScrollBar } from "../utils/responseScroll.js";
export const ChatArea = memo(function ChatArea(props) {
    const { showBanner, focusMode, scrollOffset, focusedResponseIndex, setFocusedResponseIndex, focusedResponseOffset, setFocusedResponseOffset, lines, chatHeightLimit, terminalHeight, terminalWidth, isProcessing, streamDisplay, tokensUp, tokensDown, liveStreamTokens, modelName, maxAssistantResponseLines, isExecutingTool, timeLeft, activeToolOutput, formatCompactNumber, onVisibleLinesChange, chatContentStartRow = 2, } = props;
    const chatWidth = Math.max(20, terminalWidth - 6);
    const estimateMarkdownLines = (text, width) => {
        let count = 0;
        const rawLines = text.split("\n");
        for (const l of rawLines) {
            count += Math.max(1, Math.ceil(l.length / width));
        }
        return count;
    };
    const estimateChatLineHeight = (line, width, isLastAssistant = false) => {
        let linesCount = 2; // Border header + spacing lines
        const textLines = line.content.split("\n");
        // Only cap assistant responses that are NOT the last one (last response shows full)
        const maxContentLines = (line.type === "assistant" && !isLastAssistant) ? maxAssistantResponseLines + 1 : Number.POSITIVE_INFINITY;
        for (const l of textLines) {
            let rawText = l;
            if (line.type === "user") {
                rawText = l.replace(/^❯ /, "");
            }
            else if (line.type === "tool_start") {
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
    // Find the last assistant message index in the full lines array.
    // When streaming, the live response is shown separately (always untruncated),
    // so all completed messages in `lines` count as "previous" and may be truncated.
    // When NOT streaming, the last assistant message is the "final" response
    // and should be shown in full without hide/truncate.
    const shouldRenderStreamNow = scrollOffset === 0 && isProcessing && streamDisplay && streamDisplay.trim().length > 0;
    const lastAssistantIdx = useMemo(() => {
        if (shouldRenderStreamNow)
            return -1;
        for (let j = lines.length - 1; j >= 0; j--) {
            if (lines[j].type === "assistant")
                return j;
        }
        return -1;
    }, [lines, shouldRenderStreamNow]);
    // Calculate visible line positions for mouse click detection
    const truncatedIndexes = useMemo(() => getTruncatedAssistantIndexes(lines, maxAssistantResponseLines, chatWidth), [lines, maxAssistantResponseLines, chatWidth]);
    const visibleLinePositions = useMemo(() => {
        if (focusedResponseIndex !== null)
            return [];
        const shouldRenderStream = scrollOffset === 0 && isProcessing && streamDisplay && streamDisplay.trim().length > 0;
        let startIndex = lines.length;
        let accumulatedHeight = 0;
        const endIndex = scrollOffset === 0 ? lines.length : Math.max(0, lines.length - scrollOffset);
        let effectiveLimit = chatHeightLimit;
        if (shouldRenderStream) {
            effectiveLimit = Math.max(0, chatHeightLimit - estimateMarkdownLines(streamDisplay, chatWidth));
        }
        for (let i = endIndex - 1; i >= 0; i--) {
            const h = estimateChatLineHeight(lines[i], chatWidth, i === lastAssistantIdx);
            if (accumulatedHeight + h > effectiveLimit) {
                if (i === endIndex - 1 && effectiveLimit > 0)
                    startIndex = i;
                break;
            }
            accumulatedHeight += h;
            startIndex = i;
        }
        let currentRow = chatContentStartRow;
        const positions = [];
        for (let i = startIndex; i < endIndex; i++) {
            const line = lines[i];
            const h = estimateChatLineHeight(line, chatWidth, i === lastAssistantIdx);
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
    }, [lines, scrollOffset, chatHeightLimit, chatWidth, chatContentStartRow, focusedResponseIndex, isProcessing, streamDisplay, truncatedIndexes, lastAssistantIdx]);
    useEffect(() => {
        if (onVisibleLinesChange) {
            onVisibleLinesChange(visibleLinePositions);
        }
    }, [visibleLinePositions, onVisibleLinesChange]);
    return (_jsxs(_Fragment, { children: [showBanner && _jsx(Banner, {}), _jsxs(Box, { flexDirection: "row", justifyContent: "space-between", paddingX: 1, marginBottom: 0, children: [_jsxs(Text, { color: focusMode === "chat" ? "green" : "cyan", children: ["\u250C\u2500\u2500\u2500[ ", _jsx(Text, { bold: true, color: focusMode === "chat" ? "green" : "cyan", children: "\uD83D\uDCAC CONVERSATION LOG" }), focusMode === "chat" && _jsx(Text, { dimColor: true, children: " [\u2191/\u25BC Scroll \u2022 Esc Exit]" }), " ]"] }), scrollOffset > 0 && (_jsxs(Text, { color: "yellow", bold: true, children: ["[Scroll: -", scrollOffset, " lines/msgs - Esc to snap bottom]"] }))] }), _jsxs(Box, { flexDirection: "column", paddingX: 1, flexGrow: 1, children: [focusedResponseIndex !== null ? (() => {
                        const width = Math.max(20, chatWidth - 6);
                        const maxLines = Math.max(8, Math.min(18, Math.floor(terminalHeight * 0.45)));
                        const truncatedIndexes = getTruncatedAssistantIndexes(lines, maxLines, chatWidth);
                        const currentPosition = Math.max(0, truncatedIndexes.indexOf(focusedResponseIndex));
                        const focusedLine = lines[focusedResponseIndex];
                        if (!focusedLine || focusedLine.type !== "assistant")
                            return null;
                        const focusWindowHeight = Math.max(5, chatHeightLimit - 3);
                        const responseLines = wrapTextForDisplay(focusedLine.content, width);
                        const maxOffset = Math.max(0, responseLines.length - focusWindowHeight);
                        const safeOffset = Math.min(focusedResponseOffset, maxOffset);
                        const visibleText = responseLines.slice(safeOffset, safeOffset + focusWindowHeight).join("\n");
                        const visibleEnd = Math.min(responseLines.length, safeOffset + focusWindowHeight);
                        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "yellow", children: ["\u250C\u2500\u2500\u2500[ ", _jsx(Text, { bold: true, color: "yellow", children: "RESPONSE_SCROLL" }), _jsxs(Text, { dimColor: true, children: [" ", currentPosition + 1, "/", Math.max(1, truncatedIndexes.length), " line ", safeOffset + 1, "-", visibleEnd, " / ", responseLines.length, " ", renderScrollBar(safeOffset, focusWindowHeight, responseLines.length), " | \u2191/\u2193 scroll | Esc close | click to close"] }), " ]"] }), renderMarkdown(visibleText, "magenta"), _jsxs(Text, { color: "yellow", children: ["\u2514\u2500\u2500\u2500[ focused assistant response #", focusedResponseIndex + 1, " ]"] })] }));
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
                            const h = estimateChatLineHeight(lines[i], chatWidth, i === lastAssistantIdx);
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
                        return (_jsxs(_Fragment, { children: [visibleLines.map((line, i) => {
                                    const originalIndex = startIndex + i;
                                    return (_jsx(ChatLineComponent, { line: line, isFirst: false, tokensUp: tokensUp, tokensDown: tokensDown, modelName: modelName, maxResponseLines: maxAssistantResponseLines, chatWidth: chatWidth, isLastAssistant: originalIndex === lastAssistantIdx }, originalIndex));
                                }), shouldRenderStream && (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "magenta", children: [visibleLines.length === 0 ? "┌" : "├", "\u2500\u2500\u2500[ ", _jsx(Text, { bold: true, color: "magenta", children: "\u2726 COGNITIVE_NODE: SUPERAGENT (STREAMING...)" }), _jsxs(Text, { dimColor: true, children: [" (\u25B2", formatCompactNumber(tokensUp), " | \u25BC", formatCompactNumber(tokensDown + liveStreamTokens), ")"] }), " ]"] }), renderMarkdown(streamDisplay, "magenta", true)] }))] }));
                    })(), scrollOffset === 0 && isProcessing && (!streamDisplay || streamDisplay.trim().length === 0) && !isExecutingTool && (_jsxs(Box, { flexDirection: "column", marginTop: 2, children: [_jsxs(Text, { color: "magenta", children: [lines.length === 0 ? "┌" : "├", "\u2500\u2500\u2500[ ", _jsx(Text, { bold: true, color: "magenta", children: "\u2726 COGNITIVE_NODE: SUPERAGENT (THINKING...)" }), _jsxs(Text, { dimColor: true, children: [" (\u25B2", formatCompactNumber(tokensUp), " | \u25BC", formatCompactNumber(tokensDown), ")"] }), " ]"] }), _jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "magenta", children: "\u2502    " }), _jsx(LoadingIndicator, {})] })] })), scrollOffset === 0 && isExecutingTool && (_jsxs(Box, { flexDirection: "column", marginTop: 2, children: [_jsxs(Text, { color: "yellow", children: [lines.length === 0 ? "┌" : "├", "\u2500\u2500\u2500[ ", _jsxs(Text, { bold: true, color: "yellow", children: ["\u2699\uFE0F SYSTEM_CALL: EXECUTING...", timeLeft !== null ? ` (${timeLeft}s left)` : ""] }), " ]"] }), _jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "yellow", children: "\u2502    " }), _jsx(ToolLoadingIndicator, {})] }), activeToolLinesCount > 0 && (_jsxs(_Fragment, { children: [_jsxs(Text, { color: "yellow", children: ["\u251C\u2500\u2500\u2500[ ", _jsx(Text, { bold: true, color: "yellow", children: "\u2699\uFE0F SYSTEM_CALL_OUTPUT (LIVE)" }), " ]"] }), activeToolLines.map((line, idx) => (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "yellow", children: "\u2502    " }), _jsx(Text, { color: "gray", children: line })] }, idx)))] }))] }))] })] }));
});
//# sourceMappingURL=chat-area.js.map