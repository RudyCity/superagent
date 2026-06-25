import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from "ink";
const MAX_HISTORY_VISIBLE = 10;
export function HistoryPanel({ history, historySelectedIndex, focusMode, }) {
    if (focusMode !== "history")
        return null;
    const uniqueHistory = Array.from(new Set(history));
    if (uniqueHistory.length === 0) {
        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { bold: true, color: "yellow", children: ["\u250C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "yellow", children: "\uD83D\uDCDC INPUT HISTORY" }), _jsx(Text, { dimColor: true, children: " [\u2191/\u2193 Navigate \u2022 Enter Select \u2022 Esc Close]" }), " ]"] }), _jsx(Text, { color: "gray", dimColor: true, children: "\u2502  (no history yet)" }), _jsx(Text, { color: "yellow", children: "\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500" })] }));
    }
    // Determine visible window centered around selected index
    const total = uniqueHistory.length;
    const half = Math.floor(MAX_HISTORY_VISIBLE / 2);
    let startIdx = Math.max(0, historySelectedIndex - half);
    let endIdx = Math.min(total, startIdx + MAX_HISTORY_VISIBLE);
    // Adjust startIdx if endIdx hit the ceiling
    startIdx = Math.max(0, endIdx - MAX_HISTORY_VISIBLE);
    const visibleEntries = uniqueHistory.slice(startIdx, endIdx);
    const hiddenAbove = startIdx;
    const hiddenBelow = total - endIdx;
    const scrollInfo = total > MAX_HISTORY_VISIBLE
        ? ` [${historySelectedIndex + 1}/${total}]`
        : "";
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { bold: true, color: "yellow", children: ["\u250C\u2500\u2500\u2500 [ ", _jsx(Text, { bold: true, color: "yellow", children: "\uD83D\uDCDC INPUT HISTORY" }), scrollInfo && _jsx(Text, { color: "cyan", children: scrollInfo }), _jsx(Text, { dimColor: true, children: " [\u2191/\u2193 Navigate \u2022 Enter Select \u2022 Esc Close]" }), " ]"] }), hiddenAbove > 0 && (_jsxs(Text, { color: "gray", dimColor: true, children: ["\u2502  \u2191 ", hiddenAbove, " more above"] })), visibleEntries.map((entry, idx) => {
                const absoluteIdx = startIdx + idx;
                const isSelected = absoluteIdx === historySelectedIndex;
                const displayEntry = entry.length > 60 ? entry.slice(0, 57) + "..." : entry;
                return (_jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { color: isSelected ? "yellow" : "gray", children: isSelected ? "│ ❯ " : "│   " }), _jsx(Text, { color: isSelected ? "white" : "gray", bold: isSelected, dimColor: !isSelected, children: displayEntry })] }, absoluteIdx));
            }), hiddenBelow > 0 && (_jsxs(Text, { color: "gray", dimColor: true, children: ["\u2502  \u2193 ", hiddenBelow, " more below"] })), _jsx(Text, { color: "yellow", children: "\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500" })] }));
}
//# sourceMappingURL=history-panel.js.map