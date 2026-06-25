import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useEffect, memo } from "react";
import { Box, Text } from "ink";
import { Banner } from "./banner.js";
import { renderMarkdown, isCollapsibleType } from "./chat-line.js";
import { LoadingIndicator, ToolLoadingIndicator } from "./common/LoadingIndicators.js";
import { getTruncatedAssistantIndexes, wrapTextForDisplay, renderScrollBar, capDisplayLines } from "../utils/responseScroll.js";
import { minimizePathInDescription } from "../utils/text.js";
function visibleLength(str) {
    // eslint-disable-next-line no-control-regex
    return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").length;
}
function renderBoldTargetText(text) {
    const regex = /(5\.\s+Struktur\s+Direktori\s+Tools|Struktur\s+Direktori\s+Tools)/gi;
    if (!regex.test(text)) {
        return text;
    }
    regex.lastIndex = 0;
    const parts = text.split(regex);
    return (_jsx(_Fragment, { children: parts.map((part, index) => {
            if (regex.test(part)) {
                return (_jsx(Text, { bold: true, color: "yellow", children: part }, index));
            }
            return part;
        }) }));
}
export function renderInlineMarkdown(text, defaultColor = "white") {
    const parsedElements = [];
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
        if (fileUrlIdx !== -1)
            rawUrlIdx = fileUrlIdx;
        if (httpUrlIdx !== -1 && (rawUrlIdx === -1 || httpUrlIdx < rawUrlIdx))
            rawUrlIdx = httpUrlIdx;
        if (httpsUrlIdx !== -1 && (rawUrlIdx === -1 || httpsUrlIdx < rawUrlIdx))
            rawUrlIdx = httpsUrlIdx;
        let minIdx = -1;
        let tokenType = "none";
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
            parsedElements.push(_jsx(Text, { color: defaultColor, children: renderBoldTargetText(currentText) }, parsedElements.length));
            break;
        }
        if (minIdx > 0) {
            parsedElements.push(_jsx(Text, { color: defaultColor, children: renderBoldTargetText(currentText.slice(0, minIdx)) }, parsedElements.length));
        }
        currentText = currentText.slice(minIdx);
        if (tokenType === "bold") {
            const nextBoldIdx = currentText.indexOf("**", 2);
            if (nextBoldIdx !== -1) {
                const boldContent = currentText.slice(2, nextBoldIdx);
                parsedElements.push(_jsx(Text, { bold: true, color: "yellow", children: boldContent }, parsedElements.length));
                currentText = currentText.slice(nextBoldIdx + 2);
            }
            else {
                parsedElements.push(_jsx(Text, { color: defaultColor, children: currentText.slice(0, 2) }, parsedElements.length));
                currentText = currentText.slice(2);
            }
        }
        else if (tokenType === "code") {
            const nextCodeIdx = currentText.indexOf("`", 1);
            if (nextCodeIdx !== -1) {
                const codeContent = currentText.slice(1, nextCodeIdx);
                parsedElements.push(_jsx(Text, { color: "cyan", bold: true, children: codeContent }, parsedElements.length));
                currentText = currentText.slice(nextCodeIdx + 1);
            }
            else {
                parsedElements.push(_jsx(Text, { color: defaultColor, children: currentText.slice(0, 1) }, parsedElements.length));
                currentText = currentText.slice(1);
            }
        }
        else if (tokenType === "link") {
            const closeBracketIdx = currentText.indexOf("]");
            const closeParenIdx = currentText.indexOf(")", closeBracketIdx + 2);
            const linkText = currentText.slice(1, closeBracketIdx);
            const linkUrl = currentText.slice(closeBracketIdx + 2, closeParenIdx);
            const osc8Link = `\u001B]8;;${linkUrl}\u0007${linkText}\u001B]8;;\u0007`;
            parsedElements.push(_jsx(Text, { color: "cyan", underline: true, children: osc8Link }, parsedElements.length));
            currentText = currentText.slice(closeParenIdx + 1);
        }
        else if (tokenType === "rawUrl") {
            const match = currentText.match(/^(file:\/\/\/[^\s`'"\(\)\[\]<>]+|https?:\/\/[^\s`'"\(\)\[\]<>]+)/);
            if (match) {
                let url = match[0];
                while (url.length > 0 && /[.,;:!?]$/.test(url)) {
                    url = url.slice(0, -1);
                }
                const osc8Link = `\u001B]8;;${url}\u0007${url}\u001B]8;;\u0007`;
                parsedElements.push(_jsx(Text, { color: "cyan", underline: true, children: osc8Link }, parsedElements.length));
                currentText = currentText.slice(url.length);
            }
            else {
                parsedElements.push(_jsx(Text, { color: defaultColor, children: currentText[0] }, parsedElements.length));
                currentText = currentText.slice(1);
            }
        }
    }
    return _jsx(_Fragment, { children: parsedElements });
}
const streamLineWrapCache = new Map();
export function wrapMarkdownToLines(content, themeColor, chatWidth, lineIndex) {
    const cleanContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "");
    const rawLines = cleanContent.split("\n");
    const result = [];
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
        const lineResult = [];
        const trimmed = l.trim();
        if (trimmed.startsWith("```")) {
            inCodeBlock = !inCodeBlock;
            codeLanguage = trimmed.slice(3).trim();
            const node = (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: themeColor, children: "\u2502    " }), _jsx(Text, { color: "gray", italic: true, children: inCodeBlock ? `┌─── [ CODE: ${codeLanguage || "TEXT"} ]` : "└─── [ END CODE ]" })] }));
            lineResult.push({ node, lineIndex, type: "assistant" });
        }
        else if (inCodeBlock) {
            const subLines = wrapTextForDisplay(l, chatWidth - 8);
            for (const subLine of subLines) {
                const node = (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: themeColor, children: "\u2502    \u2502  " }), _jsx(Text, { color: "green", children: subLine })] }));
                lineResult.push({ node, lineIndex, type: "assistant" });
            }
        }
        else if (l.startsWith("# ")) {
            const subLines = wrapTextForDisplay(l.slice(2), chatWidth - 5);
            for (const subLine of subLines) {
                const node = (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: themeColor, children: "\u2502    " }), _jsx(Text, { bold: true, color: "yellow", children: subLine })] }));
                lineResult.push({ node, lineIndex, type: "assistant" });
            }
        }
        else if (l.startsWith("## ")) {
            const subLines = wrapTextForDisplay(l.slice(3), chatWidth - 5);
            for (const subLine of subLines) {
                const node = (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: themeColor, children: "\u2502    " }), _jsx(Text, { bold: true, color: "cyan", children: subLine })] }));
                lineResult.push({ node, lineIndex, type: "assistant" });
            }
        }
        else if (l.startsWith("### ")) {
            const subLines = wrapTextForDisplay(l.slice(4), chatWidth - 5);
            for (const subLine of subLines) {
                const node = (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: themeColor, children: "\u2502    " }), _jsx(Text, { bold: true, color: "blue", children: subLine })] }));
                lineResult.push({ node, lineIndex, type: "assistant" });
            }
        }
        else {
            let listPrefix = "";
            let isSysLine = false;
            let remainingText = l;
            if (l.trim().startsWith("[SYS]")) {
                isSysLine = true;
                const sysIndex = l.indexOf("[SYS]");
                listPrefix = l.slice(0, sysIndex);
                remainingText = l.slice(sysIndex + 5);
            }
            else if (l.trim().startsWith("- ")) {
                const indent = l.indexOf("- ");
                listPrefix = " ".repeat(indent) + "• ";
                remainingText = l.slice(indent + 2);
            }
            else if (l.trim().startsWith("* ")) {
                const indent = l.indexOf("* ");
                listPrefix = " ".repeat(indent) + "• ";
                remainingText = l.slice(indent + 2);
            }
            else if (/^\d+\.\s/.test(l.trim())) {
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
                const node = (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: themeColor, children: "\u2502    " }), isSysLine ? (isFirstSubLine ? (_jsxs(Text, { children: [listPrefix, _jsx(Text, { bold: true, color: "yellow", children: "[SYS]" })] })) : (_jsx(Text, { children: " ".repeat(listPrefix.length + 5) }))) : listPrefix ? (isFirstSubLine ? (_jsx(Text, { color: "blue", bold: true, children: listPrefix })) : (_jsx(Text, { children: " ".repeat(listPrefix.length) }))) : null, _jsx(Box, { flexShrink: 1, children: _jsx(Text, { children: renderInlineMarkdown(subLine, "white") }) })] }));
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
function wrapNestedChild(rawChild, childIdx, isCollapsed, parentIndex, chatWidth) {
    const indent = "│        ";
    const child = {
        ...rawChild,
        content: rawChild.content.replace(/\r\n/g, "\n").replace(/\r/g, "")
    };
    const result = [];
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
                const statusColor = merged.isError ? "red" : "green";
                const mergedDesc = minimizePathInDescription(merged.description);
                const displayDesc = mergedDesc.length > 55 ? mergedDesc.slice(0, 52) + "..." : mergedDesc;
                if (isAskQuestion) {
                    const outputLine = merged.content.split("\n").find(l => l.startsWith("Output:"));
                    const answerText = outputLine ? outputLine.substring("Output:".length).trim() : "";
                    const node = (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: statusColor, children: [indent, _jsxs(Text, { bold: true, color: statusColor, children: [statusIcon, " \u2753 "] }), _jsx(Text, { color: "yellow", children: questionText }), _jsx(Text, { bold: true, color: statusColor, children: " \u2192 " }), _jsx(Text, { color: statusColor, children: answerText || "N/A" }), " ", _jsx(Text, { dimColor: true, italic: true, children: "(click to expand)" })] }) }));
                    result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isCollapsible: true });
                }
                else {
                    // Parse diff stats from tool result (format: "Changed: +7 -2\nFile: ...")
                    const diffMatch = merged.content.match(/\+(\d+)\s+-(\d+)/);
                    const diffStats = diffMatch
                        ? { added: parseInt(diffMatch[1], 10), removed: parseInt(diffMatch[2], 10) }
                        : null;
                    const node = (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: "yellow", children: [indent, _jsx(Text, { bold: true, color: "yellow", children: "\u21B3 \u2699\uFE0F " }), _jsx(Text, { color: "yellow", children: displayDesc }), diffStats && diffStats.added === 0 && diffStats.removed === 0 ? null : diffStats ? (_jsxs(Text, { children: [_jsxs(Text, { bold: true, color: "green", children: [" +", diffStats.added] }), _jsxs(Text, { bold: true, color: "red", children: [" -", diffStats.removed] })] })) : null, _jsxs(Text, { bold: true, color: statusColor, children: [" ", statusIcon, " ", statusLabel] }), _jsx(Text, { dimColor: true, italic: true, children: "  (click to expand)" })] }) }));
                    result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isCollapsible: true });
                }
            }
            else {
                // ── Collapsed, tool still running ────────────────────────────
                const node = isAskQuestion ? (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: "yellow", children: [indent, _jsx(Text, { bold: true, color: "yellow", children: "\u21B3 \u2753 Question: " }), _jsx(Text, { color: "yellow", children: questionText })] }) })) : (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: "yellow", children: [indent, _jsx(Text, { bold: true, color: "yellow", children: "\u21B3 \u2699\uFE0F " }), _jsx(Text, { color: "yellow", children: cleanDesc }), " ", _jsx(Text, { dimColor: true, italic: true, children: "(click to view inputs)" })] }) }));
                result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isCollapsible: true });
            }
        }
        else {
            // ── Expanded: Input block + divider + Output block ─────────────
            const inputLines = content.split("\n");
            const mergedOutputLines = merged ? merged.content.split("\n") : [];
            const mergedColor = merged?.isError ? "red" : "green";
            const mergedIcon = merged?.isError ? "✗" : "✓";
            // Header row
            const expandedDiffMatch = merged ? merged.content.match(/\+(\d+)\s+-(\d+)/) : null;
            const expandedDiffStats = expandedDiffMatch
                ? { added: parseInt(expandedDiffMatch[1], 10), removed: parseInt(expandedDiffMatch[2], 10) }
                : null;
            const headerNode = (_jsxs(Box, { flexDirection: "row", children: [_jsxs(Text, { color: "yellow", children: [indent, "▼ ⚙️ "] }), _jsx(Text, { color: "yellow", children: cleanDesc }), merged && _jsxs(Text, { bold: true, color: mergedColor, children: [" ", mergedIcon] }), expandedDiffStats && !(expandedDiffStats.added === 0 && expandedDiffStats.removed === 0) && (_jsxs(Text, { children: [_jsxs(Text, { bold: true, color: "green", children: [" +", expandedDiffStats.added] }), _jsxs(Text, { bold: true, color: "red", children: [" -", expandedDiffStats.removed] })] })), _jsx(Text, { dimColor: true, italic: true, children: " (click to collapse)" })] }));
            result.push({ node: headerNode, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isHeader: true, isCollapsible: true });
            // Input lines (skip line 0, already in header)
            for (let idx = 1; idx < inputLines.length; idx++) {
                const l = inputLines[idx];
                const subLines = wrapTextForDisplay(l, chatWidth - 14);
                for (const subLine of subLines) {
                    const node = (_jsxs(Box, { flexDirection: "row", children: [_jsxs(Text, { color: "yellow", children: [indent, "    "] }), _jsx(Text, { bold: true, color: "white", children: subLine })] }));
                    result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isCollapsible: true });
                }
            }
            // Divider + Output (only if merged result exists)
            if (merged) {
                const dividerNode = (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: mergedColor, children: [indent, "    ", "─".repeat(30)] }) }));
                result.push({ node: dividerNode, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isSeparator: true, isCollapsible: true });
                for (const l of mergedOutputLines) {
                    if (l.startsWith("Output:") || l.startsWith("Detail:")) {
                        const labelType = l.startsWith("Output:") ? "Output: " : "Detail: ";
                        const rest = l.substring(labelType.length);
                        const subLines = wrapTextForDisplay(rest, chatWidth - 14 - labelType.length);
                        for (let sIdx = 0; sIdx < subLines.length; sIdx++) {
                            const sub = subLines[sIdx];
                            const isFirstSub = sIdx === 0;
                            const node = (_jsxs(Box, { flexDirection: "row", children: [_jsxs(Text, { color: mergedColor, children: [indent, "    "] }), isFirstSub ? (_jsxs(Text, { children: [_jsx(Text, { bold: true, color: merged.isError ? "cyan" : "gray", dimColor: !merged.isError, children: labelType }), _jsx(Text, { dimColor: true, children: sub })] })) : (_jsxs(Text, { children: [" ".repeat(labelType.length), _jsx(Text, { dimColor: true, children: sub })] }))] }));
                            result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isCollapsible: true });
                        }
                    }
                    else {
                        const subLines = wrapTextForDisplay(l, chatWidth - 14);
                        for (const subLine of subLines) {
                            const node = (_jsxs(Box, { flexDirection: "row", children: [_jsxs(Text, { color: mergedColor, children: [indent, "    "] }), _jsx(Text, { color: merged.isError ? "white" : "gray", dimColor: !merged.isError, children: subLine })] }));
                            result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_start", isCollapsible: true });
                        }
                    }
                }
            }
        }
    }
    else if (child.type === "tool_end") {
        const isError = child.content.startsWith("✗") || child.content.startsWith("🚨");
        const contentText = child.content.substring(2);
        const themeColor = isError ? "red" : "green";
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
                return (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: themeColor, children: [indent, _jsx(Text, { bold: true, color: themeColor, children: isError ? "↳ ✗ " : "↳ ✓ " }), _jsx(Text, { bold: true, color: themeColor, children: "Question: " }), _jsx(Text, { color: themeColor, children: questionText }), _jsx(Text, { bold: true, color: themeColor, children: " | Answer: " }), _jsx(Text, { color: themeColor, children: answerText || "N/A" })] }) }));
            })() : (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: themeColor, children: [indent, _jsx(Text, { bold: true, color: themeColor, children: isError ? "↳ ✗ " : "↳ ✓ " }), _jsx(Text, { color: themeColor, children: cleanDesc }), " ", _jsx(Text, { dimColor: true, italic: true, children: isError ? "(click to view error)" : "(click to view output)" })] }) }));
            result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_end", isCollapsible: true });
        }
        else {
            const contentLines = contentText.split("\n");
            for (let idx = 0; idx < contentLines.length; idx++) {
                const l = contentLines[idx];
                const isFirstLine = idx === 0;
                const cleanLine = l.replace(/^(Completed|Failed|Loaded instructions)\s*-\s*/i, "").trim();
                const subLines = wrapTextForDisplay(isFirstLine ? cleanLine : l, chatWidth - 14);
                for (let sIdx = 0; sIdx < subLines.length; sIdx++) {
                    const subLine = subLines[sIdx];
                    const isFirstSub = isFirstLine && sIdx === 0;
                    const node = (_jsxs(Box, { flexDirection: "row", children: [_jsxs(Text, { color: themeColor, children: [indent, isFirstSub ? (isError ? "▼ ✗ " : "▼ ✓ ") : "    "] }), isFirstSub ? (_jsxs(Text, { color: themeColor, children: [subLine, _jsx(Text, { dimColor: true, italic: true, children: " (click to collapse)" })] })) : subLine.startsWith("Output:") || subLine.startsWith("Detail:") ? (() => {
                                const type = subLine.startsWith("Output:") ? "Output: " : "Detail: ";
                                const rest = subLine.substring(type.length);
                                return (_jsxs(Text, { children: [_jsx(Text, { bold: true, color: isError ? "cyan" : "gray", dimColor: !isError, children: type }), _jsx(Text, { dimColor: true, children: rest })] }));
                            })() : (_jsx(Text, { color: isError ? "white" : "gray", dimColor: !isError, children: subLine }))] }));
                    result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: "tool_end", isCollapsible: true });
                }
            }
        }
    }
    else {
        const contentLines = child.content.split("\n");
        for (const l of contentLines) {
            const subLines = wrapTextForDisplay(l, chatWidth - 14);
            for (const subLine of subLines) {
                const node = (_jsxs(Box, { flexDirection: "row", children: [_jsxs(Text, { color: "gray", children: [indent, "\u2502    "] }), _jsx(Text, { children: subLine })] }));
                result.push({ node, lineIndex: parentIndex, childIndex: childIdx, type: child.type });
            }
        }
    }
    return result;
}
export function wrapChatLineToLines({ line, isFirst, lineIndex, tokensUp, tokensDown, modelName, maxResponseLines, chatWidth, isLastAssistant, isCollapsed, expandedChildren, }) {
    const result = [];
    switch (line.type) {
        case "user": {
            const content = line.content.replace(/^❯ /, "");
            const headerNode = (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: "cyan", children: [isFirst ? "┌" : "├", "\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "cyan", children: "\uD83D\uDC64 ACCESS_POINT: USER" }), " ]", lineIndex !== undefined ? _jsxs(Text, { dimColor: true, children: [" [#", lineIndex, "]"] }) : null] }) }));
            result.push({ node: headerNode, lineIndex, type: "user", isHeader: true });
            const subLines = wrapTextForDisplay(content, chatWidth - 5);
            for (const subLine of subLines) {
                const node = (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "cyan", children: "\u2502    " }), _jsx(Text, { children: renderBoldTargetText(subLine) })] }));
                result.push({ node, lineIndex, type: "user" });
            }
            const separatorNode = (_jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "cyan", children: "\u2502 " }) }));
            result.push({ node: separatorNode, lineIndex, type: "user", isSeparator: true });
            break;
        }
        case "assistant": {
            const capped = isLastAssistant
                ? { text: line.content, truncated: false }
                : capDisplayLines(line.content, maxResponseLines || 12, chatWidth || 80);
            const headerNode = (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: "blue", children: [isFirst ? "┌" : "├", "\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "blue", children: "\u2726 SUPERAGENT" }), " ]", lineIndex !== undefined ? _jsxs(Text, { dimColor: true, children: [" [#", lineIndex, "]"] }) : null] }) }));
            result.push({ node: headerNode, lineIndex, type: "assistant", isHeader: true });
            const contentLines = wrapMarkdownToLines(capped.text, "blue", chatWidth, lineIndex);
            for (const wrappedContentLine of contentLines) {
                result.push({
                    ...wrappedContentLine,
                    isTruncated: capped.truncated,
                });
            }
            if (capped.truncated) {
                const noticeNode = (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "blue", children: "\u2502    " }), _jsx(Text, { color: "yellow", children: "... [long response truncated; click to open scroll view, mouse scroll / \u2191\u2193] ..." })] }));
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
            const separatorNode = (_jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "blue", children: "\u2502 " }) }));
            result.push({ node: separatorNode, lineIndex, type: "assistant", isSeparator: true });
            break;
        }
        case "tool_start": {
            const content = line.content.replace(/^⚡ /, "");
            const extractToolName = (str) => {
                const match = str.match(/Detail:\s*(\w+)/);
                return match ? match[1] : "tool";
            };
            const extractDescription = (str) => {
                const firstLine = str.split("\n")[0].replace(/^[⚡✓✗📖🚨]\s*/, "").trim();
                const minimized = minimizePathInDescription(firstLine);
                return minimized.length > 60 ? minimized.slice(0, 57) + "..." : minimized;
            };
            if (isCollapsed) {
                const toolName = extractToolName(line.content);
                const desc = extractDescription(content);
                const node = (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: "yellow", children: ["\u251C\u2500\u2500\u2500 [ ", _jsxs(Text, { bold: true, color: "yellow", children: ["\u25B6 \u2699\uFE0F ", desc] }), _jsxs(Text, { dimColor: true, children: [" (", toolName, ")"] }), " ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to expand" })] }) }));
                result.push({ node, lineIndex, type: "tool_start", isCollapsible: true });
            }
            else {
                const headerNode = (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: "yellow", children: ["\u251C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "yellow", children: "\u2699\uFE0F SYSTEM_INVOKING_MODULE" }), " ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to collapse" })] }) }));
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
                                const node = (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "yellow", children: "\u2502    " }), isFirstSub ? (_jsxs(Text, { children: [_jsx(Text, { dimColor: true, children: prefix }), _jsx(Text, { bold: true, color: "green", children: toolName }), _jsx(Text, { color: "cyan", children: "(" }), _jsx(Text, { color: "yellow", children: sub }), hasClose && detailSubLines.length === 1 && _jsx(Text, { color: "cyan", children: ")" })] })) : (_jsxs(Text, { children: [" ".repeat(prefix.length + toolName.length + 1), _jsx(Text, { color: "yellow", children: sub }), hasClose && sIdx === detailSubLines.length - 1 && _jsx(Text, { color: "cyan", children: ")" })] }))] }));
                                result.push({ node, lineIndex, type: "tool_start", isCollapsible: true });
                            }
                            continue;
                        }
                    }
                    const subLines = wrapTextForDisplay(l, chatWidth - 5);
                    for (const subLine of subLines) {
                        const node = (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "yellow", children: "\u2502    " }), _jsx(Text, { bold: true, color: "white", children: subLine })] }));
                        result.push({ node, lineIndex, type: "tool_start", isCollapsible: true });
                    }
                }
                const separatorNode = (_jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "yellow", children: "\u2502 " }) }));
                result.push({ node: separatorNode, lineIndex, type: "tool_start", isSeparator: true, isCollapsible: true });
            }
            break;
        }
        case "tool_end": {
            const isError = line.content.startsWith("✗");
            const contentText = line.content.substring(2);
            const themeColor = isError ? "red" : "green";
            const extractDescription = (str) => {
                const firstLine = str.split("\n")[0].replace(/^[⚡✓✗📖🚨]\s*/, "").trim();
                const minimized = minimizePathInDescription(firstLine);
                return minimized.length > 60 ? minimized.slice(0, 57) + "..." : minimized;
            };
            if (isCollapsed) {
                const desc = extractDescription(contentText);
                const icon = isError ? "🔴" : "🟢";
                const status = isError ? "Failed" : "Done";
                const node = (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: themeColor, children: ["\u251C\u2500\u2500\u2500 [ ", _jsxs(Text, { bold: true, color: themeColor, children: ["\u25B6 ", icon, " ", status, ":"] }), " ", _jsx(Text, { dimColor: true, children: desc }), " ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to expand" })] }) }));
                result.push({ node, lineIndex, type: "tool_end", isCollapsible: true });
            }
            else {
                const headerNode = (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: themeColor, children: ["\u251C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: themeColor, children: isError ? "🔴 SYSTEM_CALL_FAILED" : "🟢 SYSTEM_CALL_SUCCESS" }), " ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to collapse" })] }) }));
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
                            const node = (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: themeColor, children: "\u2502    " }), isFirstSub ? (_jsxs(Text, { children: [_jsx(Text, { bold: true, color: isError ? "cyan" : "gray", dimColor: !isError, children: type }), _jsx(Text, { dimColor: true, children: sub })] })) : (_jsxs(Text, { children: [" ".repeat(type.length), _jsx(Text, { dimColor: true, children: sub })] }))] }));
                            result.push({ node, lineIndex, type: "tool_end", isCollapsible: true });
                        }
                        continue;
                    }
                    const subLines = wrapTextForDisplay(l, chatWidth - 5);
                    for (const subLine of subLines) {
                        const node = (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: themeColor, children: "\u2502    " }), _jsx(Text, { color: isError ? "white" : "gray", dimColor: !isError, children: subLine })] }));
                        result.push({ node, lineIndex, type: "tool_end", isCollapsible: true });
                    }
                }
                const separatorNode = (_jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: themeColor, children: "\u2502 " }) }));
                result.push({ node: separatorNode, lineIndex, type: "tool_end", isSeparator: true, isCollapsible: true });
            }
            break;
        }
        case "error": {
            const contentText = line.content.replace(/^Error: /, "");
            if (isCollapsed) {
                const firstLine = contentText.split("\n")[0];
                const preview = firstLine.length > 50 ? firstLine.slice(0, 47) + "..." : firstLine;
                const node = (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: "red", children: ["\u251C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "red", children: "\u25B6 \uD83D\uDEA8 Error:" }), " ", _jsx(Text, { dimColor: true, children: preview }), " ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to expand" })] }) }));
                result.push({ node, lineIndex, type: "error", isCollapsible: true });
            }
            else {
                const headerNode = (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: "red", children: ["\u251C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "red", children: "\uD83D\uDEA8 ERROR_REPORT" }), " ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to collapse" })] }) }));
                result.push({ node: headerNode, lineIndex, type: "error", isHeader: true, isCollapsible: true });
                const contentLines = contentText.split("\n");
                for (const l of contentLines) {
                    const subLines = wrapTextForDisplay(l, chatWidth - 5);
                    for (const subLine of subLines) {
                        const node = (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "red", children: "\u2502    " }), _jsx(Text, { color: "red", children: subLine })] }));
                        result.push({ node, lineIndex, type: "error", isCollapsible: true });
                    }
                }
                const separatorNode = (_jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "red", children: "\u2502 " }) }));
                result.push({ node: separatorNode, lineIndex, type: "error", isSeparator: true, isCollapsible: true });
            }
            break;
        }
        case "system": {
            if (isCollapsed) {
                const firstLine = line.content.split("\n")[0];
                const preview = firstLine.length > 50 ? firstLine.slice(0, 47) + "..." : firstLine;
                const node = (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: "gray", children: ["\u251C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "gray", children: "\u25B6 \u2139\uFE0F System:" }), " ", _jsx(Text, { dimColor: true, children: preview }), " ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to expand" })] }) }));
                result.push({ node, lineIndex, type: "system", isCollapsible: true });
            }
            else {
                const headerNode = (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: "gray", children: ["\u251C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "gray", children: "\u2139\uFE0F SYSTEM_INFO" }), " ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to collapse" })] }) }));
                result.push({ node: headerNode, lineIndex, type: "system", isHeader: true, isCollapsible: true });
                const contentLines = line.content.split("\n");
                for (const l of contentLines) {
                    const subLines = wrapTextForDisplay(l, chatWidth - 5);
                    for (const subLine of subLines) {
                        const node = (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "gray", children: "\u2502    " }), _jsx(Text, { color: "gray", italic: true, children: subLine })] }));
                        result.push({ node, lineIndex, type: "system", isCollapsible: true });
                    }
                }
                const separatorNode = (_jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "gray", children: "\u2502 " }) }));
                result.push({ node: separatorNode, lineIndex, type: "system", isSeparator: true, isCollapsible: true });
            }
            break;
        }
        default: {
            const headerNode = (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: "gray", children: ["\u251C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "gray", children: "COMM_PACKET" }), " ]"] }) }));
            result.push({ node: headerNode, lineIndex, type: "default" });
            const contentLines = line.content.split("\n");
            for (const l of contentLines) {
                const subLines = wrapTextForDisplay(l, chatWidth - 5);
                for (const subLine of subLines) {
                    const node = (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "gray", children: "\u2502    " }), _jsx(Text, { children: subLine })] }));
                    result.push({ node, lineIndex, type: "default" });
                }
            }
            const separatorNode = (_jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "gray", children: "\u2502 " }) }));
            result.push({ node: separatorNode, lineIndex, type: "default", isSeparator: true });
            break;
        }
    }
    return result;
}
const lineWrapCache = new Map();
function getLineCacheKey(line, idx, chatWidth, isCollapsed, childSet, isLastAssistant) {
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
export function computeWrappedLines({ lines, chatWidth, maxAssistantResponseLines, expandedLines, expandedChildren, tokensUp, tokensDown, modelName, isProcessing, streamDisplay, isExecutingTool, activeToolOutput, timeLeft, formatCompactNumber, }) {
    const result = [];
    if (lines.length === 0) {
        lineWrapCache.clear();
    }
    if (lineWrapCache.size > 2000) {
        lineWrapCache.clear();
    }
    const lastAssistantIdx = (() => {
        const shouldRenderStreamNow = isProcessing && streamDisplay && streamDisplay.trim().length > 0;
        if (shouldRenderStreamNow)
            return -1;
        for (let j = lines.length - 1; j >= 0; j--) {
            if (lines[j].type === "assistant")
                return j;
        }
        return -1;
    })();
    // 1. Process all completed lines
    for (let idx = 0; idx < lines.length; idx++) {
        const isFirst = idx === 0;
        const isCollapsed = (lines[idx].type === "error" || lines[idx].type === "system")
            ? expandedLines.has(idx)
            : (isCollapsibleType(lines[idx].type) && !expandedLines.has(idx));
        const childSet = expandedChildren.get(idx) || new Set();
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
        const headerNode = (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: "blue", children: [borderPrefix, "\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "blue", children: "\u2726 SUPERAGENT (STREAMING...)" }), " ]"] }) }));
        result.push({ node: headerNode, lineIndex: -1, type: "assistant", isHeader: true });
        const contentLines = wrapMarkdownToLines(streamDisplay, "blue", chatWidth, -1);
        result.push(...contentLines);
    }
    const shouldRenderThinking = isProcessing && (!streamDisplay || streamDisplay.trim().length === 0) && !isExecutingTool;
    if (shouldRenderThinking) {
        const headerNode = (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: "blue", children: [borderPrefix, "\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "blue", children: "\u2726 SUPERAGENT (THINKING...)" }), " ]"] }) }));
        result.push({ node: headerNode, lineIndex: -1, type: "assistant", isHeader: true });
        const bodyNode = (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "blue", children: "\u2502    " }), _jsx(LoadingIndicator, {})] }));
        result.push({ node: bodyNode, lineIndex: -1, type: "assistant" });
    }
    if (isExecutingTool) {
        const headerNode = (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: "yellow", children: [borderPrefix, "\u2500\u2500\u2500 [ ", _jsxs(Text, { bold: true, color: "yellow", children: ["\u2699\uFE0F SYSTEM_CALL: EXECUTING...", timeLeft !== null ? ` (${timeLeft}s left)` : ""] }), " ]"] }) }));
        result.push({ node: headerNode, lineIndex: -1, type: "tool_start", isHeader: true });
        const spinnerNode = (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "yellow", children: "\u2502    " }), _jsx(ToolLoadingIndicator, {})] }));
        result.push({ node: spinnerNode, lineIndex: -1, type: "tool_start" });
        const activeToolLines = activeToolOutput ? activeToolOutput.trim().split("\n").slice(-8) : [];
        if (activeToolLines.length > 0) {
            const liveOutputHeader = (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: "yellow", children: ["\u251C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "yellow", children: "\u2699\uFE0F SYSTEM_CALL_OUTPUT (LIVE)" }), " ]"] }) }));
            result.push({ node: liveOutputHeader, lineIndex: -1, type: "tool_start" });
            for (const line of activeToolLines) {
                const subLines = wrapTextForDisplay(line, chatWidth - 5);
                for (const subLine of subLines) {
                    const node = (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "yellow", children: "\u2502    " }), _jsx(Text, { color: "gray", children: subLine })] }));
                    result.push({ node, lineIndex: -1, type: "tool_start" });
                }
            }
        }
    }
    return result;
}
export const ChatArea = memo(function ChatArea(props) {
    const { showBanner, focusMode, scrollOffset, focusedResponseIndex, setFocusedResponseIndex, focusedResponseOffset, setFocusedResponseOffset, lines, chatHeightLimit, terminalHeight, terminalWidth, isProcessing, streamDisplay, tokensUp, tokensDown, liveStreamTokens, modelName, maxAssistantResponseLines, isExecutingTool, timeLeft, activeToolOutput, formatCompactNumber, onVisibleLinesChange, chatContentStartRow = 2, expandedLines = new Set(), toggleLineExpand, expandedChildren = new Map(), toggleChildExpand, wrappedLines: passedWrappedLines, } = props;
    const chatWidth = Math.max(20, terminalWidth - 6);
    const localWrappedLines = useMemo(() => {
        if (passedWrappedLines)
            return passedWrappedLines;
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
        if (focusedResponseIndex !== null)
            return [];
        const endIdx = localWrappedLines.length - scrollOffset;
        const startIdx = Math.max(0, endIdx - chatHeightLimit);
        const visibleWrappedLines = localWrappedLines.slice(startIdx, endIdx);
        const positions = [];
        let currentBlockIndex = -1;
        let currentChildIndex = -1;
        let activePos = null;
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
            const isNewGroup = line.lineIndex !== currentBlockIndex ||
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
            }
            else {
                if (activePos) {
                    activePos.endRow = y;
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
    return (_jsxs(_Fragment, { children: [showBanner && _jsx(Banner, {}), _jsxs(Box, { flexDirection: "row", justifyContent: "space-between", paddingX: 1, marginBottom: 0, children: [_jsxs(Text, { color: focusMode === "chat" ? "green" : "cyan", children: ["\u250C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: focusMode === "chat" ? "green" : "cyan", children: "\uD83D\uDCAC CONVERSATION LOG" }), focusMode === "chat" && _jsx(Text, { dimColor: true, children: " [\u2191/\u25BC Scroll \u2022 Esc Exit]" }), " ]"] }), scrollOffset > 0 && (_jsxs(Text, { color: "yellow", bold: true, children: ["[Scroll: -", scrollOffset, " lines - Esc to snap bottom]"] }))] }), _jsx(Box, { flexDirection: "column", paddingX: 1, flexGrow: 1, children: focusedResponseIndex !== null ? (() => {
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
                    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "yellow", children: ["\u250C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "yellow", children: "RESPONSE_SCROLL" }), _jsxs(Text, { dimColor: true, children: [" ", currentPosition + 1, "/", Math.max(1, truncatedIndexes.length), " line ", safeOffset + 1, "-", visibleEnd, " / ", responseLines.length, " ", renderScrollBar(safeOffset, focusWindowHeight, responseLines.length), " | \u2191/\u2193 scroll | Esc close | click to close"] }), " ]"] }), renderMarkdown(visibleText, "blue"), _jsxs(Text, { color: "yellow", children: ["\u2514\u2500\u2500\u2500 [ focused assistant response #", focusedResponseIndex + 1, " ]"] })] }));
                })() : (_jsx(_Fragment, { children: visibleWrappedLines.map((line, idx) => (_jsx(Box, { flexDirection: "column", children: line.node }, idx))) })) })] }));
});
//# sourceMappingURL=chat-area.js.map