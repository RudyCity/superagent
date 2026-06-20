import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React from "react";
import { Box, Text } from "ink";
import { formatCompactNumber } from "../utils/text.js";
import { capDisplayLines } from "../utils/responseScroll.js";
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
export function renderMarkdown(content, themeColor = "magenta", showCursor = false) {
    const rawLines = content.split("\n");
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
                    parsedElements.push(_jsx(Text, { children: currentText }, parsedElements.length));
                    break;
                }
                if (minIdx > 0) {
                    parsedElements.push(_jsx(Text, { children: currentText.slice(0, minIdx) }, parsedElements.length));
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
            return (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: themeColor, children: "\u2502    " }), isSysLine ? (_jsxs(Text, { children: [listPrefix, _jsx(Text, { bold: true, color: "yellow", children: "[SYS]" })] })) : listPrefix ? (_jsx(Text, { color: "magenta", bold: true, children: listPrefix })) : null, _jsx(Box, { flexShrink: 1, children: _jsxs(Text, { children: [parsedElements, showCursor && idx === processedLines.length - 1 && "█"] }) })] }, idx));
        }) }));
}
export function renderToolStart(content) {
    const lines = content.split("\n");
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
    const lines = content.split("\n");
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
export const ChatLineComponent = React.memo(function ChatLineComponent({ line, isFirst, tokensUp, tokensDown, modelName, maxResponseLines, chatWidth, isLastAssistant, }) {
    switch (line.type) {
        case "user": {
            const content = line.content.replace(/^❯ /, "");
            return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "cyan", children: [isFirst ? "┌" : "├", "\u2500\u2500\u2500[ ", _jsx(Text, { bold: true, color: "cyan", children: "\uD83D\uDC64 ACCESS_POINT: USER" }), " ]"] }), content.split("\n").map((l, idx) => (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "cyan", children: "\u2502    " }), _jsx(Text, { children: l })] }, idx))), _jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "cyan", children: "\u2502 " }) })] }));
        }
        case "assistant": {
            const capped = isLastAssistant
                ? { text: line.content, truncated: false }
                : capDisplayLines(line.content, maxResponseLines || 12, chatWidth || 80);
            return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "magenta", children: [isFirst ? "┌" : "├", "\u2500\u2500\u2500[ ", _jsxs(Text, { bold: true, color: "magenta", children: ["\u2726 COGNITIVE_NODE: SUPERAGENT", modelName ? ` (${modelName})` : ""] }), _jsxs(Text, { dimColor: true, children: [" (\u25B2", formatCompactNumber(tokensUp || 0), " | \u25BC", formatCompactNumber(tokensDown || 0), ")"] }), " ]"] }), renderMarkdown(capped.text, "magenta"), capped.truncated && (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "magenta", children: "\u2502    " }), _jsx(Text, { color: "yellow", children: "... [response panjang dipotong; klik untuk buka scroll view, mouse scroll / \u2191\u2193] ..." })] })), _jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "magenta", children: "\u2502 " }) })] }));
        }
        case "tool_start": {
            const content = line.content.replace(/^⚡ /, "");
            return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "yellow", children: ["\u251C\u2500\u2500\u2500[ ", _jsx(Text, { bold: true, color: "yellow", children: "\u2699\uFE0F SYSTEM_INVOKING_MODULE" }), " ]"] }), renderToolStart(content), _jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "yellow", children: "\u2502 " }) })] }));
        }
        case "tool_end": {
            const isError = line.content.startsWith("✗");
            const contentText = line.content.substring(2);
            const themeColor = isError ? "red" : "green";
            return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: themeColor, children: ["\u251C\u2500\u2500\u2500[ ", _jsx(Text, { bold: true, color: themeColor, children: isError ? "🔴 SYSTEM_CALL_FAILED" : "🟢 SYSTEM_CALL_SUCCESS" }), " ]"] }), renderToolEnd(contentText, isError), _jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: themeColor, children: "\u2502 " }) })] }));
        }
        case "error": {
            const contentText = line.content.replace(/^Error: /, "");
            return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "red", children: ["\u251C\u2500\u2500\u2500[ ", _jsx(Text, { bold: true, color: "red", children: "\uD83D\uDEA8 ERROR_REPORT" }), " ]"] }), contentText.split("\n").map((l, idx) => (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "red", children: "\u2502    " }), _jsx(Text, { color: "red", children: l })] }, idx))), _jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "red", children: "\u2502 " }) })] }));
        }
        case "system":
            return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "gray", children: ["\u251C\u2500\u2500\u2500[ ", _jsx(Text, { bold: true, color: "gray", children: "\u2139\uFE0F SYSTEM_INFO" }), " ]"] }), line.content.split("\n").map((l, idx) => (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "gray", children: "\u2502    " }), _jsx(Text, { color: "gray", italic: true, children: l })] }, idx))), _jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "gray", children: "\u2502 " }) })] }));
        default:
            return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "gray", children: ["\u251C\u2500\u2500\u2500[ ", _jsx(Text, { bold: true, color: "gray", children: "COMM_PACKET" }), " ]"] }), line.content.split("\n").map((l, idx) => (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "gray", children: "\u2502    " }), _jsx(Text, { children: l })] }, idx))), _jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "gray", children: "\u2502 " }) })] }));
    }
});
//# sourceMappingURL=chat-line.js.map