import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useMemo, useRef, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import fs from "fs";
import { wrapTextForDisplay } from "../utils/responseScroll.js";
const OPTIONS = [
    { label: "Approve Plan & Proceed", emoji: "✅", color: "green" },
    { label: "Reject Plan & Stop", emoji: "❌", color: "red" },
    { label: "Custom Feedback / Discuss", emoji: "💬", color: "cyan" },
];
export function PlanApprovalDialog({ planFilePath, selectedIndex, step, borderColor = "yellow", terminalWidth, maxContentHeight = 15, focus = "actions", scrollOffset: propScrollOffset, onScrollChange: propOnScrollChange, }) {
    const [localScrollOffset, setLocalScrollOffset] = useState(0);
    const scrollOffset = propScrollOffset !== undefined ? propScrollOffset : localScrollOffset;
    const setScrollOffset = (val) => {
        const next = typeof val === "function" ? val(scrollOffset) : val;
        if (propOnScrollChange) {
            propOnScrollChange(next);
        }
        else {
            setLocalScrollOffset(next);
        }
    };
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
    // Handle PageUp / PageDown / Arrow keys for plan content scroll
    const handlerRef = useRef();
    handlerRef.current = (_input, key) => {
        if (step !== 1)
            return;
        const isPlanFocused = focus === "plan";
        if (key.pageUp || (key.ctrl && key.upArrow) || (key.shift && key.upArrow) || (isPlanFocused && key.upArrow)) {
            const amount = (key.upArrow && !key.ctrl && !key.shift) ? 1 : maxContentHeight;
            setScrollOffset((prev) => Math.max(0, prev - amount));
        }
        if (key.pageDown || (key.ctrl && key.downArrow) || (key.shift && key.downArrow) || (isPlanFocused && key.downArrow)) {
            const amount = (key.downArrow && !key.ctrl && !key.shift) ? 1 : maxContentHeight;
            const maxScroll = Math.max(0, totalLines - maxContentHeight);
            setScrollOffset((prev) => Math.min(maxScroll, prev + amount));
        }
    };
    const stableHandler = useCallback((_input, key) => {
        handlerRef.current?.(_input, key);
    }, []);
    useInput(stableHandler);
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
    const isPlanFocused = focus === "plan";
    const focusTag = isPlanFocused
        ? "⬅ Scroll Plan  |  → Focus Actions"
        : "↑↓ Navigate Actions  |  ← Scroll Plan";
    const totalLabel = `line ${clampedOffset + 1}–${Math.min(clampedOffset + maxContentHeight, totalLines)} of ${totalLines}`;
    // ─── Step 1: plan content + options ───
    return (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { bold: true, color: "yellow", children: "\u2554\u2550\u2550[ " }), _jsx(Text, { bold: true, color: "yellow", children: "\u26A1 PLAN" }), _jsx(Text, { bold: true, color: "magenta", children: " APPROVAL" }), _jsx(Text, { bold: true, color: "red", children: " REQUIRED" }), _jsx(Text, { bold: true, color: "yellow", children: " ]\u2550\u2550\u2557" })] }), _jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { bold: true, color: "yellow", children: "\u2551  " }), _jsx(Text, { color: "gray", children: "Agent has prepared a plan \u2014" }), _jsx(Text, { color: "white", bold: true, children: " review and decide before execution proceeds." })] }), _jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { bold: true, color: "yellow", children: "\u2551  " }), _jsx(Text, { color: "gray", dimColor: true, children: "Focus: " }), _jsx(Text, { color: "cyan", bold: true, children: focusTag })] }), _jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { bold: true, color: "yellow", children: "\u255A\u2550\u2550[ " }), _jsx(Text, { color: "gray", dimColor: true, children: "\uD83D\uDCC4 " }), _jsx(Text, { color: "cyan", bold: true, wrap: "truncate-end", children: planFilePath }), _jsx(Text, { bold: true, color: "yellow", children: " ]" })] }), _jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u250C\u2500 " }), _jsx(Text, { color: borderColor, bold: true, children: "PLAN CONTENT" }), _jsxs(Text, { color: "gray", dimColor: true, children: [" (", totalLabel, ")"] }), _jsx(Text, { color: borderColor, children: " \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500" })] }), hasMoreAbove && (_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u2502 " }), _jsxs(Text, { color: "yellow", bold: true, children: ["\u25B2 ", clampedOffset, " lines above"] }), _jsx(Text, { color: "gray", dimColor: true, children: "  (PgUp / Ctrl+\u2191)" })] })), visibleLines.map((line, idx) => {
                const wrappedLines = wrapTextForDisplay(line || " ", contentWidth);
                return wrappedLines.map((wl, wIdx) => (_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, dimColor: true, children: "\u2502 " }), _jsx(Text, { color: "white", wrap: "truncate-end", children: wl })] }, `${clampedOffset + idx}-${wIdx}`)));
            }), hasMoreBelow && (_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u2502 " }), _jsxs(Text, { color: "yellow", bold: true, children: ["\u25BC ", totalLines - clampedOffset - maxContentHeight, " lines below"] }), _jsx(Text, { color: "gray", dimColor: true, children: "  (PgDn / Ctrl+\u2193)" })] })), _jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u251C\u2500 " }), _jsx(Text, { color: borderColor, bold: true, children: "ACTIONS" }), _jsx(Text, { color: borderColor, children: " \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500" })] }), OPTIONS.map((opt, idx) => {
                const isSelected = idx === selectedIndex;
                return (_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u2502 " }), isSelected ? (_jsxs(_Fragment, { children: [_jsx(Text, { bold: true, color: opt.color, children: "\u25B6 [" }), _jsxs(Text, { bold: true, color: opt.color, children: [" ", opt.emoji, " ", opt.label, " "] }), _jsx(Text, { bold: true, color: opt.color, children: "]" })] })) : (_jsxs(Text, { color: "gray", dimColor: true, children: ["  ", opt.emoji, " ", opt.label] }))] }, opt.label));
            }), _jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u2514\u2500 " }), _jsx(Text, { color: "gray", dimColor: true, children: "\u2191\u2193 " }), _jsx(Text, { color: "white", dimColor: true, children: "navigate" }), _jsx(Text, { color: "gray", dimColor: true, children: "  \u00B7  Enter " }), _jsx(Text, { color: "green", dimColor: true, children: "confirm" }), _jsx(Text, { color: "gray", dimColor: true, children: "  \u00B7  \u2190\u2192 " }), _jsx(Text, { color: "cyan", dimColor: true, children: "switch focus" }), _jsx(Text, { color: "gray", dimColor: true, children: "  \u00B7  PgUp/PgDn " }), _jsx(Text, { color: "yellow", dimColor: true, children: "scroll" })] })] }));
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
    lines += 4; // banner: ╔══, ║ desc, ║ focus, ╚══
    lines += 1; // PLAN CONTENT header
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