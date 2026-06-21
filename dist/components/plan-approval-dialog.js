import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import fs from "fs";
import { wrapTextForDisplay } from "../utils/responseScroll.js";
const OPTIONS = [
    { label: "Approve Plan & Proceed", emoji: "✅", color: "green" },
    { label: "Reject Plan & Stop", emoji: "❌", color: "red" },
    { label: "Custom Feedback / Discuss", emoji: "💬", color: "cyan" },
];
export function PlanApprovalDialog({ planFilePath, selectedIndex, step, borderColor = "yellow", terminalWidth, maxContentHeight = 15, }) {
    const [scrollOffset, setScrollOffset] = useState(0);
    // Read plan content (memoised on file path)
    const planLines = useMemo(() => {
        try {
            const raw = fs.readFileSync(planFilePath, "utf8");
            return raw.split("\n");
        }
        catch {
            return ["(Plan file not found or unreadable)"];
        }
    }, [planFilePath]);
    const totalLines = planLines.length;
    // Handle PageUp / PageDown for plan content scroll
    useInput((_input, key) => {
        if (step !== 1)
            return;
        if (key.pageUp || (key.ctrl && key.upArrow) || (key.shift && key.upArrow)) {
            setScrollOffset((prev) => Math.max(0, prev - maxContentHeight));
        }
        if (key.pageDown || (key.ctrl && key.downArrow) || (key.shift && key.downArrow)) {
            const maxScroll = Math.max(0, totalLines - maxContentHeight);
            setScrollOffset((prev) => Math.min(maxScroll, prev + maxContentHeight));
        }
    });
    // Clamp scroll offset if content shrinks
    const maxScroll = Math.max(0, totalLines - maxContentHeight);
    const clampedOffset = Math.min(scrollOffset, maxScroll);
    const visibleLines = planLines.slice(clampedOffset, clampedOffset + maxContentHeight);
    const hasMoreAbove = clampedOffset > 0;
    const hasMoreBelow = clampedOffset + maxContentHeight < totalLines;
    const widthVal = terminalWidth || process.stdout.columns || 110;
    const contentWidth = Math.max(10, widthVal - 4);
    // ─── Step 2: custom feedback input prompt ───
    if (step === 2) {
        return (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Box, { flexDirection: "row", width: "100%", children: _jsxs(Text, { color: borderColor, wrap: "truncate-end", children: ["\u251C\u2500\u2500\u2500[ ", _jsx(Text, { bold: true, color: borderColor, children: "\uD83D\uDCAC CUSTOM PLAN FEEDBACK (Type your message & press Enter, Esc: cancel):" }), " ]"] }) }), _jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u2502 " }), _jsx(Text, { color: "gray", dimColor: true, wrap: "truncate-end", children: "Describe the changes you'd like \u2014 the agent will receive your feedback and revise the plan." })] })] }));
    }
    // ─── Step 1: plan content + options ───
    return (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Box, { flexDirection: "row", width: "100%", children: _jsxs(Text, { color: borderColor, wrap: "truncate-end", children: ["\u251C\u2500\u2500\u2500[ ", _jsx(Text, { bold: true, color: borderColor, children: "\u26A0\uFE0F PLAN APPROVAL REQUIRED" }), " ]"] }) }), _jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u2502 " }), _jsxs(Text, { color: "gray", dimColor: true, wrap: "truncate-end", children: ["File: ", _jsx(Text, { color: "cyan", bold: true, children: planFilePath })] })] }), _jsx(Box, { flexDirection: "row", width: "100%", children: _jsx(Text, { color: borderColor, children: "\u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 Plan Content \u2500\u2500" }) }), hasMoreAbove && (_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u2502 " }), _jsxs(Text, { color: "yellow", wrap: "truncate-end", children: ["\u25B2 ... (", clampedOffset, " more lines above \u2014 use PgUp/Ctrl+\u2191 to scroll) ..."] })] })), visibleLines.map((line, idx) => {
                const wrappedLines = wrapTextForDisplay(line || " ", contentWidth);
                return wrappedLines.map((wl, wIdx) => (_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u2502 " }), _jsx(Text, { color: "white", wrap: "truncate-end", children: wl })] }, `${clampedOffset + idx}-${wIdx}`)));
            }), hasMoreBelow && (_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u2502 " }), _jsxs(Text, { color: "yellow", wrap: "truncate-end", children: ["\u25BC ... (", totalLines - clampedOffset - maxContentHeight, " more lines below \u2014 use PgDn/Ctrl+\u2193 to scroll) ..."] })] })), _jsx(Box, { flexDirection: "row", width: "100%", children: _jsx(Text, { color: borderColor, children: "\u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 Actions \u2500\u2500\u2500\u2500\u2500\u2500\u2500" }) }), OPTIONS.map((opt, idx) => {
                const isSelected = idx === selectedIndex;
                return (_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u2502 " }), _jsx(Box, { flexDirection: "row", flexShrink: 1, children: _jsxs(Text, { color: isSelected ? opt.color : "gray", bold: isSelected, dimColor: !isSelected, wrap: "truncate-end", children: [isSelected ? "❯ " : "  ", opt.emoji, " ", opt.label] }) })] }, opt.label));
            }), _jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u2502 " }), _jsx(Text, { color: "gray", dimColor: true, wrap: "truncate-end", children: "\u2191/\u2193 navigate \u00B7 Enter: select \u00B7 PgUp/PgDn: scroll plan" })] })] }));
}
/** The default option labels — used by callers that set wizardOptions */
export const PLAN_APPROVAL_OPTIONS = OPTIONS.map((o) => `${o.emoji} ${o.label}`);
/** How many lines the plan approval dialog occupies (for chrome height calc) */
export function planApprovalChromeHeight(planFilePath, step, maxContentHeight = 15) {
    if (step === 2)
        return 3; // title + hint + border
    let lines = 0;
    let totalLines = 0;
    try {
        totalLines = fs.readFileSync(planFilePath, "utf8").split("\n").length;
    }
    catch {
        totalLines = 1;
    }
    const visibleContent = Math.min(totalLines, maxContentHeight);
    lines += 1; // title
    lines += 1; // file path
    lines += 1; // separator "Plan Content"
    if (totalLines > maxContentHeight)
        lines += 1; // scroll-up indicator
    lines += visibleContent;
    if (totalLines > maxContentHeight && totalLines > visibleContent)
        lines += 1; // scroll-down indicator
    lines += 1; // separator "Actions"
    lines += OPTIONS.length; // options
    lines += 1; // hint line
    return lines;
}
//# sourceMappingURL=plan-approval-dialog.js.map