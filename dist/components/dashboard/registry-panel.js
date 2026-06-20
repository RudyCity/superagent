import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from "react";
import { Box, Text } from "ink";
function stripAnsi(str) {
    return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}
// Active status badge with blinking effect
export function ActiveStatusBadge() {
    const [activeBlink, setActiveBlink] = useState(true);
    useEffect(() => {
        const timer = setInterval(() => {
            setActiveBlink((prev) => !prev);
        }, 600);
        return () => clearInterval(timer);
    }, []);
    return activeBlink ? (_jsx(Text, { color: "black", backgroundColor: "yellow", bold: true, children: "\u25CF ACTIVE" })) : (_jsx(Text, { color: "yellow", bold: true, children: "  ACTIVE" }));
}
export function SessionSpinner() {
    const [frame, setFrame] = useState(0);
    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    useEffect(() => {
        const timer = setInterval(() => {
            setFrame((prev) => (prev + 1) % spinnerFrames.length);
        }, 120);
        return () => clearInterval(timer);
    }, []);
    return _jsxs(Text, { color: "yellow", bold: true, children: [spinnerFrames[frame], " "] });
}
export function renderStatusBadge(status) {
    if (status === "WORKING") {
        return _jsx(ActiveStatusBadge, {});
    }
    if (status === "PAUSED")
        return _jsx(Text, { color: "black", backgroundColor: "magenta", bold: true, children: " PAUSE " });
    if (status === "COMPLETED")
        return _jsx(Text, { color: "black", backgroundColor: "green", bold: true, children: " DONE " });
    if (status === "ERROR")
        return _jsx(Text, { color: "black", backgroundColor: "red", bold: true, children: " FAIL " });
    return _jsx(Text, { color: "black", backgroundColor: "gray", bold: true, children: " IDLE " });
}
export const tierIcon = {
    MASTER: "👑",
    SUPERAGENT: "⚡",
    SUBAGENT: "🔍",
    TASK: "⚙",
};
export const tierColor = {
    MASTER: "magenta",
    SUPERAGENT: "cyan",
    SUBAGENT: "yellow",
    TASK: "gray",
};
export function RegistryPanel({ sessions, selectedIndex, focusArea, startIdx, visibleSessions, getLatestSuperagentAction, getLatestSubagentAction, leftTopHeight, }) {
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, height: leftTopHeight, marginBottom: 1, children: [_jsxs(Box, { flexDirection: "row", justifyContent: "space-between", marginBottom: 1, children: [_jsxs(Text, { bold: true, color: focusArea === "list" ? "green" : "cyan", children: ["\uD83D\uDCE1 WORKSPACE REGISTRY | ", sessions.length, " threads"] }), focusArea === "list" && (_jsx(Text, { color: "gray", dimColor: true, children: " [\u2191/\u25BC Navigate \u2022 Enter Inspect]" }))] }), sessions.length === 0 ? (_jsx(Box, { flexDirection: "row", marginTop: 0, children: _jsx(Text, { color: "gray", dimColor: true, children: "No active agent threads detected" }) })) : (visibleSessions.map((session, index) => {
                const globalIndex = startIdx + index;
                const isSelected = globalIndex === selectedIndex;
                const color = isSelected ? (focusArea === "list" ? "green" : "cyan") : tierColor[session.type];
                const isFocused = focusArea === "list";
                const rowBg = isSelected && isFocused ? "green" : undefined;
                const rowTextColor = isSelected && isFocused ? "white" : color;
                const tokenColor = isSelected && isFocused ? "white" : "cyan";
                const getDepth = (s) => {
                    return s.type === "MASTER" ? 0
                        : s.type === "SUPERAGENT" ? 1
                            : s.type === "TASK" ? 1
                                : (s.parentId === "master" ? 1 : 2);
                };
                const hasMoreSiblings = (idx, d) => {
                    for (let i = idx + 1; i < sessions.length; i++) {
                        const s = sessions[i];
                        const sDepth = getDepth(s);
                        if (sDepth < d) {
                            break;
                        }
                        if (sDepth === d) {
                            return true;
                        }
                    }
                    return false;
                };
                const depth = getDepth(session);
                let prefix = "";
                if (depth === 0) {
                    prefix = `${tierIcon[session.type]} `;
                }
                else if (depth === 1) {
                    const hasMore = hasMoreSiblings(globalIndex, 1);
                    prefix = (hasMore ? "├── " : "└── ") + `${tierIcon[session.type]} `;
                }
                else if (depth === 2) {
                    let parentIndex = -1;
                    const parentId = session.parentId;
                    for (let i = globalIndex - 1; i >= 0; i--) {
                        const s = sessions[i];
                        if (s.type === "SUPERAGENT" && s.id.endsWith(parentId || "")) {
                            parentIndex = i;
                            break;
                        }
                    }
                    const parentHasMore = parentIndex !== -1 && hasMoreSiblings(parentIndex, 1);
                    const level1 = parentHasMore ? "│   " : "    ";
                    const hasMore = hasMoreSiblings(globalIndex, 2);
                    const level2 = hasMore ? "├── " : "└── ";
                    prefix = level1 + level2 + `${tierIcon[session.type]} `;
                }
                let label = "";
                if (session.type === "MASTER") {
                    label = `master ❯ ${session.task}`;
                }
                else if (session.type === "SUPERAGENT") {
                    const action = getLatestSuperagentAction(session.logs);
                    const role = session.id.split("-")[1] || "superagent";
                    label = `${role} ❯ ${action}`;
                }
                else if (session.type === "SUBAGENT") {
                    const action = getLatestSubagentAction(session.logs);
                    const name = session.id.split("-")[0];
                    label = `${name} ❯ ${action}`;
                }
                else {
                    label = `${session.id.slice(0, 14)}`;
                }
                if (isSelected && isFocused) {
                    label = stripAnsi(label);
                }
                const isActive = session.status === "WORKING";
                const isSpinner = !isSelected && isActive;
                const indicatorColor = isSelected
                    ? (focusArea === "list" ? "green" : "cyan")
                    : (isActive ? "yellow" : "gray");
                return (_jsxs(Box, { flexDirection: "row", justifyContent: "space-between", marginTop: 0, children: [_jsxs(Box, { flexDirection: "row", flexShrink: 1, children: [_jsx(Text, { bold: isSelected, color: indicatorColor, children: isSelected ? "▶ " : (isSpinner ? _jsx(SessionSpinner, {}) : "  ") }), _jsxs(Text, { bold: isSelected, backgroundColor: rowBg, wrap: "truncate-end", children: [_jsxs(Text, { color: isSelected && isFocused ? "white" : "gray", dimColor: !isSelected || !isFocused, children: ["[", String(globalIndex + 1).padStart(2, " "), "]", " "] }), _jsxs(Text, { color: rowTextColor, children: [prefix, label] })] })] }), _jsxs(Box, { flexShrink: 0, children: [renderStatusBadge(session.status), session.speed !== undefined && session.speed > 0 && (_jsxs(Text, { color: isSelected && isFocused ? "white" : "yellow", backgroundColor: rowBg, bold: true, children: [" \u26A1", session.speed.toFixed(1), "t/s"] })), session.tokens > 0
                                    ? _jsxs(Text, { color: tokenColor, backgroundColor: rowBg, dimColor: !isSelected || !isFocused, children: [" ", session.tokens.toLocaleString(), "t"] })
                                    : _jsx(Text, { color: isSelected && isFocused ? "white" : "gray", backgroundColor: rowBg, dimColor: true, children: " --" })] })] }, session.id));
            }))] }));
}
//# sourceMappingURL=registry-panel.js.map