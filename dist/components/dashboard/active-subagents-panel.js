import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { Box, Text } from "ink";
export function ActiveSubagentsPanel({ subagentInstances, agentsScrollOffset, maxAgentsVisible, focusArea, getLatestSubagentAction, }) {
    const runningAgents = Array.from(subagentInstances.values()).filter((s) => s.status === "running");
    if (runningAgents.length === 0) {
        return null;
    }
    const totalAgents = runningAgents.length;
    const hasScroll = totalAgents > maxAgentsVisible;
    const scrollIndicator = hasScroll
        ? ` [Scroll: ${agentsScrollOffset + 1}-${Math.min(totalAgents, agentsScrollOffset + maxAgentsVisible)}/${totalAgents}]`
        : "";
    const helpText = focusArea === "agents" ? " [↑/▼ Scroll • Esc Exit]" : "";
    const visibleAgents = runningAgents.slice(agentsScrollOffset, agentsScrollOffset + maxAgentsVisible);
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: focusArea === "agents" ? "green" : "yellow", bold: true, children: ["\u250C\u2500\u2500\u2500[ \uD83E\uDD16 ACTIVE SUBAGENTS ]", scrollIndicator, helpText] }), visibleAgents.map((inst, index) => {
                const isLast = index === visibleAgents.length - 1;
                const branchChar = isLast ? "└──" : "├──";
                const action = getLatestSubagentAction(inst.logs);
                return (_jsxs(Text, { color: "yellow", children: ["\u2502  ", branchChar, " Action: ", inst.id, ": ", _jsx(Text, { italic: true, color: "white", children: action }), " | Role: ", inst.role, " (", inst.status, ")"] }, inst.id));
            })] }));
}
//# sourceMappingURL=active-subagents-panel.js.map