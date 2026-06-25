import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from "react";
import { Box, Text } from "ink";
// Render inline Markdown formatting like bold, code blocks, links, and file/web URLs
export function renderLogInlineStyles(text, defaultColor, isBold, dimColor) {
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
            parsedElements.push(_jsx(Text, { color: defaultColor, bold: isBold, dimColor: dimColor, children: currentText }, parsedElements.length));
            break;
        }
        if (minIdx > 0) {
            parsedElements.push(_jsx(Text, { color: defaultColor, bold: isBold, dimColor: dimColor, children: currentText.slice(0, minIdx) }, parsedElements.length));
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
                parsedElements.push(_jsx(Text, { color: defaultColor, bold: isBold, dimColor: dimColor, children: currentText.slice(0, 2) }, parsedElements.length));
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
                parsedElements.push(_jsx(Text, { color: defaultColor, bold: isBold, dimColor: dimColor, children: currentText.slice(0, 1) }, parsedElements.length));
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
                parsedElements.push(_jsx(Text, { color: defaultColor, bold: isBold, dimColor: dimColor, children: currentText[0] }, parsedElements.length));
                currentText = currentText.slice(1);
            }
        }
    }
    return _jsx(_Fragment, { children: parsedElements });
}
export function ThinkingSpinner({ type = "orchestrating" }) {
    const [frame, setFrame] = useState(0);
    const spinners = ["▰▱▱▱▱▱▱", "▰▰▱▱▱▱▱", "▰▰▰▱▱▱▱", "▰▰▰▰▱▱▱", "▰▰▰▰▰▱▱", "▰▰▰▰▰▰▱", "▰▰▰▰▰▰▰"];
    useEffect(() => {
        const timer = setInterval(() => {
            setFrame((prev) => (prev + 1) % spinners.length);
        }, 150);
        return () => clearInterval(timer);
    }, []);
    const label = type === "orchestrating" ? "ORCHESTRATING" : "PROCESSING";
    return _jsxs(Text, { color: "yellow", bold: true, children: ["\u26A1 ", label, " [", spinners[frame], "] "] });
}
export function ToolLoadingIndicator() {
    const [frame, setFrame] = useState(0);
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    useEffect(() => {
        const interval = setInterval(() => {
            setFrame((prev) => (prev + 1) % frames.length);
        }, 120);
        return () => clearInterval(interval);
    }, []);
    return _jsxs(Text, { color: "yellow", children: [frames[frame], " Running system tool..."] });
}
export function BlinkingCursor() {
    const [activeBlink, setActiveBlink] = useState(true);
    useEffect(() => {
        const timer = setInterval(() => {
            setActiveBlink((prev) => !prev);
        }, 600);
        return () => clearInterval(timer);
    }, []);
    return _jsx(Text, { color: "green", bold: true, children: activeBlink ? "█" : " " });
}
export function InspectorPanel({ selectedSession, focusArea, logScrollOffset, isHistoryTruncated, feedWidth, logBoxHeight, visibleLogs, isExecutingTool, timeLeft, activeToolLines, workspaceHeight, }) {
    return (_jsxs(Box, { flexDirection: "column", width: "58%", height: workspaceHeight, justifyContent: "flex-start", children: [_jsxs(Box, { flexDirection: "row", justifyContent: "space-between", marginBottom: 1, children: [_jsxs(Box, { flexDirection: "row", children: [_jsxs(Text, { bold: true, color: focusArea === "logs" ? "green" : "cyan", children: ["\uD83D\uDD0E INSPECT: ", selectedSession.id.slice(0, 20), _jsxs(Text, { color: "gray", dimColor: true, children: [" ", isHistoryTruncated ? "(Truncated)" : "(Full)"] })] }), logScrollOffset > 0 && (_jsxs(Text, { color: "yellow", bold: true, children: [" [Scroll: -", logScrollOffset, " - Esc to snap bottom]"] }))] }), _jsxs(Box, { flexDirection: "column", alignItems: "flex-end", children: [_jsxs(Text, { color: "blue", bold: true, children: ["(", selectedSession.branch || "main", ")"] }), selectedSession.type === "SUPERAGENT" && selectedSession.worktreePath && (_jsxs(Text, { color: "gray", dimColor: true, children: ["wt: ...", selectedSession.worktreePath.slice(-30)] }))] })] }), (() => {
                const taskStr = selectedSession.task || "";
                const normalizedTask = taskStr.replace(/\r\n/g, "\n").replace(/\r/g, "");
                const lines = normalizedTask.split("\n").filter(line => line.trim() !== "");
                if (lines.length === 0)
                    return null;
                if (isHistoryTruncated) {
                    const displayLine = lines[0];
                    const suffix = lines.length > 1 ? " ... (Truncated, Ctrl+T for full)" : "";
                    return (_jsxs(Text, { color: "white", bold: true, wrap: "truncate-end", children: ["Task: ", _jsxs(Text, { color: "gray", bold: false, children: [displayLine, suffix] })] }));
                }
                return (_jsxs(Box, { flexDirection: "column", width: feedWidth, children: [_jsx(Text, { color: "white", bold: true, children: "Task:" }), lines.map((line, idx) => (_jsx(Text, { color: "gray", children: line }, idx)))] }));
            })(), _jsxs(Box, { flexDirection: "column", marginTop: 1, height: logBoxHeight, paddingX: 1, justifyContent: "flex-start", children: [visibleLogs, selectedSession.status === "WORKING" && logScrollOffset === 0 && (selectedSession.type !== "MASTER" || !isExecutingTool) && (() => {
                        const isIdleTask = selectedSession.task.startsWith("Idle") || selectedSession.task.startsWith("Error");
                        const spinnerType = (selectedSession.type === "MASTER" && !isIdleTask) ? "orchestrating" : "processing";
                        return (_jsxs(Box, { flexDirection: "row", marginTop: 1, children: [_jsx(ThinkingSpinner, { type: spinnerType }), _jsx(BlinkingCursor, {})] }));
                    })(), selectedSession.type === "MASTER" && isExecutingTool && (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsxs(Text, { color: "yellow", children: ["\u251C\u2500\u2500\u2500 [ ", _jsxs(Text, { bold: true, color: "yellow", children: ["\u2699\uFE0F SYSTEM_CALL: EXECUTING...", timeLeft !== null ? ` (${timeLeft}s left)` : ""] }), " ]"] }), _jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "yellow", children: "\u2502    " }), _jsx(ToolLoadingIndicator, {})] }), activeToolLines.length > 0 && (_jsxs(_Fragment, { children: [_jsxs(Text, { color: "yellow", children: ["\u251C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "yellow", children: "\u2699\uFE0F SYSTEM_CALL_OUTPUT (LIVE)" }), " ]"] }), activeToolLines.map((line, idx) => (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: "yellow", children: "\u2502    " }), _jsx(Text, { color: "gray", children: line })] }, idx)))] }))] }))] })] }));
}
//# sourceMappingURL=inspector-panel.js.map