import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from "ink";
import { renderLogInlineStyles } from "../components/dashboard/inspector-panel.js";
import { wrapTextForDisplay } from "./responseScroll.js";
export function computeWrappedLogs(selectedSession, feedWidth, isHistoryTruncated) {
    const wrappedLines = [];
    const activeLogs = selectedSession.logs.map(l => l.trim()).filter(Boolean);
    const groups = [];
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
        }
        else if (logStr.startsWith("[MASTER]")) {
            label = "🤖 SYSTEM";
            content = logStr.replace("[MASTER]", "").trim();
            color = "yellow";
            dimColor = true;
        }
        else if (logStr.startsWith("[AGENT]")) {
            label = "🧠 AGENT";
            content = logStr.replace("[AGENT]", "").trim();
            color = "white";
            isBold = false;
            parseMarkdown = true;
        }
        else if (logStr.startsWith("[TOOL START]")) {
            label = "🔧 TOOL START";
            content = logStr.replace("[TOOL START]", "").trim();
            color = "magenta";
            noTruncate = true;
        }
        else if (logStr.startsWith("[TOOL END]")) {
            label = "✅ TOOL DONE";
            content = logStr.replace("[TOOL END]", "").trim();
            color = "gray";
            noTruncate = true;
        }
        else if (logStr.startsWith("[ERROR]")) {
            label = "🚨 ERROR";
            content = logStr.replace("[ERROR]", "").trim();
            color = "red";
            isBold = true;
            noTruncate = true;
        }
        else if (logStr.startsWith("[AUTO-APPROVE]")) {
            label = "⚙️ AUTO-APPROVE";
            content = logStr.replace("[AUTO-APPROVE]", "").trim();
            color = "blue";
            dimColor = true;
        }
        else if (logStr.startsWith("[QUESTION]")) {
            label = "❓ QUESTION";
            content = logStr.replace("[QUESTION]", "").trim();
            color = "magenta";
        }
        else if (logStr.startsWith("[THINK]")) {
            label = "🧠 THINK";
            content = logStr.replace("[THINK]", "").trim();
            color = "magenta";
            dimColor = true;
            parseMarkdown = true;
        }
        else if (logStr.startsWith("[TOOL:START]")) {
            label = "🔧 TOOL START";
            content = logStr.replace("[TOOL:START]", "").trim();
            color = "cyan";
            noTruncate = true;
        }
        else if (logStr.startsWith("[TOOL:OK]")) {
            label = "✅ TOOL OK";
            content = logStr.replace("[TOOL:OK]", "").trim();
            color = "gray";
            dimColor = true;
            noTruncate = true;
        }
        else if (logStr.startsWith("[TOOL:FAIL]")) {
            label = "🚨 TOOL FAIL";
            content = logStr.replace("[TOOL:FAIL]", "").trim();
            color = "red";
            isBold = true;
            noTruncate = true;
        }
        const lastGroup = groups[groups.length - 1];
        if (lastGroup &&
            !lastGroup.isBox &&
            lastGroup.label === label &&
            lastGroup.color === color &&
            lastGroup.isBold === isBold &&
            lastGroup.dimColor === dimColor &&
            lastGroup.parseMarkdown === parseMarkdown &&
            lastGroup.noTruncate === noTruncate) {
            lastGroup.rawLines.push(content);
        }
        else {
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
    for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
        const group = groups[groupIdx];
        const useTruncate = isHistoryTruncated && !group.parseMarkdown && !group.noTruncate;
        if (group.isBox) {
            for (const logStr of group.rawLines) {
                const cleanedLogStr = logStr.replace(/\r\n/g, "\n").replace(/\r/g, "");
                const subLines = useTruncate
                    ? cleanedLogStr.split("\n")
                    : wrapTextForDisplay(cleanedLogStr, feedWidth);
                for (let i = 0; i < subLines.length; i++) {
                    const lineText = subLines[i];
                    wrappedLines.push(_jsx(Box, { flexDirection: "row", width: feedWidth, children: _jsx(Text, { color: group.color, wrap: useTruncate ? "truncate-end" : undefined, children: lineText }) }, `log-line-${groupIdx}-${i}`));
                }
            }
            continue;
        }
        const prefix = groupIdx === 0 ? "┌───" : (groupIdx === groups.length - 1 ? "└───" : "├───");
        const subLinePrefix = groupIdx === groups.length - 1 ? "    " : "│   ";
        wrappedLines.push(_jsx(Box, { flexDirection: "row", width: feedWidth, children: _jsxs(Text, { color: group.color === "gray" ? "gray" : group.color, bold: true, wrap: useTruncate ? "truncate-end" : undefined, children: [prefix, " ", _jsx(Text, { color: "white", bold: true, children: "[ " }), _jsx(Text, { color: group.color === "gray" ? "gray" : group.color, bold: true, children: group.label }), _jsx(Text, { color: "white", bold: true, children: " ]" })] }) }, `log-header-${groupIdx}`));
        let inCode = false;
        for (let rawLineIdx = 0; rawLineIdx < group.rawLines.length; rawLineIdx++) {
            const content = group.rawLines[rawLineIdx];
            const cleanedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "");
            const subLines = useTruncate
                ? cleanedContent.split("\n")
                : wrapTextForDisplay(cleanedContent, Math.max(10, feedWidth - 8));
            for (let i = 0; i < subLines.length; i++) {
                const lineText = subLines[i];
                const trimmed = lineText.trim();
                if (group.parseMarkdown) {
                    if (trimmed.startsWith("```")) {
                        inCode = !inCode;
                        const codeLang = trimmed.slice(3).trim() || "TEXT";
                        wrappedLines.push(_jsxs(Box, { flexDirection: "row", width: feedWidth, children: [_jsx(Text, { color: group.color === "gray" ? "gray" : group.color, dimColor: group.dimColor, children: subLinePrefix }), _jsx(Text, { color: "gray", italic: true, wrap: useTruncate ? "truncate-end" : undefined, children: inCode ? `┌─── [ CODE: ${codeLang} ]` : "└─── [ END CODE ]" })] }, `log-line-${groupIdx}-${rawLineIdx}-${i}`));
                        continue;
                    }
                    if (inCode) {
                        wrappedLines.push(_jsxs(Box, { flexDirection: "row", width: feedWidth, children: [_jsxs(Text, { color: group.color === "gray" ? "gray" : group.color, dimColor: group.dimColor, children: [subLinePrefix, "\u2502  "] }), _jsx(Text, { color: "green", wrap: useTruncate ? "truncate-end" : undefined, children: lineText })] }, `log-line-${groupIdx}-${rawLineIdx}-${i}`));
                        continue;
                    }
                    if (trimmed.startsWith("# ")) {
                        wrappedLines.push(_jsxs(Box, { flexDirection: "row", width: feedWidth, children: [_jsx(Text, { color: group.color === "gray" ? "gray" : group.color, dimColor: group.dimColor, children: subLinePrefix }), _jsx(Text, { bold: true, color: "yellow", wrap: useTruncate ? "truncate-end" : undefined, children: lineText.slice(2) })] }, `log-line-${groupIdx}-${rawLineIdx}-${i}`));
                        continue;
                    }
                    if (trimmed.startsWith("## ")) {
                        wrappedLines.push(_jsxs(Box, { flexDirection: "row", width: feedWidth, children: [_jsx(Text, { color: group.color === "gray" ? "gray" : group.color, dimColor: group.dimColor, children: subLinePrefix }), _jsx(Text, { bold: true, color: "cyan", wrap: useTruncate ? "truncate-end" : undefined, children: lineText.slice(3) })] }, `log-line-${groupIdx}-${rawLineIdx}-${i}`));
                        continue;
                    }
                    if (trimmed.startsWith("### ")) {
                        wrappedLines.push(_jsxs(Box, { flexDirection: "row", width: feedWidth, children: [_jsx(Text, { color: group.color === "gray" ? "gray" : group.color, dimColor: group.dimColor, children: subLinePrefix }), _jsx(Text, { bold: true, color: "blue", wrap: useTruncate ? "truncate-end" : undefined, children: lineText.slice(4) })] }, `log-line-${groupIdx}-${rawLineIdx}-${i}`));
                        continue;
                    }
                    let listPrefix = "";
                    let remainingLine = lineText;
                    if (trimmed.startsWith("- ")) {
                        const indent = lineText.indexOf("- ");
                        listPrefix = " ".repeat(indent) + "• ";
                        remainingLine = lineText.slice(indent + 2);
                    }
                    else if (trimmed.startsWith("* ")) {
                        const indent = lineText.indexOf("* ");
                        listPrefix = " ".repeat(indent) + "• ";
                        remainingLine = lineText.slice(indent + 2);
                    }
                    else if (/^\d+\.\s/.test(trimmed)) {
                        const match = lineText.match(/^(\s*)(\d+\.\s)(.*)/);
                        if (match) {
                            listPrefix = match[1] + match[2];
                            remainingLine = match[3];
                        }
                    }
                    wrappedLines.push(_jsxs(Box, { flexDirection: "row", width: feedWidth, children: [_jsx(Text, { color: group.color === "gray" ? "gray" : group.color, dimColor: group.dimColor, children: subLinePrefix }), listPrefix ? _jsx(Text, { color: "magenta", bold: true, children: listPrefix }) : null, _jsx(Box, { flexShrink: 1, children: _jsx(Text, { wrap: useTruncate ? "truncate-end" : undefined, children: renderLogInlineStyles(remainingLine, group.color === "gray" ? "gray" : group.color, group.isBold, group.dimColor) }) })] }, `log-line-${groupIdx}-${rawLineIdx}-${i}`));
                }
                else {
                    wrappedLines.push(_jsxs(Box, { flexDirection: "row", width: feedWidth, children: [_jsx(Text, { color: group.color === "gray" ? "gray" : group.color, dimColor: group.dimColor, children: subLinePrefix }), _jsx(Text, { color: group.color === "gray" ? "gray" : group.color, bold: group.isBold, dimColor: group.dimColor, wrap: useTruncate ? "truncate-end" : undefined, children: lineText })] }, `log-line-${groupIdx}-${rawLineIdx}-${i}`));
                }
            }
        }
        if (groupIdx < groups.length - 1) {
            wrappedLines.push(_jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: group.color === "gray" ? "gray" : group.color, dimColor: group.dimColor, children: subLinePrefix }) }, `log-sep-${groupIdx}`));
        }
    }
    return wrappedLines;
}
//# sourceMappingURL=dashboardLogFormatter.js.map