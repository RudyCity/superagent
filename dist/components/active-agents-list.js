import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from "ink";
import { superagentInstances, subagentInstances, backgroundTasks } from "../core/tools.js";
function getLatestSubagentAction(logs) {
    if (!logs || logs.length === 0)
        return "Initializing...";
    for (let i = logs.length - 1; i >= 0; i--) {
        const raw = logs[i].replace(/\r/g, "").trim();
        if (raw) {
            let clean = raw
                .replace(/^.*?───\[\s*/, "")
                .replace(/\s*\]$/, "")
                .replace(/^[│┌├└─\s]+/, "")
                .trim();
            clean = clean.replace(/^Description:\s*/i, "");
            clean = clean.replace(/^Args:\s*/i, "");
            if (clean) {
                return clean.length > 80 ? clean.slice(0, 80) + "..." : clean;
            }
        }
    }
    return "Processing...";
}
function getLatestSuperagentAction(logs) {
    if (!logs || logs.length === 0)
        return "Initializing...";
    for (let i = logs.length - 1; i >= 0; i--) {
        const raw = logs[i].replace(/\r/g, "").trim();
        if (raw) {
            let clean = raw
                .replace(/^\[THINK\]\s*/i, "")
                .replace(/^\[TOOL:START\]\s*/i, "")
                .replace(/^\[TOOL:SUCCESS\]\s*/i, "")
                .replace(/^\[TOOL:FAILED\]\s*/i, "")
                .replace(/^\[ERROR\]\s*/i, "")
                .replace(/^[│┌├└─\s]+/, "")
                .trim();
            if (clean) {
                return clean.length > 80 ? clean.slice(0, 80) + "..." : clean;
            }
        }
    }
    return "Processing...";
}
export function ActiveAgentsList({ focusMode, runningSuperagentsCount, runningSubagentsCount, runningTasksCount, superagentsScrollOffset, subagentsScrollOffset, procsScrollOffset, maxSuperagentsVisible, maxSubagentsVisible, maxProcsVisible, collapsedSections, }) {
    if (runningSuperagentsCount === 0 && runningSubagentsCount === 0 && runningTasksCount === 0) {
        return null;
    }
    const runningSuperagents = Array.from(superagentInstances.values()).filter((s) => s.status === "running");
    const runningSubagents = Array.from(subagentInstances.values()).filter((s) => s.status === "running");
    const runningProcs = Array.from(backgroundTasks.entries()).filter(([_, task]) => !task.hasExited);
    return (_jsxs(Box, { flexDirection: "column", marginBottom: 0, children: [runningSuperagentsCount > 0 && (() => {
                const totalSA = runningSuperagents.length;
                const isCollapsed = collapsedSections.superagents;
                const isFocused = focusMode === "superagents";
                const collapseIcon = isCollapsed ? "▶" : "▼";
                const headerColor = isFocused ? "green" : "cyan";
                if (isCollapsed) {
                    return (_jsx(Box, { flexDirection: "column", children: _jsxs(Text, { color: headerColor, bold: true, children: ["\u250C\u2500\u2500\u2500[ ", collapseIcon, " \u26A1 ACTIVE SUPERAGENTS (", totalSA, ") ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to expand" })] }) }));
                }
                const hasScroll = totalSA > maxSuperagentsVisible;
                const scrollIndicator = hasScroll
                    ? ` [Scroll: ${superagentsScrollOffset + 1}-${Math.min(totalSA, superagentsScrollOffset + maxSuperagentsVisible)}/${totalSA}]`
                    : "";
                const helpText = isFocused ? " [↑/▼ Scroll • Esc Exit]" : "";
                const visibleSA = runningSuperagents.slice(superagentsScrollOffset, superagentsScrollOffset + maxSuperagentsVisible);
                return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: headerColor, bold: true, children: ["\u250C\u2500\u2500\u2500[ ", collapseIcon, " \u26A1 ACTIVE SUPERAGENTS ]", scrollIndicator, helpText, " ", _jsx(Text, { dimColor: true, italic: true, children: "click header to collapse" })] }), visibleSA.map((inst) => (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "cyan", children: ["\u251C\u2500\u2500\u2500 [", inst.id, "] Role: ", inst.role, " (", inst.status, ")"] }), _jsxs(Text, { color: "cyan", children: ["\u2502    \u251C\u2500\u2500\u2500 Task: ", _jsx(Text, { color: "white", children: inst.task })] }), _jsxs(Text, { color: "cyan", children: ["\u2502    \u2514\u2500 Action: ", _jsx(Text, { italic: true, color: "white", children: getLatestSuperagentAction(inst.logs) })] })] }, inst.id)))] }));
            })(), runningSubagentsCount > 0 && (() => {
                const totalSubs = runningSubagents.length;
                const isCollapsed = collapsedSections.subagents;
                const isFocused = focusMode === "subagents";
                const collapseIcon = isCollapsed ? "▶" : "▼";
                const headerColor = isFocused ? "green" : "yellow";
                const isFirstHeader = runningSuperagentsCount === 0;
                const branchPrefix = isFirstHeader ? "┌───" : "├───";
                if (isCollapsed) {
                    return (_jsx(Box, { flexDirection: "column", marginTop: 0, children: _jsxs(Text, { color: headerColor, bold: true, children: [branchPrefix, "[ ", collapseIcon, " \uD83E\uDD16 ACTIVE SUBAGENTS (", totalSubs, ") ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to expand" })] }) }));
                }
                const hasScroll = totalSubs > maxSubagentsVisible;
                const scrollIndicator = hasScroll
                    ? ` [Scroll: ${subagentsScrollOffset + 1}-${Math.min(totalSubs, subagentsScrollOffset + maxSubagentsVisible)}/${totalSubs}]`
                    : "";
                const helpText = isFocused ? " [↑/▼ Scroll • Esc Exit]" : "";
                const visibleSubs = runningSubagents.slice(subagentsScrollOffset, subagentsScrollOffset + maxSubagentsVisible);
                return (_jsxs(Box, { flexDirection: "column", marginTop: 0, children: [_jsxs(Text, { color: headerColor, bold: true, children: [branchPrefix, "[ ", collapseIcon, " \uD83E\uDD16 ACTIVE SUBAGENTS ]", scrollIndicator, helpText, " ", _jsx(Text, { dimColor: true, italic: true, children: "click header to collapse" })] }), visibleSubs.map((inst, index) => {
                            const isLast = index === visibleSubs.length - 1;
                            const branchChar = isLast ? "└──" : "├──";
                            const action = getLatestSubagentAction(inst.logs);
                            return (_jsxs(Text, { color: "yellow", children: ["\u2502  ", branchChar, " Action: ", inst.id, ": ", _jsx(Text, { italic: true, color: "white", children: action }), " | Role: ", inst.role, " (", inst.status, ")"] }, inst.id));
                        })] }));
            })(), runningTasksCount > 0 && (() => {
                const totalProcs = runningProcs.length;
                const isCollapsed = collapsedSections.procs;
                const isFocused = focusMode === "procs";
                const collapseIcon = isCollapsed ? "▶" : "▼";
                const headerColor = isFocused ? "green" : "cyan";
                const isFirstHeader = runningSuperagentsCount === 0 && runningSubagentsCount === 0;
                const branchPrefix = isFirstHeader ? "┌───" : "├───";
                if (isCollapsed) {
                    return (_jsx(Box, { flexDirection: "column", marginTop: 0, children: _jsxs(Text, { color: headerColor, bold: true, children: [branchPrefix, "[ ", collapseIcon, " \u2699\uFE0F ACTIVE PROCESSES (", totalProcs, ") ] ", _jsx(Text, { dimColor: true, italic: true, children: "click to expand" })] }) }));
                }
                const hasScroll = totalProcs > maxProcsVisible;
                const scrollIndicator = hasScroll
                    ? ` [Scroll: ${procsScrollOffset + 1}-${Math.min(totalProcs, procsScrollOffset + maxProcsVisible)}/${totalProcs}]`
                    : "";
                const helpText = isFocused ? " [↑/▼ Scroll • Esc Exit]" : "";
                const visibleProcs = runningProcs.slice(procsScrollOffset, procsScrollOffset + maxProcsVisible);
                return (_jsxs(Box, { flexDirection: "column", marginTop: 0, children: [_jsxs(Text, { color: headerColor, bold: true, children: [branchPrefix, "[ ", collapseIcon, " \u2699\uFE0F ACTIVE PROCESSES ]", scrollIndicator, helpText, " ", _jsx(Text, { dimColor: true, italic: true, children: "click header to collapse" })] }), visibleProcs.map(([id, task]) => (_jsxs(Text, { color: "cyan", children: ["\u251C\u2500\u2500\u2500 [", id, "] Command: ", task.command] }, id)))] }));
            })()] }));
}
//# sourceMappingURL=active-agents-list.js.map