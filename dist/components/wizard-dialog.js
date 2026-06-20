import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { wrapTextForDisplay } from "../utils/responseScroll.js";
function WizardSpinner({ color }) {
    const [frame, setFrame] = useState(0);
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    useEffect(() => {
        const t = setInterval(() => setFrame(f => (f + 1) % frames.length), 80);
        return () => clearInterval(t);
    }, []);
    return _jsx(Text, { color: color, bold: true, children: frames[frame] });
}
export function WizardDialog({ title, description, borderColor, options = [], selectedIndex = 0, maxVisible = 10, isMultiSelect = false, selectedSet, marginY, marginTop, marginBottom, isLoading = false, searchQuery, searchPlaceholder = "Type to filter...", terminalWidth, }) {
    const finalMarginTop = marginTop !== undefined ? marginTop : (marginY !== undefined ? marginY : 1);
    const finalMarginBottom = marginBottom !== undefined ? marginBottom : (marginY !== undefined ? marginY : 0);
    const actualOptions = Array.isArray(options) ? options : [];
    const total = actualOptions.length;
    let visibleOptions = actualOptions;
    let start = 0;
    let end = total;
    const rawSelectedIndex = typeof selectedIndex === "number" ? selectedIndex : Number(selectedIndex);
    const numericSelectedIndex = total > 0 ? Math.min(Math.max(0, rawSelectedIndex), total - 1) : 0;
    if (maxVisible && total > maxVisible) {
        start = Math.max(0, numericSelectedIndex - Math.floor(maxVisible / 2));
        end = start + maxVisible;
        if (end > total) {
            end = total;
            start = Math.max(0, end - maxVisible);
        }
        visibleOptions = actualOptions.slice(start, end);
    }
    return (_jsxs(Box, { flexDirection: "column", marginTop: finalMarginTop, marginBottom: finalMarginBottom, children: [_jsx(Box, { flexDirection: "row", width: "100%", children: _jsxs(Text, { color: borderColor, wrap: "truncate-end", children: ["\u251C\u2500\u2500\u2500[ ", _jsx(Text, { bold: true, color: borderColor, children: title }), " ]"] }) }), description && (() => {
                const widthVal = terminalWidth || (process.stdout.columns || 110);
                const maxTextWidth = Math.max(10, widthVal - 4);
                const descLines = wrapTextForDisplay(description, maxTextWidth);
                return (_jsxs(_Fragment, { children: [descLines.map((line, idx) => (_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u2502 " }), _jsx(Text, { color: "white", children: line })] }, idx))), _jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: borderColor, children: "\u2502 " }) })] }));
            })(), searchQuery !== undefined && (_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u2502 " }), _jsx(Text, { color: "cyan", bold: true, children: "\uD83D\uDD0D " }), _jsx(Box, { flexShrink: 1, children: _jsx(Text, { color: "white", wrap: "truncate-start", children: searchQuery || _jsx(Text, { color: "gray", dimColor: true, children: searchPlaceholder }) }) }), _jsx(Text, { color: "cyan", bold: true, children: "\u2588" })] })), isLoading && (_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u2502 " }), _jsx(WizardSpinner, { color: borderColor }), _jsx(Box, { flexShrink: 1, children: _jsx(Text, { color: "yellow", wrap: "truncate-end", children: "  Fetching models from API..." }) })] })), (searchQuery !== undefined || isLoading) && (_jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: borderColor, children: "\u2502" }) })), start > 0 && (_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u2502 " }), _jsx(Box, { flexShrink: 1, children: _jsxs(Text, { color: "yellow", wrap: "truncate-end", children: ["   \u25B2 ... (", start, " more options above) ..."] }) })] })), visibleOptions.map((opt, idx) => {
                const originalIndex = start + idx;
                const isSelected = originalIndex === numericSelectedIndex;
                const isChecked = selectedSet?.has(originalIndex) ?? false;
                const optStr = typeof opt === "string" ? opt : JSON.stringify(opt);
                const checkPrefix = isMultiSelect ? (isChecked ? "[x] " : "[ ] ") : "";
                return (_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u2502 " }), _jsx(Box, { flexDirection: "row", flexShrink: 1, children: _jsxs(Text, { color: isSelected ? borderColor : "gray", bold: isSelected, wrap: "truncate-end", children: [isSelected ? "❯ " : "  ", " ", checkPrefix, optStr] }) })] }, `${optStr}-${originalIndex}`));
            }), !isLoading && total === 0 && searchQuery !== undefined && (_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u2502 " }), _jsx(Box, { flexShrink: 1, children: _jsxs(Text, { color: "gray", dimColor: true, wrap: "truncate-end", children: ["  No models match \"", searchQuery || "", "\". Try a different term."] }) })] })), end < total && (_jsxs(Box, { flexDirection: "row", width: "100%", children: [_jsx(Text, { color: borderColor, children: "\u2502 " }), _jsx(Box, { flexShrink: 1, children: _jsxs(Text, { color: "yellow", wrap: "truncate-end", children: ["   \u25BC ... (", total - end, " more options below) ..."] }) })] }))] }));
}
//# sourceMappingURL=wizard-dialog.js.map