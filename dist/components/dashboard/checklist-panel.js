import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { Box, Text } from "ink";
import { unicodeStrikethrough } from "../../utils/text.js";
const MAX_HISTORY_VISIBLE = 3;
export function ChecklistPanel({ planState, checklistTasks, focusArea, checklistScrollOffset, maxChecklistVisible, agent, superagentInstances, completedHistory = [], }) {
    const hasActiveTasks = checklistTasks.length > 0;
    const hasHistory = completedHistory.length > 0;
    // Only show when plan is approved AND (there are active tasks OR completed history)
    if (planState !== "APPROVED" || (!hasActiveTasks && !hasHistory)) {
        return null;
    }
    const totalTasks = checklistTasks.length;
    const completedTasks = checklistTasks.filter((t) => t.status === "x").length;
    const hasScroll = totalTasks > maxChecklistVisible;
    const scrollIndicator = hasScroll
        ? ` [Scroll: ${checklistScrollOffset + 1}-${Math.min(totalTasks, checklistScrollOffset + maxChecklistVisible)}/${totalTasks}]`
        : "";
    const helpText = focusArea === "checklist" ? " [↑/▼ Scroll • Esc Exit]" : "";
    const visibleChecklist = checklistTasks.slice(checklistScrollOffset, checklistScrollOffset + maxChecklistVisible);
    // History: show the most recent completed tasks (capped)
    const historyToShow = completedHistory.slice(-MAX_HISTORY_VISIBLE);
    const hiddenHistoryCount = completedHistory.length - historyToShow.length;
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [hasActiveTasks && (_jsxs(_Fragment, { children: [_jsx(Box, { flexDirection: "row", justifyContent: "space-between", children: _jsxs(Text, { bold: true, color: focusArea === "checklist" ? "green" : "cyan", children: ["\uD83D\uDCCB ACTIVE TASK CHECKLIST (", completedTasks, "/", totalTasks, " completed)", scrollIndicator, helpText] }) }), visibleChecklist.map((task, index) => {
                        const idx = checklistScrollOffset + index;
                        let status = task.status;
                        let statusIcon = "○";
                        let taskColor = "white";
                        let connectorColor = "gray";
                        let displayStatusText = "";
                        // Dynamic status override in multi-agent mode based on active superagents
                        if (agent && agent.isMultiAgent) {
                            for (const inst of superagentInstances.values()) {
                                const roleLower = inst.role.toLowerCase();
                                if (task.text.toLowerCase().includes(roleLower)) {
                                    const isMergeOrCleanup = /merge|cleanup|prune/i.test(task.text);
                                    if (!isMergeOrCleanup) {
                                        if (inst.status === "running") {
                                            status = "/";
                                        }
                                        else if (inst.status === "paused") {
                                            status = "paused";
                                        }
                                        else if (inst.status === "completed") {
                                            status = "x";
                                        }
                                        else if (inst.status === "error") {
                                            status = "error";
                                        }
                                    }
                                    else {
                                        if (inst.status === "completed") {
                                            status = "/";
                                        }
                                    }
                                    break;
                                }
                            }
                        }
                        if (status === "x") {
                            statusIcon = "◉";
                            taskColor = "gray";
                            connectorColor = "green";
                        }
                        else if (status === "/") {
                            statusIcon = "●";
                            taskColor = "yellow";
                            connectorColor = "yellow";
                            displayStatusText = " (in progress)";
                        }
                        else if (status === "paused") {
                            statusIcon = "⏸";
                            taskColor = "magenta";
                            connectorColor = "magenta";
                            displayStatusText = " (paused)";
                        }
                        else if (status === "error") {
                            statusIcon = "✗";
                            taskColor = "red";
                            connectorColor = "red";
                            displayStatusText = " (failed)";
                        }
                        const connector = "├──";
                        const displayText = status === "x"
                            ? unicodeStrikethrough(task.text)
                            : task.text;
                        return (_jsxs(Box, { flexDirection: "row", children: [_jsxs(Text, { color: connectorColor, children: [connector, " "] }), _jsxs(Text, { color: connectorColor, children: [statusIcon, " "] }), _jsxs(Text, { color: taskColor, children: [displayText, displayStatusText] })] }, idx));
                    })] })), hasHistory && (_jsxs(_Fragment, { children: [_jsx(Box, { flexDirection: "row", marginBottom: 0, children: _jsxs(Text, { bold: true, color: "gray", dimColor: true, children: ["\u2713 PREVIOUSLY COMPLETED (", completedHistory.length, " tasks)"] }) }), hiddenHistoryCount > 0 && (_jsx(Box, { flexDirection: "row", children: _jsxs(Text, { color: "gray", dimColor: true, children: ["  ", "\u2026 +", hiddenHistoryCount, " more in history"] }) })), historyToShow.map((task, index) => {
                        const connector = "├──";
                        return (_jsxs(Box, { flexDirection: "row", children: [_jsxs(Text, { color: "gray", dimColor: true, children: [connector, " "] }), _jsx(Text, { color: "gray", dimColor: true, children: "\u25C9 " }), _jsx(Text, { color: "gray", dimColor: true, children: unicodeStrikethrough(task.text) })] }, `hist-${index}`));
                    })] }))] }));
}
//# sourceMappingURL=checklist-panel.js.map