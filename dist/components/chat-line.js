import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import React from "react";
import { Box, Text } from "ink";
import { minimizePathInDescription } from "../utils/text.js";
import { capDisplayLines } from "../utils/responseScroll.js";
/** Returns true if the given chat line type supports collapse/expand */
export function isCollapsibleType(type) {
    return type === "tool_start" || type === "tool_end" || type === "system" || type === "error";
}
export function truncateStreamDisplay(text, maxLines, width) {
    const rawLines = text.split("\n");
    let accumulated = 0;
    const resultLines = [];
    for (let i = rawLines.length - 1; i >= 0; i--) {
        const wrappedCount = Math.max(1, Math.ceil(rawLines[i].length / width));
        if (accumulated + wrappedCount > maxLines) {
            if (resultLines.length === 0) {
                resultLines.unshift(rawLines[i]);
            }
            else {
                resultLines.unshift("... [older output hidden to fit screen] ...");
            }
            break;
        }
        accumulated += wrappedCount;
        resultLines.unshift(rawLines[i]);
    }
    return resultLines.join("\n");
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
export function renderMarkdown(content, themeColor = "blue", showCursor = false) {
    const cleanContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "");
    const rawLines = cleanContent.split("\n");
    // Format markdown tables helper
    function formatMarkdownTable(tableLines) {
        const rows = tableLines.map(line => {
            const parts = line.split("|");
            if (parts.length >= 2) {
                return parts.slice(1, parts.length - 1).map(cell => cell.trim());
            }
            return [];
        });
        const isSeparatorRow = (row) => {
            return row.length > 0 && row.every(cell => cell.length > 0 && /^[:-]+$/.test(cell));
        };
        const numCols = Math.max(...rows.map(r => r.length));
        const colWidths = Array(numCols).fill(0);
        rows.forEach((row) => {
            if (isSeparatorRow(row))
                return;
            for (let i = 0; i < numCols; i++) {
                const cellText = row[i] || "";
                const cleanText = cellText.replace(/\*\*|`/g, "");
                if (cleanText.length > colWidths[i]) {
                    colWidths[i] = cleanText.length;
                }
            }
        });
        return rows.map((row) => {
            if (isSeparatorRow(row)) {
                const separatorCells = colWidths.map(width => "-".repeat(width + 2));
                return "| " + separatorCells.join(" | ") + " |";
            }
            const formattedCells = colWidths.map((width, colIdx) => {
                const cellText = row[colIdx] || "";
                const cleanText = cellText.replace(/\*\*|`/g, "");
                const paddingLength = Math.max(0, width - cleanText.length);
                return cellText + " ".repeat(paddingLength);
            });
            return "| " + formattedCells.join(" | ") + " |";
        });
    }
    const processedLines = [];
    let inCodeBlock = false;
    let codeLanguage = "";
    let i = 0;
    while (i < rawLines.length) {
        const line = rawLines[i];
        const trimmed = line.trim();
        if (trimmed.startsWith("```")) {
            inCodeBlock = !inCodeBlock;
            codeLanguage = trimmed.slice(3).trim();
            processedLines.push({ text: line, inCodeBlock: true, codeLanguage });
            i++;
            continue;
        }
        if (inCodeBlock) {
            processedLines.push({ text: line, inCodeBlock: true });
            i++;
            continue;
        }
        if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
            const tableLines = [];
            while (i < rawLines.length && rawLines[i].trim().startsWith("|") && rawLines[i].trim().endsWith("|")) {
                tableLines.push(rawLines[i]);
                i++;
            }
            const formatted = formatMarkdownTable(tableLines);
            formatted.forEach(fLine => {
                processedLines.push({ text: fLine, inCodeBlock: false });
            });
            continue;
        }
        processedLines.push({ text: line, inCodeBlock: false });
        i++;
    }
    let inCode = false;
    return (_jsx(_Fragment, { children: processedLines.map((item, idx) => {
            const l = item.text;
            const trimmed = l.trim();
            if (trimmed.startsWith("```")) {
                inCode = !inCode;
                return (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: themeColor, children: "\u2502    " }), _jsx(Text, { color: "gray", italic: true, children: inCode ? `┌─── [ CODE: ${item.codeLanguage || "TEXT"} ]` : "└─── [ END CODE ]" }), showCursor && idx === processedLines.length - 1 && _jsx(Text, { color: "gray", children: "\u2588" })] }, idx));
            }
            if (inCode) {
                return (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: themeColor, children: "\u2502    \u2502  " }), _jsx(Text, { color: "green", children: l }), showCursor && idx === processedLines.length - 1 && _jsx(Text, { color: "green", children: "\u2588" })] }, idx));
            }
            if (l.startsWith("# ")) {
                return (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: themeColor, children: "\u2502    " }), _jsx(Text, { bold: true, color: "yellow", children: l.slice(2) }), showCursor && idx === processedLines.length - 1 && _jsx(Text, { bold: true, color: "yellow", children: "\u2588" })] }, idx));
            }
            if (l.startsWith("## ")) {
                return (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: themeColor, children: "\u2502    " }), _jsx(Text, { bold: true, color: "cyan", children: l.slice(3) }), showCursor && idx === processedLines.length - 1 && _jsx(Text, { bold: true, color: "cyan", children: "\u2588" })] }, idx));
            }
            if (l.startsWith("### ")) {
                return (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: themeColor, children: "\u2502    " }), _jsx(Text, { bold: true, color: "blue", children: l.slice(4) }), showCursor && idx === processedLines.length - 1 && _jsx(Text, { bold: true, color: "blue", children: "\u2588" })] }, idx));
            }
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
            const parsedElements = [];
            let currentText = remainingText;
            while (currentText.length > 0) {
                const boldIdx = currentText.indexOf("**");
                const codeIdx = currentText.indexOf("`");
                const linkIdx = currentText.indexOf("[");
                // Check for raw URLs (file:///, http://, https://)
                const fileUrlIdx = currentText.indexOf("file://");
                const httpUrlIdx = currentText.indexOf("http://");
                const httpsUrlIdx = currentText.indexOf("https://");
                let rawUrlIdx = -1;
                if (fileUrlIdx !== -1) {
                    rawUrlIdx = fileUrlIdx;
                }
                if (httpUrlIdx !== -1 && (rawUrlIdx === -1 || httpUrlIdx < rawUrlIdx)) {
                    rawUrlIdx = httpUrlIdx;
                }
                if (httpsUrlIdx !== -1 && (rawUrlIdx === -1 || httpsUrlIdx < rawUrlIdx)) {
                    rawUrlIdx = httpsUrlIdx;
                }
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
                    parsedElements.push(_jsx(Text, { children: renderBoldTargetText(currentText) }, parsedElements.length));
                    break;
                }
                if (minIdx > 0) {
                    parsedElements.push(_jsx(Text, { children: renderBoldTargetText(currentText.slice(0, minIdx)) }, parsedElements.length));
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
                        parsedElements.push(_jsx(Text, { children: currentText.slice(0, 2) }, parsedElements.length));
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
                        parsedElements.push(_jsx(Text, { children: currentText.slice(0, 1) }, parsedElements.length));
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
                        // Strip trailing punctuation if it was just sentence punctuation
                        while (url.length > 0 && /[.,;:!?]$/.test(url)) {
                            url = url.slice(0, -1);
                        }
                        const osc8Link = `\u001B]8;;${url}\u0007${url}\u001B]8;;\u0007`;
                        parsedElements.push(_jsx(Text, { color: "cyan", underline: true, children: osc8Link }, parsedElements.length));
                        currentText = currentText.slice(url.length);
                    }
                    else {
                        parsedElements.push(_jsx(Text, { children: currentText[0] }, parsedElements.length));
                        currentText = currentText.slice(1);
                    }
                }
            }
            return (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: themeColor, children: "\u2502    " }), isSysLine ? (_jsxs(Text, { children: [listPrefix, _jsx(Text, { bold: true, color: "yellow", children: "[SYS]" })] })) : listPrefix ? (_jsx(Text, { color: "blue", bold: true, children: listPrefix })) : null, _jsx(Box, { flexShrink: 1, children: _jsxs(Text, { children: [parsedElements, showCursor && idx === processedLines.length - 1 && "█"] }) })] }, idx));
        }) }));
}
export function renderToolStart(content) {
    const cleanContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "");
    const lines = cleanContent.split("\n");
    return (_jsx(_Fragment, { children: lines.map((l, idx) => {
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
                    return (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "yellow", children: "\u2502    " }), _jsx(Text, { dimColor: true, children: prefix }), _jsx(Text, { bold: true, color: "green", children: toolName }), _jsx(Text, { color: "cyan", children: "(" }), _jsx(Text, { color: "yellow", children: remaining }), hasClose && _jsx(Text, { color: "cyan", children: ")" })] }, idx));
                }
            }
            return (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "yellow", children: "\u2502    " }), _jsx(Text, { bold: true, color: "white", children: l })] }, idx));
        }) }));
}
export function renderToolEnd(content, isError) {
    const cleanContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "");
    const lines = cleanContent.split("\n");
    const themeColor = isError ? "red" : "green";
    return (_jsx(_Fragment, { children: lines.map((l, idx) => {
            if (l.startsWith("Output:") || l.startsWith("Detail:")) {
                const type = l.startsWith("Output:") ? "Output: " : "Detail: ";
                const rest = l.substring(type.length);
                return (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: themeColor, children: "\u2502    " }), _jsx(Text, { bold: true, color: isError ? "cyan" : "gray", dimColor: !isError, children: type }), _jsx(Text, { dimColor: true, children: rest })] }, idx));
            }
            return (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: themeColor, children: "\u2502    " }), _jsx(Text, { color: isError ? "white" : "gray", dimColor: !isError, children: l })] }, idx));
        }) }));
}
/** Render a nested child line with extra indentation under a parent */
function renderNestedChild(rawChild, childIdx, isCollapsed, parentColor) {
    const indent = "│        "; // Parent's content indent + 4 spaces
    const child = {
        ...rawChild,
        content: rawChild.content.replace(/\r\n/g, "\n").replace(/\r/g, "")
    };
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
                    // For ask_question, show question + answer inline
                    const outputLine = merged.content.split("\n").find(l => l.startsWith("Output:"));
                    const answerText = outputLine ? outputLine.substring("Output:".length).trim() : "";
                    return (_jsx(Box, { flexDirection: "column", children: _jsxs(Text, { color: statusColor, children: [indent, _jsxs(Text, { bold: true, color: statusColor, children: [statusIcon, " \u2753 "] }), _jsx(Text, { color: "yellow", children: questionText }), _jsx(Text, { bold: true, color: statusColor, children: " \u2192 " }), _jsx(Text, { color: statusColor, children: answerText || "N/A" }), " ", _jsx(Text, { dimColor: true, italic: true, children: "(click to expand)" })] }) }, `child-${childIdx}`));
                }
                const diffMatch = merged.content.match(/\+(\d+)\s+-(\d+)/);
                const diffStats = diffMatch
                    ? { added: parseInt(diffMatch[1], 10), removed: parseInt(diffMatch[2], 10) }
                    : null;
                return (_jsx(Box, { flexDirection: "column", children: _jsxs(Text, { color: "yellow", children: [indent, _jsx(Text, { bold: true, color: "yellow", children: "\u21B3 \u2699\uFE0F " }), _jsx(Text, { color: "yellow", children: displayDesc }), diffStats && diffStats.added === 0 && diffStats.removed === 0 ? null : diffStats ? (_jsxs(Text, { children: [_jsxs(Text, { bold: true, color: "green", children: [" +", diffStats.added] }), _jsxs(Text, { bold: true, color: "red", children: [" -", diffStats.removed] })] })) : null, _jsxs(Text, { bold: true, color: statusColor, children: [" ", statusIcon, " ", statusLabel] }), _jsx(Text, { dimColor: true, italic: true, children: "  (click to expand)" })] }) }, `child-${childIdx}`));
            }
            // ── Collapsed, tool still running ────────────────────────────
            return (_jsx(Box, { flexDirection: "column", children: isAskQuestion ? (_jsxs(Text, { color: "yellow", children: [indent, _jsx(Text, { bold: true, color: "yellow", children: "\u21B3 \u2753 Question: " }), _jsx(Text, { color: "yellow", children: questionText })] })) : (_jsxs(Text, { color: "yellow", children: [indent, _jsx(Text, { bold: true, color: "yellow", children: "\u21B3 \u2699\uFE0F " }), _jsx(Text, { color: "yellow", children: cleanDesc }), " ", _jsx(Text, { dimColor: true, italic: true, children: "(click to view inputs)" })] })) }, `child-${childIdx}`));
        }
        // ── Expanded view: Input block + divider + Output block ──────────
        const inputLines = content.split("\n");
        const mergedOutputLines = merged ? merged.content.split("\n") : [];
        const mergedColor = merged?.isError ? "red" : "green";
        const mergedIcon = merged?.isError ? "✗" : "✓";
        const expandedDiffMatch = merged ? merged.content.match(/\+(\d+)\s+-(\d+)/) : null;
        const expandedDiffStats = expandedDiffMatch
            ? { added: parseInt(expandedDiffMatch[1], 10), removed: parseInt(expandedDiffMatch[2], 10) }
            : null;
        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { flexDirection: "row", children: [_jsxs(Text, { color: "yellow", children: [indent, "▼ ⚙️ "] }), _jsx(Text, { color: "yellow", children: cleanDesc }), merged && (_jsxs(Text, { bold: true, color: mergedColor, children: [" ", mergedIcon] })), expandedDiffStats && !(expandedDiffStats.added === 0 && expandedDiffStats.removed === 0) && (_jsxs(Text, { children: [_jsxs(Text, { bold: true, color: "green", children: [" +", expandedDiffStats.added] }), _jsxs(Text, { bold: true, color: "red", children: [" -", expandedDiffStats.removed] })] })), _jsx(Text, { dimColor: true, italic: true, children: " (click to collapse)" })] }), inputLines.map((l, idx) => {
                    if (idx === 0)
                        return null; // skip first line (already shown in header)
                    return (_jsxs(Box, { flexDirection: "row", children: [_jsxs(Text, { color: "yellow", children: [indent, "    "] }), _jsx(Text, { bold: true, color: "white", children: l })] }, `in-${idx}`));
                }), merged && (_jsxs(_Fragment, { children: [_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: mergedColor, children: [indent, "    ", "─".repeat(30)] }) }), mergedOutputLines.map((l, idx) => {
                            if (l.startsWith("Output:") || l.startsWith("Detail:")) {
                                const labelType = l.startsWith("Output:") ? "Output: " : "Detail: ";
                                const rest = l.substring(labelType.length);
                                return (_jsxs(Box, { flexDirection: "row", children: [_jsxs(Text, { color: mergedColor, children: [indent, "    "] }), _jsx(Text, { bold: true, color: merged.isError ? "cyan" : "gray", dimColor: !merged.isError, children: labelType }), _jsx(Text, { dimColor: true, children: rest })] }, `out-${idx}`));
                            }
                            return (_jsxs(Box, { flexDirection: "row", children: [_jsxs(Text, { color: mergedColor, children: [indent, "    "] }), _jsx(Text, { color: merged.isError ? "white" : "gray", dimColor: !merged.isError, children: l })] }, `out-${idx}`));
                        })] }))] }, `child-${childIdx}`));
    }
    // tool_end children are no longer produced by new code, but kept for backward compatibility
    // with any persisted chat history that may still have them
    if (child.type === "tool_end") {
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
            return (_jsx(Box, { flexDirection: "column", children: isAskQuestion ? (() => {
                    const lines = contentText.split("\n");
                    const outputLine = lines.find(l => l.startsWith("Output:"));
                    const answerText = outputLine ? outputLine.substring("Output:".length).trim() : "";
                    return (_jsxs(Text, { color: themeColor, children: [indent, _jsx(Text, { bold: true, color: themeColor, children: isError ? "↳ ✗ " : "↳ ✓ " }), _jsx(Text, { bold: true, color: themeColor, children: "Question: " }), _jsx(Text, { color: themeColor, children: questionText }), _jsx(Text, { bold: true, color: themeColor, children: " | Answer: " }), _jsx(Text, { color: themeColor, children: answerText || "N/A" })] }));
                })() : (_jsxs(Text, { color: themeColor, children: [indent, _jsx(Text, { bold: true, color: themeColor, children: isError ? "↳ ✗ " : "↳ ✓ " }), _jsx(Text, { color: themeColor, children: cleanDesc }), " ", _jsx(Text, { dimColor: true, italic: true, children: isError ? "(click to view error)" : "(click to view output)" })] })) }, `child-${childIdx}`));
        }
        return (_jsx(Box, { flexDirection: "column", children: contentText.split("\n").map((l, idx) => {
                const isFirstLine = idx === 0;
                const cleanLine = l.replace(/^(Completed|Failed|Loaded instructions)\s*-\s*/i, "").trim();
                return (_jsxs(Box, { flexDirection: "row", children: [_jsxs(Text, { color: themeColor, children: [indent, isFirstLine ? (isError ? "▼ ✗ " : "▼ ✓ ") : "    "] }), isFirstLine ? (_jsxs(Text, { color: themeColor, children: [cleanLine, _jsx(Text, { dimColor: true, italic: true, children: " (click to collapse)" })] })) : l.startsWith("Output:") || l.startsWith("Detail:") ? (() => {
                            const type = l.startsWith("Output:") ? "Output: " : "Detail: ";
                            const rest = l.substring(type.length);
                            return (_jsxs(_Fragment, { children: [_jsx(Text, { bold: true, color: isError ? "cyan" : "gray", dimColor: !isError, children: type }), _jsx(Text, { dimColor: true, children: rest })] }));
                        })() : (_jsx(Text, { color: isError ? "white" : "gray", dimColor: !isError, children: l }))] }, idx));
            }) }, `child-${childIdx}`));
    }
    // Fallback for other child types (system, error)
    return (_jsx(Box, { flexDirection: "column", children: child.content.split("\n").map((l, idx) => (_jsxs(Box, { flexDirection: "row", children: [_jsxs(Text, { color: "gray", children: [indent, "\u2502    "] }), _jsx(Text, { children: l })] }, idx))) }, `child-${childIdx}`));
}
export const ChatLineComponent = React.memo(function ChatLineComponent({ line: rawLine, isFirst, lineIndex, tokensUp, tokensDown, modelName, maxResponseLines, chatWidth, isLastAssistant, isCollapsed, expandedChildren = new Set(), toggleChildExpand, }) {
    const line = React.useMemo(() => {
        return {
            ...rawLine,
            content: rawLine.content.replace(/\r\n/g, "\n").replace(/\r/g, ""),
            children: rawLine.children?.map(child => ({
                ...child,
                content: child.content.replace(/\r\n/g, "\n").replace(/\r/g, "")
            }))
        };
    }, [rawLine]);
    // Helper: extract tool name from content
    const extractToolName = (content) => {
        const match = content.match(/Detail:\s*(\w+)/);
        return match ? match[1] : "tool";
    };
    // Helper: extract description from content
    const extractDescription = (content) => {
        const firstLine = content.split("\n")[0].replace(/^[⚡✓✗📖🚨]\s*/, "").trim();
        const minimized = minimizePathInDescription(firstLine);
        return minimized.length > 60 ? minimized.slice(0, 57) + "..." : minimized;
    };
    switch (line.type) {
        case "user": {
            const content = line.content.replace(/^❯ /, "");
            return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "cyan", children: [isFirst ? "┌" : "├", "\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "cyan", children: "\uD83D\uDC64 ACCESS_POINT: USER" }), " ]", lineIndex !== undefined ? _jsxs(Text, { dimColor: true, children: [" [#", lineIndex, "]"] }) : null] }), content.split("\n").map((l, idx) => (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "cyan", children: "\u2502    " }), _jsx(Text, { children: renderBoldTargetText(l) })] }, idx))), _jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "cyan", children: "\u2502 " }) })] }));
        }
        case "assistant": {
            const capped = isLastAssistant
                ? { text: line.content, truncated: false }
                : capDisplayLines(line.content, maxResponseLines || 12, chatWidth || 80);
            const children = line.children || [];
            return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "blue", children: [isFirst ? "┌" : "├", "\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "blue", children: "\u2726 SUPERAGENT" }), " ]", lineIndex !== undefined ? _jsxs(Text, { dimColor: true, children: [" [#", lineIndex, "]"] }) : null] }), renderMarkdown(capped.text, "blue"), capped.truncated && (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "blue", children: "\u2502    " }), _jsx(Text, { color: "yellow", children: "... [long response truncated; click to open scroll view, mouse scroll / \u2191\u2193] ..." })] })), children.length > 0 && children.map((child, childIdx) => {
                        const isChildCollapsed = isCollapsibleType(child.type) && !expandedChildren.has(childIdx);
                        return renderNestedChild(child, childIdx, isChildCollapsed, "blue");
                    }), _jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "blue", children: "\u2502 " }) })] }));
        }
        case "tool_start": {
            const content = line.content.replace(/^⚡ /, "");
            if (isCollapsed) {
                const toolName = extractToolName(line.content);
                const desc = extractDescription(content);
                return (_jsx(Box, { flexDirection: "column", children: _jsxs(Text, { color: "yellow", children: ["\u251C\u2500\u2500\u2500 [ ", _jsxs(Text, { bold: true, color: "yellow", children: ["\u25B6 \u2699\uFE0F ", desc] }), _jsxs(Text, { dimColor: true, children: [" (", toolName, ")"] }), " ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to expand" })] }) }));
            }
            return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "yellow", children: ["\u251C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "yellow", children: "\u2699\uFE0F SYSTEM_INVOKING_MODULE" }), " ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to collapse" })] }), renderToolStart(content), _jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "yellow", children: "\u2502 " }) })] }));
        }
        case "tool_end": {
            const isError = line.content.startsWith("✗");
            const contentText = line.content.substring(2);
            const themeColor = isError ? "red" : "green";
            if (isCollapsed) {
                const desc = extractDescription(contentText);
                const icon = isError ? "🔴" : "🟢";
                const status = isError ? "Failed" : "Done";
                return (_jsx(Box, { flexDirection: "column", children: _jsxs(Text, { color: themeColor, children: ["\u251C\u2500\u2500\u2500 [ ", _jsxs(Text, { bold: true, color: themeColor, children: ["\u25B6 ", icon, " ", status, ":"] }), " ", _jsx(Text, { dimColor: true, children: desc }), " ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to expand" })] }) }));
            }
            return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: themeColor, children: ["\u251C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: themeColor, children: isError ? "🔴 SYSTEM_CALL_FAILED" : "🟢 SYSTEM_CALL_SUCCESS" }), " ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to collapse" })] }), renderToolEnd(contentText, isError), _jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: themeColor, children: "\u2502 " }) })] }));
        }
        case "error": {
            const contentText = line.content.replace(/^Error: /, "");
            if (isCollapsed) {
                const firstLine = contentText.split("\n")[0];
                const preview = firstLine.length > 50 ? firstLine.slice(0, 47) + "..." : firstLine;
                return (_jsx(Box, { flexDirection: "column", children: _jsxs(Text, { color: "red", children: ["\u251C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "red", children: "\u25B6 \uD83D\uDEA8 Error:" }), " ", _jsx(Text, { dimColor: true, children: preview }), " ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to expand" })] }) }));
            }
            return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "red", children: ["\u251C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "red", children: "\uD83D\uDEA8 ERROR_REPORT" }), " ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to collapse" })] }), contentText.split("\n").map((l, idx) => (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "red", children: "\u2502    " }), _jsx(Text, { color: "red", children: l })] }, idx))), _jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "red", children: "\u2502 " }) })] }));
        }
        case "system":
            if (isCollapsed) {
                const firstLine = line.content.split("\n")[0];
                const preview = firstLine.length > 50 ? firstLine.slice(0, 47) + "..." : firstLine;
                return (_jsx(Box, { flexDirection: "column", children: _jsxs(Text, { color: "gray", children: ["\u251C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "gray", children: "\u25B6 \u2139\uFE0F System:" }), " ", _jsx(Text, { dimColor: true, children: preview }), " ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to expand" })] }) }));
            }
            return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "gray", children: ["\u251C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "gray", children: "\u2139\uFE0F SYSTEM_INFO" }), " ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to collapse" })] }), line.content.split("\n").map((l, idx) => (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "gray", children: "\u2502    " }), _jsx(Text, { color: "gray", italic: true, children: l })] }, idx))), _jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "gray", children: "\u2502 " }) })] }));
        default:
            return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "gray", children: ["\u251C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "gray", children: "COMM_PACKET" }), " ]"] }), line.content.split("\n").map((l, idx) => (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "gray", children: "\u2502    " }), _jsx(Text, { children: l })] }, idx))), _jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "gray", children: "\u2502 " }) })] }));
    }
});
//# sourceMappingURL=chat-line.js.map