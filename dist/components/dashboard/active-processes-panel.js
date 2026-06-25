import { jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from "ink";
export function ActiveProcessesPanel({ backgroundTasks, procsScrollOffset, maxProcsVisible, focusArea, runningSubagentsCount, }) {
    const runningProcs = Array.from(backgroundTasks.entries()).filter(([id, task]) => !task.hasExited);
    if (runningProcs.length === 0) {
        return null;
    }
    const totalProcs = runningProcs.length;
    const hasScroll = totalProcs > maxProcsVisible;
    const scrollIndicator = hasScroll
        ? ` [Scroll: ${procsScrollOffset + 1}-${Math.min(totalProcs, procsScrollOffset + maxProcsVisible)}/${totalProcs}]`
        : "";
    const helpText = focusArea === "procs" ? " [↑/▼ Scroll • Esc Exit]" : "";
    const visibleProcs = runningProcs.slice(procsScrollOffset, procsScrollOffset + maxProcsVisible);
    const isFirstHeader = runningSubagentsCount === 0;
    return (_jsxs(Box, { flexDirection: "column", marginTop: 0, children: [_jsxs(Text, { color: focusArea === "procs" ? "green" : "cyan", bold: true, children: [isFirstHeader ? "┌───" : "├───", "[ \u2699\uFE0F ACTIVE PROCESSES ]", scrollIndicator, helpText] }), visibleProcs.map(([id, task]) => (_jsxs(Text, { color: "cyan", children: ["\u251C\u2500\u2500\u2500 [", id, "] Command: ", task.command] }, id)))] }));
}
//# sourceMappingURL=active-processes-panel.js.map